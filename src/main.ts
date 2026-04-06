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
// System Prompt — Phase 5: 从静态文字到动态架构
// ──────────────────────────────────────────────
//
// Phase 0-4 的 system prompt 是一段写死的字符串。
// 每次启动，LLM 看到的都是同一段话。
// 它不知道自己在什么操作系统上、项目用什么语言、
// 用户有什么偏好。用户得手动告诉它这些。
//
// Phase 5 的核心转变：
// system prompt 不是"一段提示"，而是"一份动态文档"。
// 每次启动时，我们的代码会：
//   1. 检测当前工作目录
//   2. 检测操作系统
//   3. 读取项目配置文件（package.json / pyproject.toml / Cargo.toml）
//   4. 读取用户自定义规则（CLAUDE.md）
//   5. 把这些信息注入 system prompt
//
// LLM 从第一句话就知道：
// "我在一个 Node.js 项目里，用了 React 和 TypeScript，
//  测试框架是 vitest，用户偏好用中文回复。"
//
// 同一个 Agent Loop + 同一组工具 + 不同的 system prompt
// = 完全不同的行为。
// 这就是 "prompt is the product" 的含义。

import { readFile as fsReadFile } from "fs/promises";
import { existsSync } from "fs";
import * as os from "os";
import * as path from "path";

/**
 * 动态构建 system prompt。
 *
 * 为什么是 async？因为要读文件（package.json、CLAUDE.md）。
 * 为什么在 main() 里调用而不是模块顶层？
 * 因为模块顶层不能 await。
 */
async function buildSystemPrompt(): Promise<string> {
  const sections: string[] = [];

  // ── 第一部分：角色定义 ──
  // 这一段是固定的，定义了 AI "是什么"。
  sections.push(`You are Mini Claude Code, a coding assistant that runs in the user's terminal.
You have access to tools that let you read files, write files, search code, and run shell commands.`);

  // ── 第二部分：环境上下文 ──
  // 这一段是动态的，每次启动时重新生成。
  //
  // 为什么要注入这些？
  // 因为 LLM 不知道它在哪台机器上、在什么项目里。
  // 没有这些信息，它会猜——猜错了就浪费工具调用。
  // 有了这些信息，它从第一步就走对。
  const cwd = process.cwd();
  const platform = os.platform(); // 'darwin', 'linux', 'win32'
  const shell = process.env.SHELL ?? process.env.COMSPEC ?? "unknown";

  sections.push(`ENVIRONMENT:
- Working directory: ${cwd}
- Operating system: ${platform}
- Default shell: ${shell}`);

  // ── 第三部分：项目检测 ──
  // 自动读取项目配置文件，提取关键信息。
  //
  // 设计决策：只读取小文件的核心字段，不读 node_modules。
  // 一个 package.json 的 name + dependencies 列表就够了，
  // 不需要把整个 lockfile 塞进 prompt（那会吃掉几千 token）。
  const projectInfo = await detectProjectInfo(cwd);
  if (projectInfo) {
    sections.push(`PROJECT:\n${projectInfo}`);
  }

  // ── 第四部分：用户自定义规则（CLAUDE.md）──
  //
  // 这是 Claude Code 的设计：用户在项目根目录放一个 CLAUDE.md，
  // 里面写着项目规范和偏好。Agent 启动时自动读取并注入。
  //
  // 比如用户可以写：
  //   "- 本项目使用 4 空格缩进"
  //   "- 测试文件放在 __tests__ 目录"
  //   "- 所有 commit message 用英文"
  //   "- 请用中文回复我"
  //
  // 这比在每次对话里重复说"用中文回复"高效得多。
  const claudeMd = await readClaudeMd(cwd);
  if (claudeMd) {
    sections.push(`USER RULES (from CLAUDE.md):\n${claudeMd}`);
  }

  // ── 第五部分：权限说明 ──
  sections.push(`PERMISSIONS:
- Read tools (read_file, grep_search) execute automatically.
- Write tools (write_file, search_and_replace) require user approval before executing.
- Exec tools (run_command) always require user approval.
- If the user denies a tool call, do NOT retry it. Ask the user what they'd prefer instead.`);

  // ── 第六部分：工具选择策略 ──
  sections.push(`TOOL SELECTION:
- To understand a codebase: start with grep_search to find relevant code, then read_file on specific files.
- To edit existing files: use search_and_replace with the exact text to find and its replacement.
  Only use write_file for creating NEW files or when you need to rewrite an entire file from scratch.
- To run tests, install packages, or check status: use run_command.`);

  // ── 第七部分：行为规则 ──
  sections.push(`RULES:
1. Before using a tool, briefly explain what you're about to do and why.
2. After a tool returns results, summarize what happened.
3. If a task needs multiple steps, work through them one at a time.
4. When writing code, follow the project's existing conventions (indentation, naming, structure).
5. Never run destructive commands (rm -rf /, etc.) without explicit confirmation.
6. Keep responses concise. You're in a terminal, not a chat UI.
7. Always respond in the same language the user uses.
8. When search_and_replace fails because old_text wasn't found, read the file first to see the actual content, then retry with the correct text.`);

  return sections.join("\n\n");
}

// ──────────────────────────────────────────────
// 项目检测
// ──────────────────────────────────────────────
//
// 检查当前目录有哪些配置文件，提取关键信息。
// 支持多种项目类型——不只是 Node.js。
//
// 设计原则：
//   1. 只读小文件（< 10KB），不阻塞启动
//   2. 只提取 LLM 最需要的字段（名字、语言、依赖列表）
//   3. 出错了不崩溃，只是少一段上下文

async function detectProjectInfo(cwd: string): Promise<string | null> {
  const lines: string[] = [];

  // ── Node.js 项目 ──
  const pkgPath = path.join(cwd, "package.json");
  if (existsSync(pkgPath)) {
    try {
      const raw = await fsReadFile(pkgPath, "utf-8");
      const pkg = JSON.parse(raw);
      lines.push(`- Type: Node.js`);
      if (pkg.name) lines.push(`- Name: ${pkg.name}`);

      // 提取依赖名（不含版本号，省 token）
      const deps = Object.keys(pkg.dependencies ?? {});
      const devDeps = Object.keys(pkg.devDependencies ?? {});
      if (deps.length > 0) {
        lines.push(`- Dependencies: ${deps.join(", ")}`);
      }
      if (devDeps.length > 0) {
        lines.push(`- Dev dependencies: ${devDeps.join(", ")}`);
      }

      // 有 TypeScript？
      if (
        devDeps.includes("typescript") ||
        deps.includes("typescript") ||
        existsSync(path.join(cwd, "tsconfig.json"))
      ) {
        lines.push(`- Language: TypeScript`);
      }

      // 检测测试框架
      const allDeps = [...deps, ...devDeps];
      const testFramework = allDeps.find((d) =>
        ["jest", "vitest", "mocha", "ava", "tap"].includes(d)
      );
      if (testFramework) {
        lines.push(`- Test framework: ${testFramework}`);
      }

      // 检测包管理器
      if (existsSync(path.join(cwd, "pnpm-lock.yaml"))) {
        lines.push(`- Package manager: pnpm`);
      } else if (existsSync(path.join(cwd, "yarn.lock"))) {
        lines.push(`- Package manager: yarn`);
      } else if (existsSync(path.join(cwd, "bun.lockb"))) {
        lines.push(`- Package manager: bun`);
      } else {
        lines.push(`- Package manager: npm`);
      }
    } catch {
      // package.json 读取失败——不致命，继续
    }
  }

  // ── Python 项目 ──
  const pyprojectPath = path.join(cwd, "pyproject.toml");
  const requirementsPath = path.join(cwd, "requirements.txt");
  if (existsSync(pyprojectPath)) {
    lines.push(`- Type: Python (pyproject.toml found)`);
  } else if (existsSync(requirementsPath)) {
    lines.push(`- Type: Python (requirements.txt found)`);
  }

  // ── Rust 项目 ──
  if (existsSync(path.join(cwd, "Cargo.toml"))) {
    lines.push(`- Type: Rust (Cargo.toml found)`);
  }

  // ── Go 项目 ──
  if (existsSync(path.join(cwd, "go.mod"))) {
    lines.push(`- Type: Go (go.mod found)`);
  }

  // ── Git 状态 ──
  if (existsSync(path.join(cwd, ".git"))) {
    lines.push(`- Git: initialized`);
  }

  return lines.length > 0 ? lines.join("\n") : null;
}

// ──────────────────────────────────────────────
// CLAUDE.md 读取
// ──────────────────────────────────────────────
//
// CLAUDE.md 是用户写给 Agent 的"说明书"。
// 它不是代码，是自然语言——用户可以写任何偏好：
//   "请用简体中文回复"
//   "本项目的 API 前缀是 /api/v2"
//   "别用 console.log 调试，用 debug 库"
//
// 我们原样注入 system prompt。
// 截断在 2000 字符——太长会挤占 context window。

async function readClaudeMd(cwd: string): Promise<string | null> {
  // 支持两种文件名
  const candidates = ["CLAUDE.md", "claude.md"];

  for (const name of candidates) {
    const filePath = path.join(cwd, name);
    if (existsSync(filePath)) {
      try {
        let content = await fsReadFile(filePath, "utf-8");
        if (content.length > 2000) {
          content = content.slice(0, 2000) + "\n... (truncated)";
        }
        return content.trim();
      } catch {
        return null;
      }
    }
  }

  return null;
}

// ──────────────────────────────────────────────
// 对话历史
// ──────────────────────────────────────────────
//
// Phase 5 变更：不再在模块顶层初始化。
// 因为 buildSystemPrompt 是 async 的（需要读文件），
// 我们在 main() 里构建 prompt 之后再初始化历史。

let conversationHistory: Message[] = [];

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

  const isTrustMode = process.argv.includes("--trust");
  if (isTrustMode) {
    setTrustMode(true);
    console.log(
      `${c.yellow}⚠ Trust mode: all tool calls will execute without confirmation${c.reset}\n`
    );
  }

  // ── Phase 5 新增：动态构建 system prompt ──
  //
  // 这是整个 Phase 5 的核心。
  // 在用户看到 prompt 之前，我们已经：
  //   1. 检测了操作系统和 shell
  //   2. 读取了 package.json（如果有）
  //   3. 读取了 CLAUDE.md（如果有）
  //   4. 把所有信息拼进了 system prompt
  //
  // LLM 从第一个回复开始就"知道"它在什么项目里。
  const systemPrompt = await buildSystemPrompt();

  // 初始化对话历史
  conversationHistory = [
    { role: "system", content: systemPrompt },
  ];

  // ── 检测到的上下文，显示给用户 ──
  const cwd = process.cwd();
  const projectInfo = await detectProjectInfo(cwd);
  const hasClaudeMd = existsSync(path.join(cwd, "CLAUDE.md")) ||
                      existsSync(path.join(cwd, "claude.md"));

  // 启动画面
  console.log(`
${c.cyan}${c.bold}╔══════════════════════════════════════╗
║        🤖 Mini Claude Code          ║
║   Phase 5: Prompt is the Product    ║
╚══════════════════════════════════════╝${c.reset}

${c.dim}Model:    ${getModelName()}
Ollama:   ${getBaseUrl()}
CWD:      ${cwd}
Tools:    read_file, write_file, search_and_replace, grep_search, run_command
Perms:    ${isTrustMode ? "TRUST MODE (all auto-approved)" : "ON (write/exec require approval)"}
CLAUDE.md:${hasClaudeMd ? " loaded ✓" : ` not found ${c.reset}${c.dim}(create one to set project rules)`}
${projectInfo ? `Project:  ${projectInfo.split("\n")[0].replace("- ", "")}` : "Project:  (no config detected)"}

Type your request. Use Ctrl+C to exit.${c.reset}
`);

  if (process.argv.includes("--verbose")) {
    console.log(`${c.dim}┌─── SYSTEM PROMPT (${systemPrompt.length} chars) ──`);
    console.log(systemPrompt);
    console.log(`└──────────────────────────────────────────${c.reset}\n`);
  }

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