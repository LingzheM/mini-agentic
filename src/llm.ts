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
  process.env.OLLAMA_MODEL ?? "qwen2.5:7b";

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

/**
 * 发送消息给 LLM，返回助手的回复。
 *
 * 重要：这个函数只负责 "一次来回"。
 * 工具调用的循环逻辑在 main.ts 里。
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

  // ── 发送 HTTP 请求 ──
  //
  // 就这么简单。Tool Calling 不是什么魔法，
  // 它就是一个 HTTP POST，body 里带了 tools 数组。
  // LLM 看到 tools 定义后，会在回复中选择调用某个工具，
  // 或者直接回复文本。

  let response: Response;
  try {
    response = await fetch(`${OLLAMA_BASE_URL}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(requestBody),
    });
  } catch (err) {
    throw new Error(
      `Cannot connect to Ollama at ${OLLAMA_BASE_URL}\n` +
        `Make sure Ollama is running: ollama serve\n` +
        `Original error: ${(err as Error).message}`
    );
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Ollama returned ${response.status}: ${text}`);
  }

  const data = (await response.json()) as ChatResponse;

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

/** 返回当前配置的模型名 */
export function getModelName(): string {
  return OLLAMA_MODEL;
}

/** 返回 Ollama 的 URL */
export function getBaseUrl(): string {
  return OLLAMA_BASE_URL;
}