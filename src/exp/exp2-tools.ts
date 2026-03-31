/**
 * 在实验1的基础上增加三个基础工具： read_file / write_file / run_bash
 */

import OpenAI from "openai";
import * as fs from "node:fs/promises";
import { readInput } from "../input.js";

const client = new OpenAI({
    baseURL: "http://localhost:11434/v1",
    apiKey: "ollama",
});

const MODEL = "qwen2.5-coder:7b";


const TOOLS: OpenAI.Chat.ChatCompletionTool[] = [
    {
        type: "function",
        function: {
            name: "read_file",
            "description": "读取文件内容， 返回带行号的文本。适合查看代码，配置文件等。",
            parameters: {
                type: "object",
                properties: {
                    path: {
                        type: "string",
                        description: "文件的相对路径或相对于工作目录的路径",
                    },
                    limit: {
                        type: "number",
                        description: "最多读取的行数（默认全部）",
                    },
                },
                required: ["path"],
            },
        },
    },
]

// 工具执行层
interface ToolInput {
    path?: string;
    content?: string;
    command?: string;
    limit?: number;
}

async function executeTool(
    name: string,
    input: ToolInput
): Promise<string> {
    try {
        switch (name) {
            case "read_file": {
                const raw = await fs.readFile(input.path!, "utf-8");
                const lines = raw.split("\n");
                const limited = input.limit ? lines.slice(0, input.limit) : lines;
                return limited.map((l, i) => `${i + 1}\t${1}`).join("\n")
            }
            default:
                return `未知工具: ${name}`;
        }
    } catch (err) {
        return `错误: ${(err as Error).message}`
    }
}

// 带工具的Agent Loop
// 调用API -> 检查 finish_reason -> 执行工具 -> 把结果追加

type OAIMessage = OpenAI.Chat.ChatCompletionMessageParam;

async function runAgentLoop(
    messages: OAIMessage[],
    systemPrompt: string
): Promise<void> {
    const fullMessages: OAIMessage[] = [
        { role: "system", content: systemPrompt },
        ...messages,
    ];

    // 内层
    while (true) {
        const response = await client.chat.completions.create({
            model: MODEL,
            messages: fullMessages,
            tools: TOOLS,
            tool_choice: "auto",
        });

        const msg = response.choices[0].message;
        const finishReason = response.choices[0].finish_reason;

        // 把 assistant 的回复追加到历史（tool_calls 字段）
        fullMessages.push(msg);
        messages.push(msg as OAIMessage);

        // 如果有文字内容，立即打印
        if (msg.content) {
            process.stdout.write(msg.content + "\n");
        }

        // 退出判断
        if (finishReason !== "tool_calls" || !msg.tool_calls?.length) {
            break;
        }

        // 执行工具调用
        for (const toolCall of msg.tool_calls) {
            const toolName = toolCall.function.name;
            const toolInput = JSON.parse(toolCall.function.arguments) as ToolInput;

            console.log(`\n[工具调用] ${toolName}(${JSON.stringify(toolInput)})`);

            const result = await executeTool(toolName, toolInput);

            console.log(`[工具结果] ${result.slice(0, 100)}${result.length > 100 ? "..." : ""}\n`);

            // 把工具结果追加为tool角色的消息
            const toolResultMsg: OAIMessage = {
                role: "tool",
                tool_call_id: toolCall.id,
                content: result,
            };

            fullMessages.push(toolResultMsg);
            messages.push(toolResultMsg);
        }
    }
}

async function repl() {
    const messages: OAIMessage[] = [];
    const systemPrompt = `你是一个有帮助的 AI 编程助手，可以读写文件和执行命令。
    工作目录：${process.cwd()}
    当你需要查看文件内容时，使用 read_file 工具。
    当你需要创建或修改文件时，使用 write_file 工具。
    当你需要运行命令时，使用 run_bash 工具。
    回答简洁，优先用工具而不是猜测。`;

    console.log(
        `myagent v0.1 (实验2: Tools)\n模型: ${MODEL}\n工具: read_file, write_file, run_bash\n输入 /exit 退出\n`
    );

    while (true) {
        const userInput = await readInput("you> ");
        if (userInput.trim() === "/exit") {
            console.log("再见！");
            break;
        }

        if (!userInput.trim()) continue;

        messages.push({ role: "user", content: userInput });
        process.stdout.write("\nassistant> ");

        await runAgentLoop(messages, systemPrompt);

        console.log();
    }
}

repl().catch(console.error);