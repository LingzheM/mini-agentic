/**
 * ═══════════════════════════════════════════════════════════
 *  main.ts — "大脑"：Agent 循环
 * ═══════════════════════════════════════════════════════════
 *
 *  这是整个项目最重要的文件。
 *
 *  所有 AI Agent（Claude Code、Cursor、Copilot Workspace……）
 *  的核心都是同一个循环：
 *
 *    ┌──→ 用户输入
 *    │       ↓
 *    │    发给 LLM（带上工具定义）
 *    │       ↓
 *    │    LLM 回复
 *    │       ↓
 *    │    是工具调用？──→ 是 ──→ 执行工具 ──→ 把结果加入对话 ──┐
 *    │       ↓                                                  │
 *    │      否（纯文本）                                        │
 *    │       ↓                                                  │
 *    │    打印给用户看                                          │
 *    └──← 等待下一次输入      ←─────────────── 继续对话 ←──────┘
 *
 *  这个循环就是 "Agent Loop"。
 *  你学会了它，就学会了所有 AI Agent 的骨架。
 */

import * as readline from "readline";
import { chat, chatStream, setVerbose, getModelName, getBaseUrl, type Message } from "./llm.js";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";
import { checkPermission, setTrustMode } from "./permissions.js";

// ──────────────────────────────────────────────
// ANSI 颜色（零依赖的终端美化）
// ──────────────────────────────────────────────
const c = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  red: "\x1b[31m",
  magenta: "\x1b[35m",
};

// ──────────────────────────────────────────────
// System Prompt — AI 的"元人格"
// ──────────────────────────────────────────────
//
// 这是你能控制 AI 行为的最强杠杆。
// 注意几个设计要点：
//   1. 明确角色（"You are a coding assistant"）
//   2. 明确行为规则（先解释，再行动）
//   3. 明确限制（不修改 system 文件）
//
// 试试修改这个 prompt，看 AI 行为怎么变化！

const SYSTEM_PROMPT = `You are Mini Claude Code, a coding assistant that runs in the user's terminal.
You have access to tools that let you read files, write files, search code, and run shell commands.

WORKING DIRECTORY: ${process.cwd()}
All relative paths resolve from this directory. When the user asks to create a file without specifying a path, create it here.

PERMISSIONS:
- Read tools (read_file, grep_search) execute automatically.
- Write tools (write_file, search_and_replace) require user approval before executing.
- Exec tools (run_command) always require user approval.
- If the user denies a tool call, do NOT retry it. Ask the user what they'd prefer instead.

TOOL SELECTION:
- To understand a codebase: start with grep_search to find relevant code, then read_file on specific files.
- To edit existing files: use search_and_replace with the exact text to find and its replacement.
  Only use write_file for creating NEW files or when you need to rewrite an entire file from scratch.
- To run tests, install packages, or check status: use run_command.

RULES:
1. Before using a tool, briefly explain what you're about to do and why.
2. After a tool returns results, summarize what happened.
3. If a task needs multiple steps, work through them one at a time.
4. When writing code, follow best practices for the language.
5. Never run destructive commands (rm -rf /, etc.) without explicit confirmation.
6. Keep responses concise. You're in a terminal, not a chat UI.
7. Always respond in the same language the user uses.
8. When search_and_replace fails because old_text wasn't found, read the file first to see the actual content, then retry with the correct text.`;

// ──────────────────────────────────────────────
// 对话历史
// ──────────────────────────────────────────────
//
// 这就是 LLM 的"记忆"。每次调用 API 都会发送完整的
// 对话历史。LLM 本身是无状态的——它不记得上一次调用。
// 是我们的代码在维护这个记忆。

const conversationHistory: Message[] = [
  { role: "system", content: SYSTEM_PROMPT },
];

// ──────────────────────────────────────────────
// Phase 1 新增：Agent Loop 安全限制
// ──────────────────────────────────────────────
//
// 为什么需要断路器？
// 想象这个场景：LLM 调用 read_file → 看到结果 → 决定再读另一个文件
// → 看到结果 → 又要读另一个…… 如果 LLM "糊涂"了，
// 这个循环可能永远不停。
//
// 断路器说：超过 N 次工具调用，强制停下来，问用户怎么办。
// 20 次对于大多数任务已经很充裕了（读几个文件、改几个文件、跑测试）。

const MAX_TOOL_CALLS_PER_TURN = 20;

// ──────────────────────────────────────────────
// Agent Loop — 整个项目的核心（Phase 1 加固版）
// ──────────────────────────────────────────────

/**
 * 处理一次用户输入，可能触发多轮工具调用。
 *
 * Phase 1 改动：
 * - 加了循环断路器（MAX_TOOL_CALLS_PER_TURN）
 * - 处理 LLM 返回空回复的情况
 * - 工具调用解析错误不再 crash，而是喂回给 LLM 让它自己修正
 * - 整个 Agent Loop 的错误不会污染对话历史
 */
async function handleUserInput(userMessage: string): Promise<void> {
  // 1. 把用户消息加入历史
  conversationHistory.push({ role: "user", content: userMessage });

  // Phase 1 新增：记录本轮工具调用次数
  let toolCallCount = 0;

  // 2. 进入 Agent Loop
  while (true) {
    // ── Phase 1 新增：断路器检查 ──
    //
    // 如果已经调用了太多次工具，强制停下来。
    // 关键：我们不是直接 crash，而是把"你调用太多次了"
    // 作为一条用户消息喂给 LLM，让它自己总结并停止。
    if (toolCallCount >= MAX_TOOL_CALLS_PER_TURN) {
      console.log(
        `\n${c.yellow}⚠ Circuit breaker: ${toolCallCount} tool calls reached.${c.reset}`
      );
      console.log(
        `${c.dim}  Asking LLM to wrap up...${c.reset}`
      );
      conversationHistory.push({
        role: "user",
        content:
          "[SYSTEM] You have used too many tool calls in this turn. " +
          "Please summarize what you've done so far and what remains. " +
          "Do NOT call any more tools.",
      });
      // 不 break——让 LLM 看到这条消息后自己回复纯文本
      // 但把 tools 设为空数组，防止它继续调用
      const wrapUpResponse = await chat(conversationHistory, []);
      if (wrapUpResponse.content) {
        conversationHistory.push({
          role: "assistant",
          content: wrapUpResponse.content,
        });
        console.log(`\n${c.cyan}${wrapUpResponse.content}${c.reset}`);
      }
      break;
    }

    // 2a. 调用 LLM（Phase 2: 流式输出）
    //
    // Phase 0/1: chat() → 等全部生成完 → 一次性打印
    // Phase 2:   chatStream() → 每个 token 到达 → 立刻打印
    //
    // onToken 回调：LLM 每生成一个 token 就调用一次。
    // 我们用 process.stdout.write 而不是 console.log，
    // 因为 console.log 会自动加换行，而我们需要逐字追加。
    let response;
    let streamedContent = false; // 是否已经开始打印流式文本
    try {
      response = await chatStream(
        conversationHistory,
        TOOL_DEFINITIONS,
        (token: string) => {
          // 第一个 token 到达时，打印颜色前缀
          if (!streamedContent) {
            process.stdout.write(`\n${c.cyan}`);
            streamedContent = true;
          }
          process.stdout.write(token);
        }
      );
      // 流式文本结束后，关闭颜色并换行
      if (streamedContent) {
        process.stdout.write(`${c.reset}\n`);
      }
    } catch (err) {
      // Phase 1 新增：API 调用失败时的恢复策略
      //
      // 旧代码：错误直接抛到最外层，用户只看到一个红色错误。
      // 新代码：如果是在工具调用循环中间失败的，
      //         我们保持对话历史一致，告诉用户出了什么问题，
      //         但不丢弃已经做过的工作。
      console.error(
        `\n${c.red}✗ LLM call failed: ${(err as Error).message}${c.reset}`
      );
      // 从历史中移除最后的未完成状态（如果有）
      // 让对话历史停在最后一个完整状态
      break;
    }

    // 2b. 检查 LLM 是否想调用工具
    if (response.toolCalls.length > 0) {
      // 记录 LLM 的回复（包含 tool_calls）
      conversationHistory.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.toolCalls,
      });

      // Phase 2 注意：如果 LLM 在工具调用之前说了话，
      // streaming 已经通过 onToken 实时打印了，这里不需要再打印。

      // 逐个执行工具
      for (const toolCall of response.toolCalls) {
        const toolName = toolCall.function.name;
        const toolArgs = toolCall.function.arguments;
        toolCallCount++;

        // 显示正在做什么
        console.log(
          `\n${c.yellow}⚡ Tool [${toolCallCount}/${MAX_TOOL_CALLS_PER_TURN}]: ${c.bold}${toolName}${c.reset}`
        );
        console.log(`${c.dim}   Args: ${toolArgs}${c.reset}`);

        // ── Phase 4 新增：权限检查 ──
        //
        // 在 LLM 的"决定"和真正的"执行"之间插入一道关卡。
        // checkPermission 会根据工具的风险等级决定：
        //   - read 工具 → 自动通过
        //   - write/exec 工具 → 询问用户 [y/n]
        //
        // 如果用户拒绝了怎么办？
        // 我们不是直接跳过——那样 LLM 会困惑（它期待一个工具结果）。
        // 我们把"用户拒绝了"作为工具结果喂回给 LLM，
        // 让它知道这条路走不通，自己想别的办法。
        // 这和 Phase 1 的"错误消息喂回 LLM"是同一个模式。
        const allowed = await checkPermission(toolName, toolArgs);

        if (!allowed) {
          console.log(`${c.red}   ✗ Denied by user${c.reset}`);

          // 把拒绝结果喂给 LLM——让它知道要换个方案
          conversationHistory.push({
            role: "tool",
            tool_call_id: toolCall.id,
            content:
              `The user denied permission to execute "${toolName}". ` +
              `Do NOT retry the same operation. ` +
              `Either explain what you wanted to do and ask the user for guidance, ` +
              `or try an alternative approach.`,
          });
          continue; // 跳过执行，处理下一个 tool call
        }

        // 执行！（用户已确认或自动通过）
        const result = await executeTool(toolName, toolArgs);

        // 显示结果（截断过长的输出）
        const preview =
          result.length > 500
            ? result.slice(0, 500) + `\n... (${result.length} chars total)`
            : result;
        console.log(`${c.dim}   Result: ${preview}${c.reset}`);

        // 把工具结果加入历史
        conversationHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      // 继续循环，让 LLM 处理工具结果
      continue;
    }

    // ── Phase 1 新增：处理"空回复" ──
    //
    // 有时候 LLM 返回既没有 content 也没有 tool_calls 的空回复。
    // 旧代码：静默，然后 break，用户什么都看不到。
    // 新代码：告诉用户发生了什么，然后优雅退出。
    if (!response.content && response.toolCalls.length === 0) {
      console.log(
        `\n${c.dim}(LLM returned an empty response — this sometimes happens. Try rephrasing.)${c.reset}`
      );
      break;
    }

    // ──── 纯文本回复分支 ────
    // Phase 2：文字已经通过 streaming 实时打印了，
    // 这里只需要记入历史，不需要再 console.log。
    if (response.content) {
      conversationHistory.push({
        role: "assistant",
        content: response.content,
      });
    }

    // 跳出 Agent Loop，等待用户下一次输入
    break;
  }
}

// ──────────────────────────────────────────────
// REPL（交互式输入循环）
// ──────────────────────────────────────────────

async function main(): Promise<void> {
  // 处理命令行标志
  if (process.argv.includes("--verbose")) {
    setVerbose(true);
    console.log(`${c.dim}(verbose mode: showing raw JSON)${c.reset}\n`);
  }

  // Phase 4 新增：信任模式
  //
  // --trust 跳过所有权限确认。
  // 类似 Claude Code 的 --dangerously-skip-permissions。
  // 名字故意简短——用的人知道自己在做什么。
  const isTrustMode = process.argv.includes("--trust");
  if (isTrustMode) {
    setTrustMode(true);
    console.log(
      `${c.yellow}⚠ Trust mode: all tool calls will execute without confirmation${c.reset}\n`
    );
  }

  // 启动画面
  console.log(`
${c.cyan}${c.bold}╔══════════════════════════════════════╗
║        🤖 Mini Claude Code          ║
║    Phase 4: Human in the Loop       ║
╚══════════════════════════════════════╝${c.reset}

${c.dim}Model:    ${getModelName()}
Ollama:   ${getBaseUrl()}
Tools:    read_file, write_file, search_and_replace, grep_search, run_command
Stream:   ON (tokens print as they arrive)
Perms:    ${isTrustMode ? "TRUST MODE (all auto-approved)" : "ON (write/exec tools require approval)"}
Verbose:  ${process.argv.includes("--verbose") ? "ON" : "OFF (use --verbose to see raw JSON)"}

Type your request. Use Ctrl+C to exit.${c.reset}
`);

  // 创建 readline 接口
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  const prompt = () => {
    rl.question(`${c.green}${c.bold}You → ${c.reset}`, async (input: string) => {
      const trimmed = input.trim();
      if (!trimmed) {
        prompt();
        return;
      }

      try {
        await handleUserInput(trimmed);
      } catch (err) {
        console.error(`\n${c.red}Error: ${(err as Error).message}${c.reset}`);
      }

      prompt();
    });
  };

  prompt();
}

// ──────────────────────────────────────────────
// 启动！
// ──────────────────────────────────────────────
main();