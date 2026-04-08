/**
 * ═══════════════════════════════════════════════════════════
 *  session.ts — "日记本"：让对话在重启后活下来
 * ═══════════════════════════════════════════════════════════
 *
 *  Phase 7 核心问题：关掉终端 ≠ 忘记一切。
 *
 *  到 Phase 6 为止，你关掉程序就什么都没了。
 *  用户明天回来，得从头解释项目背景。
 *
 *  解决方案很简单：
 *    - 把 conversationHistory 序列化成 JSON 文件
 *    - 保存在项目目录的 .mini-claude/ 下
 *    - 启动时检查有没有最近的 session，有就加载
 *
 *  设计决策：
 *    1. 每个 session 一个文件，文件名包含时间戳
 *    2. 每次用户输入后自动保存（不是退出时才存）
 *       → 意外 crash 也不会丢失进度
 *    3. 不保存 system prompt（每次启动重新构建更好）
 *       → 因为项目环境可能变了
 *    4. session 文件和项目绑定（存在 CWD/.mini-claude/ 下）
 *       → 不同项目不同 session
 */

import { readFile, writeFile, mkdir, readdir, stat } from "fs/promises";
import { existsSync } from "fs";
import * as path from "path";
import type { Message } from "./llm.js";

// ──────────────────────────────────────────────
// 配置
// ──────────────────────────────────────────────

const SESSION_DIR = ".mini-claude";
const MAX_SESSIONS = 20; // 保留最近 20 个 session，旧的自动删

// ──────────────────────────────────────────────
// Session 元数据
// ──────────────────────────────────────────────

interface SessionFile {
  /** 格式版本——未来改格式时向后兼容 */
  version: 1;
  /** session 创建时间 */
  createdAt: string;
  /** 最后更新时间 */
  updatedAt: string;
  /** 对话消息（不含 system prompt） */
  messages: Message[];
  /** 对话摘要（第一个用户消息的前 80 字符） */
  summary: string;
}

/** 返回给调用者的 session 信息 */
export interface SessionInfo {
  id: string;
  filePath: string;
  createdAt: Date;
  updatedAt: Date;
  summary: string;
  messageCount: number;
}

// ──────────────────────────────────────────────
// 核心操作
// ──────────────────────────────────────────────

/** 确保 session 目录存在 */
async function ensureSessionDir(): Promise<string> {
  const dir = path.join(process.cwd(), SESSION_DIR);
  await mkdir(dir, { recursive: true });
  return dir;
}

/** 生成 session ID：时间戳 + 随机后缀 */
function generateSessionId(): string {
  const now = new Date();
  const ts = now.toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const rand = Math.random().toString(36).slice(2, 6);
  return `${ts}_${rand}`;
}

/**
 * 保存 session。
 *
 * 设计：不保存 system prompt（messages[0]）。
 * 原因：system prompt 每次启动时动态构建（Phase 5）。
 * 如果项目环境变了（新依赖、改了 CLAUDE.md），
 * 上次的 system prompt 就是过时的。
 * 重新构建更安全。
 */
export async function saveSession(
  sessionId: string,
  messages: Message[],
  createdAt: string
): Promise<void> {
  const dir = await ensureSessionDir();

  // 跳过 system prompt（index 0）
  const toSave = messages.slice(1);
  if (toSave.length === 0) return; // 空会话不保存

  // 第一个用户消息作为摘要
  const firstUserMsg = toSave.find((m) => m.role === "user");
  const summary = firstUserMsg
    ? firstUserMsg.content.slice(0, 80).replace(/\n/g, " ")
    : "(empty)";

  const sessionFile: SessionFile = {
    version: 1,
    createdAt,
    updatedAt: new Date().toISOString(),
    messages: toSave,
    summary,
  };

  const filePath = path.join(dir, `${sessionId}.json`);
  await writeFile(filePath, JSON.stringify(sessionFile, null, 2), "utf-8");
}

/**
 * 加载一个 session。
 *
 * 返回消息数组（不含 system prompt——调用者要自己加）。
 */
export async function loadSession(
  sessionId: string
): Promise<Message[] | null> {
  const dir = path.join(process.cwd(), SESSION_DIR);
  const filePath = path.join(dir, `${sessionId}.json`);

  if (!existsSync(filePath)) return null;

  try {
    const raw = await readFile(filePath, "utf-8");
    const data = JSON.parse(raw) as SessionFile;

    if (data.version !== 1) {
      console.error(`Unknown session version: ${data.version}`);
      return null;
    }

    return data.messages;
  } catch (err) {
    console.error(`Failed to load session: ${(err as Error).message}`);
    return null;
  }
}

/**
 * 列出所有 session，按更新时间倒序。
 */
export async function listSessions(): Promise<SessionInfo[]> {
  const dir = path.join(process.cwd(), SESSION_DIR);
  if (!existsSync(dir)) return [];

  const files = await readdir(dir);
  const sessions: SessionInfo[] = [];

  for (const file of files) {
    if (!file.endsWith(".json")) continue;

    const filePath = path.join(dir, file);
    try {
      const raw = await readFile(filePath, "utf-8");
      const data = JSON.parse(raw) as SessionFile;

      sessions.push({
        id: file.replace(".json", ""),
        filePath,
        createdAt: new Date(data.createdAt),
        updatedAt: new Date(data.updatedAt),
        summary: data.summary,
        messageCount: data.messages.length,
      });
    } catch {
      // 损坏的 session 文件，跳过
    }
  }

  // 按更新时间倒序
  sessions.sort((a, b) => b.updatedAt.getTime() - a.updatedAt.getTime());
  return sessions;
}

/**
 * 获取最近一个 session 的 ID（用于 --resume）。
 */
export async function getLatestSessionId(): Promise<string | null> {
  const sessions = await listSessions();
  return sessions.length > 0 ? sessions[0].id : null;
}

/**
 * 清理旧 session，只保留最近 N 个。
 */
export async function cleanOldSessions(): Promise<number> {
  const sessions = await listSessions();
  if (sessions.length <= MAX_SESSIONS) return 0;

  const toDelete = sessions.slice(MAX_SESSIONS);
  let deleted = 0;

  for (const session of toDelete) {
    try {
      const { unlink } = await import("fs/promises");
      await unlink(session.filePath);
      deleted++;
    } catch {
      // 删除失败不致命
    }
  }

  return deleted;
}