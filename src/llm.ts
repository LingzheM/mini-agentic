/**
 * ═══════════════════════════════════════════════════════════
 *  llm.ts — "嘴"：与 LLM 通信
 * ═══════════════════════════════════════════════════════════
 *
 *  这个文件只做一件事：把消息发给 Ollama，拿到回复。
 *
 *  我们故意 不用任何 SDK（没有 openai 包，没有 ollama 包）。
 *  只用原生 fetch。这样你能看到：
 *    - 发出去的 HTTP 请求长什么样
 *    - 收回来的 JSON 长什么样
 *    - Tool Calling 在协议层面是怎么工作的
 *
 *  Ollama 在 http://localhost:11434 提供 OpenAI 兼容的 API，
 *  所以我们用 /v1/chat/completions 这个标准端点。
 */

import { ToolDefinition, ToolCall } from "./tools.js";

// ──────────────────────────────────────────────
// 配置
// ──────────────────────────────────────────────

const OLLAMA_BASE_URL =
  process.env.OLLAMA_URL ?? "http://localhost:11434";

const OLLAMA_MODEL =
  process.env.OLLAMA_MODEL ?? "llama3.1:8b";

// ──────────────────────────────────────────────
// 消息类型（OpenAI Chat Completion 格式）
// ──────────────────────────────────────────────
//
// 为什么用 OpenAI 格式？因为它已经成了事实标准。
// Ollama、LM Studio、vLLM、Together AI……几乎所有本地/云端
// 服务都兼容这个格式。学一次，到处用。

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: ToolCall[] }
  | { role: "tool"; tool_call_id: string; content: string };

// ──────────────────────────────────────────────
// LLM 响应类型
// ──────────────────────────────────────────────

interface ChatChoice {
  message: {
    role: "assistant";
    content: string | null;
    tool_calls?: ToolCall[];
  };
  finish_reason: "stop" | "tool_calls" | "length";
}

interface ChatResponse {
  choices: ChatChoice[];
}

// ──────────────────────────────────────────────
// 核心函数：发送一次对话请求
// ──────────────────────────────────────────────

/** verbose 模式下打印完整的请求/响应 JSON */
let verbose = false;
export function setVerbose(v: boolean) {
  verbose = v;
}

// ──────────────────────────────────────────────
// Phase 1 新增: 重试配置
// ──────────────────────────────────────────────
// 
// 为什么需要重试？
// 网络会断，Ollama会偶尔返回500， 模型加载中会返回503
// 这些是"暂时性故障"，等一下再试就好了。
// 但有些错误不应该重试：400（你的请求格式有问题）
//
// 策略叫"指数退避"：第一次等 1 秒，第二次等 2 秒，
// 第三次等 4 秒。

const MAX_RETRIES = 3;
const BASE_DELAY_MS = 1000;

/** 判断一个 HTTP 状态码是否值得重试 */
function isRetryable(status: number): boolean {
    // 429 = 太多请求（rate limit）
    // 500 = 服务器内部错误，可能是暂时的
    // 502/503/504 = 网关/服务不可用，通常是暂时的
    return [429, 500, 502, 503, 504].includes(status);
}

/** 等待指定毫秒 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * 发送消息给 LLM，返回助手的回复。
 *
 * 重要：这个函数只负责 "一次来回"。
 * 工具调用的循环逻辑在 main.ts 里。
 * 
 * Phase 1 改动:
 * - 增加重试
 * - 增加响应 JSON 解析保护
 * - 增加空回复兜底
 */
export async function chat(
  messages: Message[],
  tools: ToolDefinition[]
): Promise<{
  content: string | null;
  toolCalls: ToolCall[];
}> {
  // ── 构建请求体 ──
  const requestBody = {
    model: OLLAMA_MODEL,
    messages,
    tools,
    stream: false, // 先不用流式，看清楚完整结构
  };

  if (verbose) {
    console.log("\n┌─── 📤 REQUEST TO LLM ───────────────────");
    console.log(JSON.stringify(requestBody, null, 2));
    console.log("└──────────────────────────────────────────\n");
  }

  // ── 带重试的 HTTP 请求 ──
  //
  // 就这么简单。Tool Calling 不是什么魔法，
  // 它就是一个 HTTP POST，body 里带了 tools 数组。
  // LLM 看到 tools 定义后，会在回复中选择调用某个工具，
  // 或者直接回复文本。

  let lastError: Error | null = null;
  
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
        const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
        console.log(
            `\x1b[33m⏳ Retry ${attempt}/${MAX_RETRIES} in ${delay}ms...\x1b[0m`
        );
        await sleep(delay);
    }

    let response: Response;
    try {
        response = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
        });
    } catch (err) {
        lastError = new Error(
        `Cannot connect to Ollama at ${OLLAMA_BASE_URL}\n` +
            `Make sure Ollama is running: ollama serve\n` +
            `Original error: ${(err as Error).message}`
        );
        continue;
    }

    if (!response.ok) {
        const text = await response.text();
        lastError = new Error(`Ollama returned ${response.status}: ${text.slice(0, 200)}`);

        if (isRetryable(response.status)) {
            continue;
        }
        
        throw lastError;
    }

    // 解析响应 JSON
    //
    // Phase 1 新增保护: response.json() 
    let data: ChatResponse;
    try {
        data = (await response.json()) as ChatResponse;
    } catch {
        lastError = new Error(
            "LLM returned invalid JSON. The response may have been truncated."
        );
        continue;
    }

    if (verbose) {
        console.log("\n┌─── 📥 RESPONSE FROM LLM ────────────────");
        console.log(JSON.stringify(data, null, 2));
        console.log("└──────────────────────────────────────────\n");
    }

    // ── 解析响应 ──
    const choice = data.choices?.[0];
    if (!choice) {
      throw new Error("LLM returned empty response");
    }

    return {
      content: choice.message.content,
      toolCalls: choice.message.tool_calls ?? [],
    };
  }
  
  throw lastError ?? new Error("All retry attempts exhausted");
}

/** 返回当前配置的模型名 */
export function getModelName(): string {
  return OLLAMA_MODEL;
}

/** 返回 Ollama 的 URL */
export function getBaseUrl(): string {
  return OLLAMA_BASE_URL;
}

// Phase 2 新增: Streaming(SSE)

// phase0(1)的chat用stream: false, 等LLM生成完全部内容
// 才一次性返回。用户要盯着空白屏幕等 10-30 秒。

// 流式的本质是：LLM每生成一个token，就立刻推给你。
// 协议叫 Server-Sent Events (SSE):
// -  服务器发一串 "data: {...}\n\n" 格式的文本块
// -  每一块是一个 JSON 片段，里面有一个新 token
// -  最后一块是 "data: [DONE]\n\n"

// 难点: 工具调用也是流式的
// LLM 不会一次给你完整的 { name: "read_file", arguments: "{...}" }
// 它会是一个 token 一个 token 
//   chunk 1: tool_calls[0] = { id: "xxx", function: { name: "read_file", arguments: "" } }
//   chunk 2: tool_calls[0] = { function: { arguments: "{\"pa" } }
//   chunk 3: tool_calls[0] = { function: { arguments: "th\":" } }
//   chunk 4: tool_calls[0] = { function: { arguments: " \"./x" } }
//   ...
// 你需要把这些碎片拼起来，等到完整后才能执行。

/** SSE 流中每个 chunk 的 delta 结构 */
interface StreamDelta {
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: {
      name?: string;
      arguments?: string;
    };
  }>;
}

interface StreamChunk {
  choices?: Array<{
    delta: StreamDelta;
    finish_reason: string | null;
  }>;
}

/**
 * 流式版本的 chat
 * 
 * 区别在于:
 *  - chat(): 等全部生成完 -> 返回完整结果
 *  - chatStream(): 每收到一个token -> 立刻调用 onToken 回调
 * 
 * onToken 回调让 main.ts 可以做 process.stdout.write(token)
 */
export async function chatStream(
  messages: Message[],
  tools: ToolDefinition[],
  onToken: (token: string) => void
): Promise<{
  content: string | null;
  toolCalls: ToolCall[];
}> {
  const requestBody = {
    model: OLLAMA_MODEL,
    messages,
    tools,
    stream: true,
  };
  
  if (verbose) {
    console.log("\n┌─── 📤 REQUEST TO LLM (stream) ──────────");
    console.log(JSON.stringify(requestBody, null, 2));
    console.log("└──────────────────────────────────────────\n");
  }

  // 带重试的请求
  let lastError: Error | null = null;

  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    if (attempt > 0) {
      const delay = BASE_DELAY_MS * Math.pow(2, attempt - 1);
      console.log(
        `\x1b[33m⏳ Retry ${attempt}/${MAX_RETRIES} in ${delay}ms...\x1b[0m`
      );
      await sleep(delay);
    }

    let response: Response;
    try {
      response = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(requestBody),
      });
    } catch (err) {
      lastError = new Error(
        `Cannot connect to Ollama at ${OLLAMA_BASE_URL}\n` +
          `Make sure Ollama is running: ollama serve\n` +
          `Original error: ${(err as Error).message}`
      );
      continue;
    }

    if (!response.ok) {
      const text = await response.text();
      lastError = new Error(
        `Ollama return ${response.status}: ${text.slice(0, 200)}`
      );
      if (isRetryable(response.status)) continue;
      throw lastError;
    }

    // 读取 SSE 流
    //
    // response.body 是一个 ReadableStream
    // 我们把它转成文本，按行切割，逐行解析。
    //
    // SSE 协议非常简单:
    // 每个事件 = "data: {JSON}\n\n"
    // 流结束 = "data: [DONE]\n\n"
    // 
    // 但有一个坑: 一次 read() 可能返回半行数据，
    // 也可能返回多行数据。所以我们需要一个 buffer
    // 来处理"行"的边界

    if (!response.body) {
      lastError = new Error("Response has no body (streaming not supported?)");
      continue;
    }
    try {
      const result = await parseSSEStream(response.body, onToken);

      if (verbose) {
        console.log("\n┌─── 📥 STREAMED RESULT ──────────────────");
        console.log(JSON.stringify(result, null, 2));
        console.log("└──────────────────────────────────────────\n");        
      }
      
      return result;
    } catch (err) {
      lastError = err as Error;
      continue;
    }
  }

  throw lastError ?? new Error("All retry attempts exhausted");
}

/**
 * 解析 SSE 流，收集完整的 content 和 tool_calls.
 * 
 * 1. 把字节流转成文本行
 * 2. 每一行如果以 "data: " 开头，就解析 JSON
 * 3. JSON 里的 delta.content -> 累积到 fullContent, 同时调用 onToken
 * 4. JSON 里的 delta.tool_calls -> 按 index 累积到 toolCallMap
 * 5. 收到 "data: [DONE]" -> 结束，返回拼好的结果
 */
async function parseSSEStream(
  body: ReadableStream<Uint8Array>,
  onToken: (token: string) => void
): Promise<{
  content: string | null;
  toolCalls: ToolCall[];
}> {
  const reader = body.getReader();
  const decoder = new TextDecoder();

  // 累积器
  let fullContent = "";
  // 工具调用按 index 分开累积
  // 为什么用Map? 因为 LLM 可能同时调用多个工具，
  // 每个工具有不同的index, 
  const toolCallMap = new Map<
    number,
    { id: string; name: string; arguments: string }
  >();

  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    // 把字节码解码成文本，追加到 buffer
    buffer += decoder.decode(value, { stream: true });

    // 按换行符切割成行
    const lines = buffer.split("\n");
    // 最后一个"行"可能是不完整的， 留在 buffer 里
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();

      // 跳过空行（SSE 用空行分隔事件）
      if (!trimmed) continue;

      // 流结束信号
      if (trimmed === "data: [DONE]") continue;

      // 必须以 "data: " 开头
      if (!trimmed.startsWith("data: ")) continue;

      // 解析 JSON
      let chunk: StreamChunk;
      try {
        chunk = JSON.parse(trimmed.slice(6));
      } catch {
        continue;
      }

      const delta = chunk.choices?.[0]?.delta;
      if (!delta) continue;

      // 处理文本token
      if (delta.content) {
        fullContent += delta.content;
        onToken(delta.content);
      }

      // 处理工具调用碎片

      // 我们要做的是: 按 index 分组，把 id/name 记下来， 把 arguments 拼起来。
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index;

          if (!toolCallMap.has(idx)) {
            toolCallMap.set(idx, {
              id: tc.id ?? `call_${idx}`,
              name: tc.function?.name ?? "",
              arguments: tc.function?.arguments ?? "",
            });
          } else {
            const existing = toolCallMap.get(idx);
            if (tc.function?.arguments) {
              existing.arguments += tc.function.arguments;
            }
            if (tc.function?.name) {
              existing.name += tc.function.name;
            }
          }
        }
      }
    }
  }

  // 组装最终结果
  // 把 toolCallMap 转换成和 chat() 一样的 ToolCall[] 格式
  const toolcalls: ToolCall[] = Array.from(toolCallMap.entries())
    .sort(([a], [b]) => a - b)
    .map(([, tc]) => ({
      id: tc.id,
      type: "function" as const,
      function: {
        name: tc.name,
        arguments: tc.arguments,
      },
    }));

    return {
      content: fullContent || null,
      toolCalls: toolcalls,
    };
}