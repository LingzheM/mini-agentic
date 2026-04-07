/**
 * ═══════════════════════════════════════════════════════════
 *  context-manager.ts — "记忆管家"：管理有限的上下文窗口
 * ═══════════════════════════════════════════════════════════
 *
 *  Phase 6 核心问题：LLM 的脑容量是有限的。
 *
 *  每个 LLM 都有一个 context window 上限：
 *    - qwen2.5:7b ≈ 32K tokens
 *    - llama3.1:8b ≈ 128K tokens
 *    - Claude Sonnet ≈ 200K tokens
 *
 *  你的 conversationHistory 里每条消息都在消耗 token。
 *  一个真实编码会话——读 5 个文件、跑 10 个命令——
 *  15 轮对话就可能撑满 32K。
 *
 *  撑满后会怎样？
 *    - 有的模型直接报错 (400: context length exceeded)
 *    - 有的模型悄悄丢弃早期内容
 *    - 有的模型开始胡言乱语
 *  每一种都很糟糕。
 *
 *  这个文件的策略：
 *
 *  1. 估算 token 数（不需要精确，粗略就行）
 *  2. 当接近上限的 85% 时，触发压缩：
 *     a. 保留 system prompt（第一条，永远不动）
 *     b. 保留最近 N 轮对话（最后几条）
 *     c. 中间的旧消息 → 替换成一条摘要
 *  3. 工具结果在记录时就做预截断（最大的 token 消耗者）
 */

import type { Message } from "./llm.js";

// ──────────────────────────────────────────────
// 配置
// ──────────────────────────────────────────────

/** 上下文窗口上限（token 数）。可通过环境变量覆盖。 */
const MAX_CONTEXT_TOKENS = parseInt(
  process.env.MAX_CONTEXT_TOKENS ?? "32000",
  10
);

/** 当 token 使用率达到这个比例时触发压缩 */
const COMPACT_THRESHOLD = 0.85;

/** 压缩时保留最近多少条消息不动 */
const KEEP_RECENT_MESSAGES = 6;

/** 单个工具结果的最大字符数（超出截断） */
const MAX_TOOL_RESULT_CHARS = 8000;

// ──────────────────────────────────────────────
// Token 估算
// ──────────────────────────────────────────────
//
// 精确的 token 计数需要模型的 tokenizer（tiktoken 等）。
// 但对于"要不要压缩"这个决策，粗略估算就够了。
//
// 经验法则：
//   - 英文：1 token ≈ 4 个字符
//   - 中文：1 token ≈ 1.5 个字符（每个汉字通常 2-3 token）
//   - 代码：1 token ≈ 3.5 个字符（关键字短，变量名长）
//
// 我们用一个混合估算：检测中文占比，动态调整比例。
// 不完美，但比固定除以 4 好得多。

/** 估算一段文本的 token 数 */
export function estimateTokens(text: string): number {
  if (!text) return 0;

  // 检测中文字符占比
  const cjkChars = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]/g)?.length ?? 0;
  const totalChars = text.length;
  const cjkRatio = totalChars > 0 ? cjkChars / totalChars : 0;

  // 混合比例：中文越多，每个字符消耗的 token 越多
  const charsPerToken = 4 - cjkRatio * 2.5; // 纯英文=4, 纯中文=1.5

  return Math.ceil(totalChars / charsPerToken);
}

/** 估算整个消息数组的 token 数 */
export function estimateHistoryTokens(messages: Message[]): number {
  let total = 0;
  for (const msg of messages) {
    // 每条消息有 ~4 token 的结构开销（role, 分隔符等）
    total += 4;

    if (msg.content) {
      total += estimateTokens(msg.content);
    }

    // assistant 消息可能有 tool_calls
    if (msg.role === "assistant" && msg.tool_calls) {
      for (const tc of msg.tool_calls) {
        total += estimateTokens(tc.function.name);
        total += estimateTokens(tc.function.arguments);
        total += 10; // 结构开销
      }
    }
  }
  return total;
}

// ──────────────────────────────────────────────
// 工具结果预截断
// ──────────────────────────────────────────────
//
// 工具结果是最大的 token 消耗者。
// 一次 read_file 读取 500 行 = 几千 token。
// 一次 run_command 输出 npm install 的日志 = 几千 token。
//
// 我们在记录到 conversationHistory 之前就做截断，
// 而不是等到压缩时再处理。这叫"预截断"。
//
// 关键设计：截断后要告诉 LLM "这个结果被截断了"，
// 这样它知道如果需要完整内容，可以再读一次或用 grep。

/** 如果工具结果超长，截断并标注 */
export function truncateToolResult(result: string): string {
  if (result.length <= MAX_TOOL_RESULT_CHARS) return result;

  // 保留开头和结尾——LLM 通常需要看文件的头和尾
  const headSize = Math.floor(MAX_TOOL_RESULT_CHARS * 0.7);
  const tailSize = Math.floor(MAX_TOOL_RESULT_CHARS * 0.2);

  const head = result.slice(0, headSize);
  const tail = result.slice(-tailSize);
  const omitted = result.length - headSize - tailSize;

  return (
    head +
    `\n\n... [${omitted} characters omitted — use grep_search or read specific sections if needed] ...\n\n` +
    tail
  );
}

// ──────────────────────────────────────────────
// 上下文压缩
// ──────────────────────────────────────────────
//
// 当 token 接近上限时，我们需要"腾出空间"。
// 策略：
//
//   messages[0]  = system prompt  → 永远保留
//   messages[1..N-K] = 旧消息    → 替换成一条摘要
//   messages[N-K..N] = 最近 K 条 → 永远保留
//
// 摘要怎么写？两种方式：
//   A. 简单版：把旧消息的关键内容拼成一段文字（我们先用这个）
//   B. 高级版：调用 LLM 生成摘要（clio 的 compact.ts 用这个）
//
// 我们先做 A，因为 B 需要一次额外的 API 调用（费 token、费时间）。
// 后续可以升级到 B。

/** 检查是否需要压缩，如果需要则执行 */
export function compactIfNeeded(messages: Message[]): {
  compacted: boolean;
  tokensBefore: number;
  tokensAfter: number;
} {
  const tokensBefore = estimateHistoryTokens(messages);
  const threshold = MAX_CONTEXT_TOKENS * COMPACT_THRESHOLD;

  if (tokensBefore < threshold) {
    return { compacted: false, tokensBefore, tokensAfter: tokensBefore };
  }

  // ── 需要压缩 ──

  // 永远保留 system prompt（index 0）
  const systemMessage = messages[0];

  // 保留最近 K 条消息
  const recentStart = Math.max(1, messages.length - KEEP_RECENT_MESSAGES);
  const recentMessages = messages.slice(recentStart);

  // 要压缩的是中间部分
  const middleMessages = messages.slice(1, recentStart);

  if (middleMessages.length === 0) {
    // 没有中间消息可压缩——已经很短了，但还是超了
    // 这意味着 system prompt + 最近几条就已经很大
    // 尝试截断最近消息中的大 tool 结果
    for (const msg of recentMessages) {
      if (msg.role === "tool" && msg.content.length > 2000) {
        msg.content =
          msg.content.slice(0, 1000) +
          "\n... [compacted — original result truncated to save context space]";
      }
    }
    const tokensAfter = estimateHistoryTokens([systemMessage, ...recentMessages]);
    // 就地修改 messages 数组
    messages.length = 0;
    messages.push(systemMessage, ...recentMessages);
    return { compacted: true, tokensBefore, tokensAfter };
  }

  // ── 构建摘要 ──
  //
  // 从中间消息里提取关键信息：
  //   - 用户问了什么
  //   - 用了哪些工具
  //   - 修改了哪些文件
  //   - 最终结论是什么
  const summary = buildSummary(middleMessages);

  // 替换中间消息为一条摘要
  const summaryMessage: Message = {
    role: "user",
    content:
      "[CONTEXT SUMMARY — Earlier conversation was compacted to save space]\n" +
      summary +
      "\n[END SUMMARY — Recent messages follow]",
  };

  // 就地修改 messages 数组
  messages.length = 0;
  messages.push(systemMessage, summaryMessage, ...recentMessages);

  const tokensAfter = estimateHistoryTokens(messages);
  return { compacted: true, tokensBefore, tokensAfter };
}

/**
 * 从一组消息中提取摘要。
 *
 * 这是"简单版"摘要——纯字符串处理，不调用 LLM。
 * 提取：用户的问题、使用的工具、涉及的文件路径、助手的结论。
 */
function buildSummary(messages: Message[]): string {
  const userQuestions: string[] = [];
  const toolsUsed: string[] = [];
  const filesInvolved = new Set<string>();
  let lastAssistantReply = "";

  for (const msg of messages) {
    if (msg.role === "user") {
      // 只保留用户问题的前 100 字符
      const preview = msg.content.slice(0, 100);
      userQuestions.push(preview + (msg.content.length > 100 ? "…" : ""));
    }

    if (msg.role === "assistant") {
      // 记录助手的最后一条回复
      if (msg.content) {
        lastAssistantReply = msg.content.slice(0, 200);
      }

      // 提取工具调用信息
      if (msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          toolsUsed.push(tc.function.name);

          // 从参数中提取文件路径
          try {
            const args = JSON.parse(tc.function.arguments);
            if (args.path) filesInvolved.add(args.path);
          } catch {
            // 忽略解析失败
          }
        }
      }
    }
  }

  const parts: string[] = [];

  if (userQuestions.length > 0) {
    parts.push(`User asked: ${userQuestions.join(" → ")}`);
  }
  if (toolsUsed.length > 0) {
    parts.push(`Tools used: ${toolsUsed.join(", ")}`);
  }
  if (filesInvolved.size > 0) {
    parts.push(`Files involved: ${Array.from(filesInvolved).join(", ")}`);
  }
  if (lastAssistantReply) {
    parts.push(`Last response: ${lastAssistantReply}`);
  }

  return parts.join("\n");
}

// ──────────────────────────────────────────────
// 导出配置（给 UI 显示用）
// ──────────────────────────────────────────────

export function getContextConfig() {
  return {
    maxTokens: MAX_CONTEXT_TOKENS,
    compactThreshold: COMPACT_THRESHOLD,
    keepRecent: KEEP_RECENT_MESSAGES,
  };
}