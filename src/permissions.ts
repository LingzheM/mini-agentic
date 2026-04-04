/**
 * ═══════════════════════════════════════════════════════════
 *  permissions.ts — "守卫"：信任边界
 * ═══════════════════════════════════════════════════════════
 *
 *  Phase 4 核心概念：不是所有操作都该自动执行。
 *
 *  到 Phase 3 为止，LLM 说什么就执行什么。
 *  它说 rm -rf /tmp/project，你的代码就真的删了。
 *  它说 write_file 覆盖你的 .env，你的密钥就没了。
 *
 *  这个文件做一件事：
 *  在 LLM 的"决定"和代码的"执行"之间插入一道关卡。
 *
 *  ┌─────────┐    ┌──────────────┐    ┌─────────────┐
 *  │ LLM 说: │ →  │ permissions  │ →  │ executeTool  │
 *  │ 用工具  │    │ 需要确认吗？ │    │ 真正执行     │
 *  └─────────┘    └──────────────┘    └─────────────┘
 *                    ↓ 需要
 *                 ┌──────────┐
 *                 │ 问用户   │
 *                 │ [y/n]    │
 *                 └──────────┘
 */

import * as readline from "readline";

// ──────────────────────────────────────────────
// 风险等级定义
// ──────────────────────────────────────────────
//
// 三个等级，逻辑很直觉：
//
//   read  — 只看不动。不可能造成任何损害。自动执行。
//   write — 会改文件。可能覆盖重要内容。需要确认。
//   exec  — 执行任意命令。可能做任何事。始终需要确认。
//
// 为什么 read 不需要确认？
// 因为读操作没有副作用。LLM 读了你的 package.json，
// 你的 package.json 不会变。确认读操作只会让用户烦。
//
// 为什么 exec 最高风险？
// 因为 run_command 能执行任意 shell 命令。
// LLM 可能跑 npm install（安全），也可能跑 curl xxx | bash（危险）。
// 你无法从参数 schema 判断命令是否安全，只能让人看一眼。

type RiskLevel = "read" | "write" | "exec";

/** 每个工具的风险等级 */
const TOOL_RISK: Record<string, RiskLevel> = {
  read_file: "read",
  grep_search: "read",
  write_file: "write",
  search_and_replace: "write",
  run_command: "exec",
};

/** 风险等级对应的显示颜色和标签 */
const RISK_DISPLAY: Record<RiskLevel, { color: string; label: string }> = {
  read: { color: "\x1b[32m", label: "READ" },   // 绿色
  write: { color: "\x1b[33m", label: "WRITE" },  // 黄色
  exec: { color: "\x1b[31m", label: "EXEC" },    // 红色
};

// ──────────────────────────────────────────────
// 信任模式
// ──────────────────────────────────────────────
//
// --trust 标志：跳过所有确认。
// 类似 Claude Code 的 --dangerously-skip-permissions。
//
// 什么时候用？当你信任 LLM 并且想要无中断的自动化流程时。
// 什么时候不用？当你不确定 LLM 会做什么，或者在生产环境时。

let trustMode = false;

export function setTrustMode(trust: boolean): void {
  trustMode = trust;
}

// ──────────────────────────────────────────────
// 权限检查
// ──────────────────────────────────────────────

/**
 * 检查一个工具调用是否需要用户确认。
 * 如果需要，显示工具信息并等待用户输入 y/n。
 *
 * 返回：
 *   true  = 用户允许执行（或不需要确认）
 *   false = 用户拒绝执行
 */
export async function checkPermission(
  toolName: string,
  toolArgs: string
): Promise<boolean> {
  const risk = TOOL_RISK[toolName] ?? "exec"; // 未知工具按最高风险处理

  // read 操作永远自动通过
  if (risk === "read") return true;

  // 信任模式下一律通过
  if (trustMode) return true;

  // ── 需要用户确认 ──
  const display = RISK_DISPLAY[risk];
  const reset = "\x1b[0m";
  const bold = "\x1b[1m";
  const dim = "\x1b[2m";

  // 显示工具信息
  console.log(
    `\n${display.color}${bold}⚠ Permission required [${display.label}]${reset}`
  );
  console.log(`${dim}  Tool: ${toolName}${reset}`);

  // 显示参数的人类可读版本
  // 对于不同工具，显示最关键的信息
  try {
    const args = JSON.parse(toolArgs);
    switch (toolName) {
      case "write_file":
        console.log(`${dim}  Path: ${args.path}${reset}`);
        console.log(
          `${dim}  Content: ${(args.content?.length ?? 0)} chars${reset}`
        );
        break;
      case "search_and_replace":
        console.log(`${dim}  Path: ${args.path}${reset}`);
        // 显示替换 diff：红色 = 删除，绿色 = 新增
        console.log(`\x1b[31m  - ${truncate(args.old_text, 120)}${reset}`);
        console.log(`\x1b[32m  + ${truncate(args.new_text, 120)}${reset}`);
        break;
      case "run_command":
        // 命令是最需要仔细看的——完整显示
        console.log(`${display.color}  $ ${args.command}${reset}`);
        break;
      default:
        console.log(`${dim}  Args: ${truncate(toolArgs, 200)}${reset}`);
    }
  } catch {
    console.log(`${dim}  Args: ${truncate(toolArgs, 200)}${reset}`);
  }

  // 等待用户输入
  const answer = await askYesNo("  Allow?");

  return answer;
}

// ──────────────────────────────────────────────
// 辅助函数
// ──────────────────────────────────────────────

/** 截断过长的字符串，替换换行符为可见符号 */
function truncate(str: string, maxLen: number): string {
  // 把换行替换成 ↵ 符号，方便在一行内显示
  const oneLine = str.replace(/\n/g, "↵");
  if (oneLine.length <= maxLen) return oneLine;
  return oneLine.slice(0, maxLen) + "…";
}

/**
 * 在终端里问用户 yes/no 问题。
 *
 * 为什么不复用 main.ts 的 readline？
 * 因为 main.ts 的 rl 在等待下一个 prompt，
 * 我们需要一个独立的 readline 来做临时的 y/n 询问。
 * 用完就关掉。
 */
function askYesNo(question: string): Promise<boolean> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    rl.question(
      `${question} ${"\x1b[2m"}(y/n)${"\x1b[0m"} `,
      (answer: string) => {
        rl.close();
        const normalized = answer.trim().toLowerCase();
        resolve(normalized === "y" || normalized === "yes");
      }
    );
  });
}