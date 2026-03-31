import { OpenAI } from 'openai';
import { stdin, stdout } from 'node:process';

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

// 放在任意一个 exp*.ts 里替换 rl.question()
async function readInput(prompt: string): Promise<string> {
  process.stdout.write(prompt);
  
  let buffer = "";
  const undoStack: string[] = [""];
  
  process.stdin.setRawMode(true);
  process.stdin.resume();
  
  return new Promise((resolve) => {
    const handler = (chunk: Buffer) => {
      const byte = chunk[0];
      
      if (byte === 0x0d || byte === 0x0a) {       // Enter
        process.stdout.write("\n");
        process.stdin.setRawMode(false);
        process.stdin.off("data", handler);
        resolve(buffer);
        
      } else if (byte === 0x7f) {                  // Backspace
        if (buffer.length > 0) {
          buffer = buffer.slice(0, -1);
          process.stdout.write("\b \b");           // 擦除终端上的字符
        }
        
      } else if (byte === 0x1a) {                  // Ctrl+Z — undo
        if (undoStack.length > 1) {
          buffer = undoStack.pop()!;
          process.stdout.write(`\r\x1b[2K${prompt}${buffer}`);
        }
        
      } else if (byte === 0x03) {                  // Ctrl+C
        process.stdout.write("\n");
        process.exit(0);
        
      } else if (byte >= 0x20) {                   // 普通可打印字符
        undoStack.push(buffer);
        const char = chunk.toString("utf-8");
        buffer += char;
        process.stdout.write(char);                // 回显
      }
    };
    
    process.stdin.on("data", handler);
  });
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