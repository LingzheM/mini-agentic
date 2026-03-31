// 放在任意一个 exp*.ts 里替换 rl.question()
export async function readInput(prompt: string): Promise<string> {
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