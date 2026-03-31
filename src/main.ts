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
import { chat, setVerbose, getModelName, getBaseUrl, type Message } from "./llm.js";
import { TOOL_DEFINITIONS, executeTool } from "./tools.js";

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
You have access to tools that let you read files, write files, and run shell commands.

RULES:
1. Before using a tool, briefly explain what you're about to do and why.
2. After a tool returns results, summarize what happened.
3. If a task needs multiple steps, work through them one at a time.
4. When writing code, follow best practices for the language.
5. Never run destructive commands (rm -rf /, etc.) without explicit confirmation.
6. Keep responses concise. You're in a terminal, not a chat UI.
7. Always respond in the same language the user uses.`;

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
// Agent Loop — 整个项目的核心
// ──────────────────────────────────────────────

/**
 * 处理一次用户输入，可能触发多轮工具调用。
 *
 * 为什么是 while 循环？
 * 因为 LLM 可能需要连续调用多个工具。比如：
 *   1. "帮我创建一个 React 组件"
 *   2. LLM: 我先看看项目结构 → 调用 run_command("ls")
 *   3. 我们把 ls 结果喂回去
 *   4. LLM: 看到了，现在创建文件 → 调用 write_file(...)
 *   5. 我们把写入结果喂回去
 *   6. LLM: "好了，我帮你创建了组件！" → 纯文本，循环结束
 */
async function handleUserInput(userMessage: string): Promise<void> {
  // 1. 把用户消息加入历史
  conversationHistory.push({ role: "user", content: userMessage });

  // 2. 进入 Agent Loop
  while (true) {
    // 2a. 调用 LLM
    const response = await chat(conversationHistory, TOOL_DEFINITIONS);

    // 2b. 检查 LLM 是否想调用工具
    if (response.toolCalls.length > 0) {
      // ──── 工具调用分支 ────
      //
      // LLM 没有直接回答，而是说："我想用某个工具"。
      // 我们需要：
      //   1. 把 LLM 的工具调用请求记入历史
      //   2. 真正执行工具
      //   3. 把执行结果记入历史
      //   4. 回到循环顶部，让 LLM 看到结果后继续

      // 记录 LLM 的回复（包含 tool_calls）
      conversationHistory.push({
        role: "assistant",
        content: response.content,
        tool_calls: response.toolCalls,
      });

      // 逐个执行工具
      for (const toolCall of response.toolCalls) {
        const toolName = toolCall.function.name;
        const toolArgs = toolCall.function.arguments;

        // 显示正在做什么
        console.log(
          `\n${c.yellow}⚡ Tool: ${c.bold}${toolName}${c.reset}`
        );
        console.log(`${c.dim}   Args: ${toolArgs}${c.reset}`);

        // 执行！
        const result = await executeTool(toolName, toolArgs);

        // 显示结果（截断过长的输出）
        const preview =
          result.length > 500
            ? result.slice(0, 500) + `\n... (${result.length} chars total)`
            : result;
        console.log(`${c.dim}   Result: ${preview}${c.reset}`);

        // 把工具结果加入历史——这是关键！
        // role: "tool" 告诉 LLM "这是你要求调用的工具的返回结果"
        conversationHistory.push({
          role: "tool",
          tool_call_id: toolCall.id,
          content: result,
        });
      }

      // 继续循环，让 LLM 处理工具结果
      continue;
    }

    // ──── 纯文本回复分支 ────
    //
    // LLM 没有调用工具，直接给了文字回答。
    // 这意味着它"完成了"当前任务。

    if (response.content) {
      conversationHistory.push({
        role: "assistant",
        content: response.content,
      });
      console.log(`\n${c.cyan}${response.content}${c.reset}`);
    }

    // 跳出 Agent Loop，等待用户下一次输入
    break;
  }
}

// ──────────────────────────────────────────────
// REPL（交互式输入循环）
// ──────────────────────────────────────────────

async function main(): Promise<void> {
  // 处理 --verbose 标志
  if (process.argv.includes("--verbose")) {
    setVerbose(true);
    console.log(`${c.dim}(verbose mode: showing raw JSON)${c.reset}\n`);
  }

  // 启动画面
  console.log(`
${c.cyan}${c.bold}╔══════════════════════════════════════╗
║        🤖 Mini Claude Code          ║
║     Phase 1: The Tool Caller        ║
╚══════════════════════════════════════╝${c.reset}

${c.dim}Model:    ${getModelName()}
Ollama:   ${getBaseUrl()}
Tools:    read_file, write_file, run_command
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