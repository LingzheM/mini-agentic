import { OpenAI } from 'openai';
import { readInput } from '../input.js';
// 配置区
const client = new OpenAI({
    baseURL: "http://localhost:11434/v1",
    apiKey: "ollama",
});

const MODEL = "qwen2.5-coder:7b";

// 类型定义
type Role = "user" | "assistant" | "system";
interface Message {
    role: Role;
    content: string;
}

/**
 * 
 * @param messages 
 */
async function callLLM(messages:Message[]): Promise<string> {
   const stream = await client.chat.completions.create({
    model: MODEL,
    messages: messages,
    stream: true,
   });
   
   let fullText = "";

   // 逐个chunk
   for await (const chunk of stream) {
    const delta = chunk.choices[0]?.delta?.content ?? "";
    if (delta) {
        process.stdout.write(delta);
        fullText += delta;
    }
   }

   process.stdout.write("\n");
   return fullText;
}

/**
 * REPL--外层循环: Read -> Eval -> Print -> Loop
 * 
 * 外层 = REPL，等待用户输入，每次输入是一个turn
 * 内层 = Agent Loop，
 */
async function repl() {
    // messages[] 整个会话记忆
    const messages: Message[] = []

    // system prompt
    const systemPrompt = "你是一个有帮助的 AI 助手。你的回复简洁、准确。";

    console.log(
        `myagent v0.1 (实验1: 裸 Agent Loop)\n模型: ${MODEL}\n输入 /exit 退出\n`
    );

    // 外层REPL
    while (true) {
        const userInput = await readInput("you> ");

        if (userInput.trim() === "/exit") {
            console.log("再见！");
            break;
        }

        if (!userInput.trim()) continue;

        messages.push({ role: "user", content: userInput });

        process.stdout.write("\nassistant> ");

        // 内层 Agent Loop
        while(true) {
            const reply = await callLLM([
                { role: "system", content: systemPrompt },
                ...messages,
            ]);

            // 把助手回复追加到 messages (这是多轮对话记忆的关键)
            messages.push({ role: "assistant", content: reply });

            break;
        }
        // 内层循环结束

        console.log();
    }
}

repl().catch(console.error);