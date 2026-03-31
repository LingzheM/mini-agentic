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
        "Create or overwrite a file with the given content. " +
        "Parent directories will be created automatically if they don't exist. " +
        "Use this to create new files or update existing ones.",
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
// 第四部分：工具路由器
// ──────────────────────────────────────────────
//
// 这是连接 "LLM 的决定" 和 "实际执行" 的桥梁。
// LLM 输出 JSON: { name: "read_file", arguments: '{"path":"./x.ts"}' }
// 我们解析它，找到对应的函数，执行，返回结果字符串。

/** 根据工具名分发到对应的实现函数 */
export async function executeTool(
  name: string,
  rawArgs: string
): Promise<string> {
  // 解析 LLM 给的 JSON 参数
  let args: Record<string, string>;
  try {
    args = JSON.parse(rawArgs);
  } catch {
    return `Error: Failed to parse tool arguments: ${rawArgs}`;
  }

  switch (name) {
    case "read_file":
      return readFileImpl(args as { path: string });
    case "write_file":
      return writeFileImpl(args as { path: string; content: string });
    case "run_command":
      return runCommandImpl(args as { command: string });
    default:
      return `Error: Unknown tool "${name}"`;
  }
}