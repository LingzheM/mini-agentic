/**
 * ═══════════════════════════════════════════════════════════
 *  tools.ts — "手"：工具的定义与实现
 * ═══════════════════════════════════════════════════════════
 *
 *  这个文件做两件事：
 *  1. 用 JSON Schema 告诉 LLM "你有哪些工具可以用"（定义）
 *  2. 当 LLM 说 "我要用 read_file" 时，真正去读文件（实现）
 *
 *  关键洞察：LLM 永远不会自己执行代码。
 *  它只是输出一段 JSON 说 "我想调用 read_file，参数是 {path: './test.txt'}"
 *  然后由 我们的代码 来解析这个 JSON，执行真正的操作，再把结果喂回去。
 */

import { readFile, writeFile, mkdir } from "fs/promises";
import { exec } from "child_process";
import { dirname } from "path";

// ──────────────────────────────────────────────
// 第一部分：类型定义
// ──────────────────────────────────────────────

/** OpenAI 格式的工具定义 —— Ollama 也用这个格式 */
export interface ToolDefinition {
  type: "function";
  function: {
    name: string;
    description: string; // 这段描述非常重要！LLM 根据它决定何时用这个工具
    parameters: {
      type: "object";
      properties: Record<string, { type: string; description: string }>;
      required: string[];
    };
  };
}

/** LLM 返回的工具调用请求 */
export interface ToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string; // JSON 字符串，需要 parse
  };
}

// ──────────────────────────────────────────────
// 第二部分：工具定义（给 LLM 看的"菜单"）
// ──────────────────────────────────────────────
//
// 思考题：为什么 description 写得这么详细？
// 因为 LLM 完全靠 description 来判断什么时候该用这个工具。
// 如果你写 "读文件"，它可能不确定该何时用。
// 如果你写 "Read the contents of a file. Use this when you need to
// see what's inside a file."，它就很清楚了。

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: "function",
    function: {
      name: "read_file",
      description:
        "Read the complete contents of a file at the given path. " +
        "Use this to examine existing code, configs, or any text file. " +
        "Returns the file content as a string.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Relative or absolute file path to read",
          },
        },
        required: ["path"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "write_file",
      description:
        "Create a NEW file or COMPLETELY REPLACE an existing file with new content. " +
        "Parent directories will be created automatically. " +
        "WARNING: This overwrites the entire file. " +
        "To edit part of an existing file, prefer search_and_replace instead — " +
        "it's faster, cheaper, and less error-prone.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "File path to write to",
          },
          content: {
            type: "string",
            description: "The complete content to write to the file",
          },
        },
        required: ["path", "content"],
      },
    },
  },
  // ──────────────────────────────────────────────
  // Phase 3 新增：精确编辑工具
  // ──────────────────────────────────────────────
  //
  // 为什么需要 search_and_replace？
  //
  // 想象一个 500 行的文件，你只想改 3 行。
  // write_file 要重新输出全部 500 行 → 几千 token → 慢，贵，容易出错。
  // search_and_replace 只输出旧文本和新文本 → 几十 token → 快，省，精确。
  //
  // 这就是 Claude Code 实际使用的编辑方式。
  // 它几乎从不用 write_file 来修改已有文件。
  {
    type: "function",
    function: {
      name: "search_and_replace",
      description:
        "Replace a specific section of text in an existing file. " +
        "Provide the exact text to find (old_text) and its replacement (new_text). " +
        "The old_text must match EXACTLY — including whitespace and indentation. " +
        "Only the FIRST occurrence will be replaced. " +
        "Use this for editing existing files instead of write_file. " +
        "To delete text, set new_text to an empty string.",
      parameters: {
        type: "object",
        properties: {
          path: {
            type: "string",
            description: "Path to the file to edit",
          },
          old_text: {
            type: "string",
            description:
              "The exact text to find in the file. Must match precisely, " +
              "including all whitespace and indentation",
          },
          new_text: {
            type: "string",
            description:
              "The replacement text. Use empty string to delete the matched text",
          },
        },
        required: ["path", "old_text", "new_text"],
      },
    },
  },
  // ──────────────────────────────────────────────
  // Phase 3 新增：代码搜索工具
  // ──────────────────────────────────────────────
  //
  // 为什么需要 grep_search？
  //
  // 没有 grep，LLM 要理解一个项目就得逐个 read_file。
  // 10 个文件 = 10 次工具调用 = 10 轮 API 来回 = 慢。
  //
  // 有了 grep，一句 grep_search("handleAuth") 就能定位到
  // 哪些文件的哪些行包含这个函数，然后 LLM 只需要
  // read_file 最相关的那一两个文件。
  //
  // 这是从"盲人摸象"到"开灯看"的区别。
  {
    type: "function",
    function: {
      name: "grep_search",
      description:
        "Search for a text pattern across files in a directory. " +
        "Returns matching lines with file paths and line numbers. " +
        "Use this to find where functions are defined, where variables are used, " +
        "or to understand code structure without reading every file. " +
        "The pattern is treated as a fixed string (not regex) by default. " +
        "Searches recursively through subdirectories, skipping node_modules and .git.",
      parameters: {
        type: "object",
        properties: {
          pattern: {
            type: "string",
            description: "Text pattern to search for",
          },
          path: {
            type: "string",
            description:
              "Directory or file to search in. Defaults to current directory '.'",
          },
        },
        required: ["pattern"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "run_command",
      description:
        "Execute a shell command and return its stdout/stderr output. " +
        "Use this for: listing files (ls), installing packages (npm install), " +
        "running scripts, git operations, or any terminal command. " +
        "Commands timeout after 30 seconds.",
      parameters: {
        type: "object",
        properties: {
          command: {
            type: "string",
            description: "The shell command to execute",
          },
        },
        required: ["command"],
      },
    },
  },
];

// ──────────────────────────────────────────────
// 第三部分：工具实现（真正干活的代码）
// ──────────────────────────────────────────────
//
// 注意：这些函数和 LLM 没有任何关系。
// 它们就是普通的 TypeScript 函数。
// LLM 说 "我要调用 read_file"，我们就运行 readFileImpl。
// 这个"翻译"过程发生在 executeTool 函数里。

async function readFileImpl(args: { path: string }): Promise<string> {
  try {
    const content = await readFile(args.path, "utf-8");
    return content;
  } catch (err) {
    return `Error reading file: ${(err as Error).message}`;
  }
}

async function writeFileImpl(args: {
  path: string;
  content: string;
}): Promise<string> {
  try {
    // 自动创建父目录
    await mkdir(dirname(args.path), { recursive: true });
    await writeFile(args.path, args.content, "utf-8");
    return `✅ Successfully wrote ${args.content.length} chars to ${args.path}`;
  } catch (err) {
    return `Error writing file: ${(err as Error).message}`;
  }
}

async function runCommandImpl(args: { command: string }): Promise<string> {
  return new Promise((resolve) => {
    exec(
      args.command,
      {
        timeout: 30_000, // 30 秒超时保护
        maxBuffer: 1024 * 1024, // 1MB 输出上限
      },
      (error: (Error & { code?: number }) | null, stdout: string, stderr: string) => {
        if (error) {
          resolve(`Exit code ${error.code ?? 1}\n${stderr}\n${stdout}`.trim());
        } else {
          resolve(stdout || stderr || "(command produced no output)");
        }
      }
    );
  });
}

// ──────────────────────────────────────────────
// Phase 3 新增：精确编辑实现
// ──────────────────────────────────────────────
//
// search_and_replace 的逻辑极其简单：
//   1. 读取文件全文
//   2. 在全文中找到 old_text
//   3. 把第一个匹配替换成 new_text
//   4. 写回文件
//
// 但简单的东西往往有最多的边界情况：
//   - old_text 不存在？→ 告诉 LLM "没找到"，并显示文件的前几行帮它修正
//   - old_text 出现了多次？→ 只替换第一个，并提醒 LLM
//   - 文件不存在？→ 用 readFile 的错误自然处理
//
// 为什么只替换第一个？
// 因为"替换所有"太危险了。如果 LLM 想替换一个常见模式
// （比如 "const"），替换所有会毁掉整个文件。
// 只替换第一个强制 LLM 提供足够精确的上下文来定位唯一的匹配。

async function searchAndReplaceImpl(args: {
  path: string;
  old_text: string;
  new_text: string;
}): Promise<string> {
  // 1. 读取文件
  let content: string;
  try {
    content = await readFile(args.path, "utf-8");
  } catch (err) {
    return `Error reading file: ${(err as Error).message}`;
  }

  // 2. 查找 old_text
  const index = content.indexOf(args.old_text);
  if (index === -1) {
    // 找不到匹配——这是最常见的错误。
    // 给 LLM 足够的上下文来修正：显示文件前 20 行。
    const preview = content.split("\n").slice(0, 20).join("\n");
    return (
      `Error: Could not find the specified text in ${args.path}.\n` +
      `Make sure old_text matches EXACTLY, including whitespace and indentation.\n` +
      `Here are the first 20 lines of the file for reference:\n` +
      `---\n${preview}\n---`
    );
  }

  // 3. 检查是否有多个匹配（提醒但不阻止）
  const secondIndex = content.indexOf(args.old_text, index + args.old_text.length);
  let warning = "";
  if (secondIndex !== -1) {
    warning =
      " Note: The old_text appears multiple times in the file. " +
      "Only the first occurrence was replaced.";
  }

  // 4. 执行替换
  const newContent =
    content.slice(0, index) +
    args.new_text +
    content.slice(index + args.old_text.length);

  // 5. 写回文件
  try {
    await writeFile(args.path, newContent, "utf-8");
  } catch (err) {
    return `Error writing file: ${(err as Error).message}`;
  }

  // 6. 报告结果
  const oldLines = args.old_text.split("\n").length;
  const newLines = args.new_text.split("\n").length;
  return (
    `✅ Replaced ${oldLines} line(s) with ${newLines} line(s) in ${args.path}.` +
    warning
  );
}

// ──────────────────────────────────────────────
// Phase 3 新增：代码搜索实现
// ──────────────────────────────────────────────
//
// 用 grep 命令实现——不重新发明轮子。
// 关键参数：
//   -r    递归搜索子目录
//   -n    显示行号
//   -F    把 pattern 当作固定字符串（不是正则），更安全
//   -I    跳过二进制文件
//   --include / --exclude-dir 过滤不需要的文件
//
// 为什么不自己用 Node.js 实现？
// 因为 grep 已经高度优化了，比你自己写的快几个数量级。
// 而且它处理了所有编码、二进制、符号链接等边界情况。
// 工程师的智慧：能复用就复用。

async function grepSearchImpl(args: {
  pattern: string;
  path?: string;
}): Promise<string> {
  const searchPath = args.path ?? ".";

  return new Promise((resolve) => {
    // 构建 grep 命令
    // --exclude-dir 跳过常见的大目录
    const cmd =
      `grep -rnF -I ` +
      `--exclude-dir=node_modules ` +
      `--exclude-dir=.git ` +
      `--exclude-dir=dist ` +
      `--exclude-dir=build ` +
      `--exclude-dir=__pycache__ ` +
      `--color=never ` +
      `-- ${escapeShellArg(args.pattern)} ${escapeShellArg(searchPath)}`;

    exec(
      cmd,
      {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
      },
      (error: (Error & { code?: number }) | null, stdout: string, stderr: string) => {
        if (error && error.code === 1) {
          // grep 返回 1 = 没有匹配，不是错误
          resolve(
            `No matches found for "${args.pattern}" in ${searchPath}.`
          );
        } else if (error) {
          resolve(`Error running grep: ${stderr || error.message}`);
        } else {
          // 截断过长的结果——太多结果反而让 LLM 迷失
          const lines = stdout.split("\n").filter(Boolean);
          if (lines.length > 50) {
            resolve(
              lines.slice(0, 50).join("\n") +
                `\n\n... (${lines.length} matches total, showing first 50)`
            );
          } else {
            resolve(stdout.trim() || "No matches found.");
          }
        }
      }
    );
  });
}

/** 转义 shell 参数，防止注入 */
function escapeShellArg(arg: string): string {
  return "'" + arg.replace(/'/g, "'\\''") + "'";
}

// ──────────────────────────────────────────────
// 第四部分：工具路由器（Phase 1 加固版）
// ──────────────────────────────────────────────
//
// Phase 1 关键改动：
// 错误消息现在不只是说"出错了"，而是告诉 LLM
// "你做错了什么，以及怎么修正"。
//
// 为什么？因为这个错误消息会作为 tool role 的内容
// 喂回给 LLM。如果你只说 "Error"，LLM 不知道怎么修。
// 如果你说 "Error: Unknown tool 'search_code'. Available
// tools are: read_file, write_file, run_command"，
// LLM 就会说 "哦，我应该用 read_file"。
//
// 这就是 Phase 1 的核心洞察：
// 错误不是终点，是 LLM 自我修正的起点。

/** 所有已注册的工具名，用于错误提示 */
const KNOWN_TOOLS = TOOL_DEFINITIONS.map((t) => t.function.name);

/** 验证必需参数是否存在 */
function validateArgs(
  args: Record<string, unknown>,
  required: string[],
  toolName: string
): string | null {
  const missing = required.filter(
    (key) => args[key] === undefined || args[key] === null
  );
  if (missing.length > 0) {
    return (
      `Error: Missing required parameter(s): ${missing.join(", ")}. ` +
      `The "${toolName}" tool requires: ${required.join(", ")}. ` +
      `Please retry with all required parameters.`
    );
  }
  return null; // null = 验证通过
}

/** 根据工具名分发到对应的实现函数 */
export async function executeTool(
  name: string,
  rawArgs: string
): Promise<string> {
  // ── 第一道防线：JSON 解析 ──
  let args: Record<string, unknown>;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    // 告诉 LLM 它的 JSON 有问题，并给出示例
    return (
      `Error: Failed to parse tool arguments as JSON.\n` +
      `You provided: ${rawArgs.slice(0, 200)}\n` +
      `This is not valid JSON. Please retry with valid JSON, for example:\n` +
      `{"path": "./example.txt"}`
    );
  }

  // ── 第二道防线：工具名检查 ──
  //
  // LLM 有时候会"幻觉"一个工具名——调用一个不存在的工具。
  // 比如它可能调用 "search_files" 但你只定义了 "read_file"。
  // 我们不 crash，而是温和地纠正它。
  if (!KNOWN_TOOLS.includes(name)) {
    return (
      `Error: Unknown tool "${name}". ` +
      `Available tools are: ${KNOWN_TOOLS.join(", ")}. ` +
      `Please use one of the available tools.`
    );
  }

  // ── 第三道防线：参数验证 ──
  switch (name) {
    case "read_file": {
      const err = validateArgs(args, ["path"], name);
      if (err) return err;
      return readFileImpl(args as { path: string });
    }
    case "write_file": {
      const err = validateArgs(args, ["path", "content"], name);
      if (err) return err;
      return writeFileImpl(args as { path: string; content: string });
    }
    case "search_and_replace": {
      const err = validateArgs(args, ["path", "old_text", "new_text"], name);
      if (err) return err;
      return searchAndReplaceImpl(
        args as { path: string; old_text: string; new_text: string }
      );
    }
    case "grep_search": {
      const err = validateArgs(args, ["pattern"], name);
      if (err) return err;
      return grepSearchImpl(args as { pattern: string; path?: string });
    }
    case "run_command": {
      const err = validateArgs(args, ["command"], name);
      if (err) return err;
      return runCommandImpl(args as { command: string });
    }
    default:
      return `Error: Unknown tool "${name}"`;
  }
}