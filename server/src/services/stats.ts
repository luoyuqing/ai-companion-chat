/**
 * 聊天统计累加器。
 *
 * 设计要点（与「清除记忆/聊天保留统计、单角色可重置、删除角色才清」的需求对齐）：
 * - 统计使用独立的 stats.json 累加器，而非从会话派生，避免「清除记忆」误伤统计。
 * - 每次聊天回合（user 消息轮次）与每次成功生图回发时累加，数据实时落盘。
 * - 首次启动 best-effort 从历史会话反推历史聊天轮次作为种子（dailyChat 按会话 updatedAt 分布）。
 *   生图历史无可靠来源，不回填（从历史 0 计起）。
 * - stats.json 已加入 .gitignore，绝不入库。
 */

import { existsSync, readFileSync, writeFileSync, readdirSync, mkdirSync } from "fs";
import { join } from "path";
import { DATA_DIR } from "../core/data";

export type Channel = "web" | "tg";

export interface ChannelCount {
  web: number;
  tg: number;
}

export interface CharacterStat {
  /** 聊天轮次（按 user 消息计），分渠道 */
  chat: ChannelCount;
  /** 成功生图并回发次数，分渠道（仅 TG 端有生图） */
  photo: ChannelCount;
  /** 每日聊天轮次（按 Asia/Shanghai 日期 YYYY-MM-DD 为键），用于折线图 */
  dailyChat: Record<string, number>;
}

export interface StatsData {
  version: number;
  /** 是否已执行过历史会话回填，防止重复回填 */
  backfilled: boolean;
  characters: Record<string, CharacterStat>;
}

export interface CharacterStatView extends CharacterStat {
  id: string;
}

export interface StatsOverview {
  totalChat: number;
  totalPhoto: number;
  characters: CharacterStatView[];
}

const STATS_FILE = join(DATA_DIR, "stats.json");

function emptyChannelCount(): ChannelCount {
  return { web: 0, tg: 0 };
}

function defaultData(): StatsData {
  return { version: 1, backfilled: false, characters: {} };
}

let cache: StatsData | null = null;

function loadStats(): StatsData {
  if (cache) return cache;
  try {
    if (existsSync(STATS_FILE)) {
      const raw = readFileSync(STATS_FILE, "utf8");
      const parsed = JSON.parse(raw) as Partial<StatsData>;
      cache = {
        version: parsed.version ?? 1,
        backfilled: Boolean(parsed.backfilled),
        characters: parsed.characters && typeof parsed.characters === "object" ? (parsed.characters as Record<string, CharacterStat>) : {}
      };
      return cache;
    }
  } catch (err) {
    console.error("[stats] 读取 stats.json 失败，将重建：", err instanceof Error ? err.message : err);
  }
  cache = defaultData();
  return cache;
}

function saveStats(data: StatsData): void {
  try {
    if (!existsSync(DATA_DIR)) {
      // 复刻数据目录（与 session.ts 行为一致）
      mkdirSync(DATA_DIR, { recursive: true });
    }
    writeFileSync(STATS_FILE, JSON.stringify(data, null, 2), "utf8");
  } catch (err) {
    console.error("[stats] 写入 stats.json 失败：", err instanceof Error ? err.message : err);
  }
}

function ensureChar(data: StatsData, id: string): CharacterStat {
  let c = data.characters[id];
  if (!c) {
    c = { chat: emptyChannelCount(), photo: emptyChannelCount(), dailyChat: {} };
    data.characters[id] = c;
  }
  return c;
}

/** 当前 Asia/Shanghai 日期 YYYY-MM-DD */
function todayKey(d: Date = new Date()): string {
  try {
    return new Intl.DateTimeFormat("sv-SE", {
      timeZone: "Asia/Shanghai",
      year: "numeric",
      month: "2-digit",
      day: "2-digit"
    }).format(d);
  } catch {
    return d.toISOString().slice(0, 10);
  }
}

/** 从会话 ID 推断角色 ID：mem-<id>(网页) / mem:<id>(TG 属主) / tg-<chatId>-<id>(TG) */
function characterIdFromSessionId(sid: string): string | null {
  if (!sid) return null;
  if (sid.startsWith("mem-")) return sid.slice("mem-".length);
  if (sid.startsWith("mem:")) return sid.slice("mem:".length);
  if (sid.startsWith("tg-")) {
    const parts = sid.split("-");
    // tg-<chatId>-<id...>：角色 ID 可能含连字符（如 custom-<timestamp>）
    return parts.slice(2).join("-") || null;
  }
  return null;
}

/** 从会话 ID 推断渠道：tg- 与 mem: 视为 TG，mem- 视为网页 */
function channelFromSessionId(sid: string): Channel {
  if (sid.startsWith("tg-") || sid.startsWith("mem:")) return "tg";
  return "web";
}

// ---------- 公开 API ----------

export function recordChat(characterId: string, channel: Channel): void {
  if (!characterId) return;
  const data = loadStats();
  const c = ensureChar(data, characterId);
  c.chat[channel] += 1;
  const key = todayKey();
  c.dailyChat[key] = (c.dailyChat[key] || 0) + 1;
  saveStats(data);
}

export function recordPhoto(characterId: string, channel: Channel): void {
  if (!characterId) return;
  const data = loadStats();
  const c = ensureChar(data, characterId);
  c.photo[channel] += 1;
  saveStats(data);
}

export function getStatsOverview(): StatsOverview {
  const data = loadStats();
  const characters: CharacterStatView[] = Object.keys(data.characters).map((id) => ({
    id,
    chat: data.characters[id].chat,
    photo: data.characters[id].photo,
    dailyChat: data.characters[id].dailyChat
  }));
  let totalChat = 0;
  let totalPhoto = 0;
  for (const c of characters) {
    totalChat += c.chat.web + c.chat.tg;
    totalPhoto += c.photo.web + c.photo.tg;
  }
  return { totalChat, totalPhoto, characters };
}

/** 重置某角色统计为 0（保留条目，dailyChat 清空）。用于「单角色重置统计」按钮。 */
export function resetCharacterStats(characterId: string): void {
  if (!characterId) return;
  const data = loadStats();
  data.characters[characterId] = { chat: emptyChannelCount(), photo: emptyChannelCount(), dailyChat: {} };
  saveStats(data);
}

/** 删除某角色的统计条目。仅在「删除整个数字人」时调用。 */
export function deleteCharacterStats(characterId: string): void {
  if (!characterId) return;
  const data = loadStats();
  if (data.characters[characterId]) {
    delete data.characters[characterId];
    saveStats(data);
  }
}

/**
 * 首启从历史会话 best-effort 回填聊天轮次：
 * - 每个会话统计 history 中 role:user 的条数作为该角色聊天轮次。
 * - 按会话 ID 推断角色与渠道；按会话 updatedAt（UTC 日期）分布到 dailyChat。
 * 仅执行一次（backfilled=true 后跳过），幂等。
 */
export function backfillFromSessions(): void {
  const data = loadStats();
  if (data.backfilled) return;
  try {
    const sessionDir = join(DATA_DIR, "sessions");
    if (existsSync(sessionDir)) {
      const files = readdirSync(sessionDir).filter((f) => f.endsWith(".json"));
      for (const f of files) {
        try {
          const raw = readFileSync(join(sessionDir, f), "utf8");
          const sess = JSON.parse(raw) as {
            sessionId?: string;
            updatedAt?: string;
            createdAt?: string;
            history?: Array<{ role?: string }>;
          };
          const sid = sess.sessionId || f.replace(/\.json$/, "");
          const cid = characterIdFromSessionId(sid);
          if (!cid) continue;
          const userCount = (sess.history || []).filter((m) => m.role === "user").length;
          if (userCount <= 0) continue;
          const dateKey = (sess.updatedAt || sess.createdAt || "").slice(0, 10) || todayKey();
          const channel = channelFromSessionId(sid);
          const c = ensureChar(data, cid);
          c.chat[channel] += userCount;
          c.dailyChat[dateKey] = (c.dailyChat[dateKey] || 0) + userCount;
        } catch (err) {
          console.error(`[stats] 回填会话 ${f} 失败，跳过：`, err instanceof Error ? err.message : err);
        }
      }
    }
  } catch (err) {
    console.error("[stats] 历史会话回填失败：", err instanceof Error ? err.message : err);
  }
  data.backfilled = true;
  saveStats(data);
  console.log("[stats] 历史会话回填完成");
}

/** 启动时调用：未回填则执行一次回填。 */
export function ensureBackfilled(): void {
  const data = loadStats();
  if (!data.backfilled) {
    backfillFromSessions();
  }
}
