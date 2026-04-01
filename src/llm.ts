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
  process.env.OLLAMA_MODEL ?? "qwen2.5-coder:7b";

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