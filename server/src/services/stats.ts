/**
 * 聊天统计累加器。
 *
 * 设计要点（与「清除记忆/聊天保留统计、单角色可重置、删除角色才清」的需求对齐）：
 * - 统计使用独立的 stats.json 累加器，而非从会话派生，避免「清除记忆」误伤统计。
 * - 每次聊天回合（user 消息轮次）与每次成功生图回发时累加，数据实时落盘。
 * - 首次启动 best-effort 从历史会话反推历史聊天轮次作为种子。
 *   历史回填采用「方案 A + X」：历史会话（mem-/tg-/mem: 前缀）一律归为 TG 渠道（属主主要用 TG）；
 *   按会话 createdAt→updatedAt 的活跃自然日区间将轮次均摊到 dailyChat（方案 X，避免全部塌缩到首日）。
 *   生图历史无可靠来源，不回填。
 * - 通过 backfillVersion 控制回填版本：版本升级时启动自动重跑（重跑前保留实时生图计数，清空聊天计数重算）。
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

export interface TokenCount {
  input: number;
  output: number;
}

export interface CharacterStat {
  /** 聊天轮次（按 user 消息计），分渠道 */
  chat: ChannelCount;
  /** 成功生图并回发次数，分渠道（仅 TG 端有生图） */
  photo: ChannelCount;
  /** 每日聊天轮次（按 Asia/Shanghai 日期 YYYY-MM-DD 为键），用于折线图 */
  dailyChat: Record<string, number>;
  /** LLM token 消耗（仅聊天每轮 1 次 LLM 请求），分输入/输出，不回填历史 */
  tokens: TokenCount;
  /** LLM API 请求次数（每轮 1 次），分渠道 */
  apiCalls: ChannelCount;
  /** 每日 LLM token 消耗（按 Asia/Shanghai 日期 YYYY-MM-DD 为键），用于折线图 */
  dailyToken: Record<string, TokenCount>;
}

export interface StatsData {
  version: number;
  /** 是否已执行过历史会话回填 */
  backfilled: boolean;
  /** 历史回填逻辑版本号；低于 CURRENT_BACKFILL_VERSION 时启动会重跑 */
  backfillVersion: number;
  characters: Record<string, CharacterStat>;
}

export interface CharacterStatView extends CharacterStat {
  id: string;
}

export interface StatsOverview {
  totalChat: number;
  totalPhoto: number;
  totalTokenInput: number;
  totalTokenOutput: number;
  totalApi: number;
  characters: CharacterStatView[];
}

const STATS_FILE = join(DATA_DIR, "stats.json");

/** 当前回填逻辑版本。改动回填口径（渠道/日期规则）时递增，触发启动重跑。 */
// 历史：1=初版(updatedAt) → 2=方案A(全归tg+createdAt) → 3=方案X(按活跃区间均摊)
const CURRENT_BACKFILL_VERSION = 3;

function emptyChannelCount(): ChannelCount {
  return { web: 0, tg: 0 };
}

function emptyTokenCount(): TokenCount {
  return { input: 0, output: 0 };
}

function defaultData(): StatsData {
  return { version: 1, backfilled: false, backfillVersion: 0, characters: {} };
}

let cache: StatsData | null = null;

function loadStats(): StatsData {
  if (cache) return cache;
  try {
    if (existsSync(STATS_FILE)) {
      const raw = readFileSync(STATS_FILE, "utf8");
      const parsed = JSON.parse(raw) as Partial<StatsData>;
      const rawChars =
        parsed.characters && typeof parsed.characters === "object"
          ? (parsed.characters as Record<string, CharacterStat>)
          : {};
      // 兼容升级前的 stats.json：补齐 tokens / apiCalls / dailyToken 字段，避免读取时 undefined
      for (const cid of Object.keys(rawChars)) {
        const c = rawChars[cid];
        c.chat = c.chat || emptyChannelCount();
        c.photo = c.photo || emptyChannelCount();
        c.tokens = c.tokens || emptyTokenCount();
        c.apiCalls = c.apiCalls || emptyChannelCount();
        c.dailyChat = c.dailyChat || {};
        c.dailyToken = c.dailyToken || {};
      }
      cache = {
        version: parsed.version ?? 1,
        backfilled: Boolean(parsed.backfilled),
        backfillVersion: typeof parsed.backfillVersion === "number" ? parsed.backfillVersion : 0,
        characters: rawChars
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
    c = {
      chat: emptyChannelCount(),
      photo: emptyChannelCount(),
      tokens: emptyTokenCount(),
      apiCalls: emptyChannelCount(),
      dailyChat: {},
      dailyToken: {}
    };
    data.characters[id] = c;
  } else {
    // 兼容旧数据（升级前 stats.json 无 tokens/apiCalls/dailyToken）
    if (!c.tokens) c.tokens = emptyTokenCount();
    if (!c.apiCalls) c.apiCalls = emptyChannelCount();
    if (!c.dailyToken) c.dailyToken = {};
  }
  return c;
}

/** 当前（或指定）时刻的 Asia/Shanghai 日期 YYYY-MM-DD */
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

/** 从 UTC ISO 时间戳取 Asia/Shanghai 日期；解析失败返回空串 */
function dateKeyFromISO(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  if (isNaN(d.getTime())) return "";
  return todayKey(d);
}

/** 两个 YYYY-MM-DD 之间的自然日数（含端点）。同日返回 1。 */
function daysBetweenInclusive(a: string, b: string): number {
  const [ay, am, ad] = a.split("-").map(Number);
  const [by, bm, bd] = b.split("-").map(Number);
  const da = Date.UTC(ay, am - 1, ad);
  const db = Date.UTC(by, bm - 1, bd);
  return Math.max(1, Math.round((db - da) / 86400000) + 1);
}

/** 对 YYYY-MM-DD 做纯日历 +n 天（UTC 算术，避免时区偏移），返回 YYYY-MM-DD。 */
function addDaysKey(key: string, n: number): string {
  const [y, m, d] = key.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + n);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, "0");
  const dd = String(dt.getUTCDate()).padStart(2, "0");
  return `${yy}-${mm}-${dd}`;
}

/** 从会话 ID 推断角色 ID：mem-<id> / mem:<id>(TG 属主) / tg-<chatId>-<id>(TG) */
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

/** 记录一次 LLM 请求消耗的 token（输入/输出）。仅在确有真实 LLM 用量时调用；无历史回填。 */
export function recordToken(characterId: string, channel: Channel, input: number, output: number): void {
  if (!characterId) return;
  if (!Number.isFinite(input) || !Number.isFinite(output) || (input <= 0 && output <= 0)) return;
  const data = loadStats();
  const c = ensureChar(data, characterId);
  c.tokens.input += input;
  c.tokens.output += output;
  const key = todayKey();
  if (!c.dailyToken[key]) c.dailyToken[key] = { input: 0, output: 0 };
  c.dailyToken[key].input += input;
  c.dailyToken[key].output += output;
  saveStats(data);
}

/** 记录一次 LLM API 请求（每轮聊天 1 次）。 */
export function recordApiCall(characterId: string, channel: Channel): void {
  if (!characterId) return;
  const data = loadStats();
  const c = ensureChar(data, characterId);
  c.apiCalls[channel] += 1;
  saveStats(data);
}

export function getStatsOverview(): StatsOverview {
  const data = loadStats();
  const characters: CharacterStatView[] = Object.keys(data.characters).map((id) => {
    const c = data.characters[id];
    return {
      id,
      chat: c.chat,
      photo: c.photo,
      tokens: c.tokens,
      apiCalls: c.apiCalls,
      dailyChat: c.dailyChat,
      dailyToken: c.dailyToken
    };
  });
  let totalChat = 0;
  let totalPhoto = 0;
  let totalTokenInput = 0;
  let totalTokenOutput = 0;
  let totalApi = 0;
  for (const c of characters) {
    totalChat += c.chat.web + c.chat.tg;
    totalPhoto += c.photo.web + c.photo.tg;
    totalTokenInput += c.tokens.input;
    totalTokenOutput += c.tokens.output;
    totalApi += c.apiCalls.web + c.apiCalls.tg;
  }
  return { totalChat, totalPhoto, totalTokenInput, totalTokenOutput, totalApi, characters };
}

/** 重置某角色统计为 0（保留条目，dailyChat 清空）。用于「单角色重置统计」按钮。 */
export function resetCharacterStats(characterId: string): void {
  if (!characterId) return;
  const data = loadStats();
  data.characters[characterId] = {
    chat: emptyChannelCount(),
    photo: emptyChannelCount(),
    tokens: emptyTokenCount(),
    apiCalls: emptyChannelCount(),
    dailyChat: {},
    dailyToken: {}
  };
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
 * 从历史会话回填聊天轮次（方案 A + X）。
 * - 重跑前快照并保留已累积的生图计数（生图仅来自实时回发，无法从历史会话反推）；
 *   清空各角色 chat / dailyChat，以 session 历史为准重新计算（幂等，重跑后实时计数继续累积）。
 * - 每个会话统计 history 中 role:user 的条数作为该角色聊天轮次（总量计入渠道）。
 * - 渠道：历史 mem-/tg-/mem: 一律归 TG（属主主要使用 TG）。
 * - 日期（方案 X）：按会话 createdAt→updatedAt 的活跃自然日区间，将轮次均摊到每日
 *   （整数按「每日基础量 + 前 remainder 天各 +1」分配，单日会话退化为原逻辑），统一 Asia/Shanghai 日期。
 */
export function backfillFromSessions(): void {
  const data = loadStats();
  // 快照当前生图计数（不可从历史反推，须保留）
  const preservedPhoto: Record<string, ChannelCount> = {};
  for (const id of Object.keys(data.characters)) {
    preservedPhoto[id] = { ...data.characters[id].photo };
  }
  // 重置聊天计数与每日序列（以 session 历史为准）
  for (const id of Object.keys(data.characters)) {
    data.characters[id].chat = emptyChannelCount();
    data.characters[id].dailyChat = {};
  }
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
          const channel: Channel = "tg"; // 方案 A：历史会话全部归 TG
          const c = ensureChar(data, cid);
          c.photo = preservedPhoto[cid] || emptyChannelCount();
          c.chat[channel] += userCount;
          // 方案 X：按会话活跃自然日区间（createdAt→updatedAt）均摊轮次，避免全部塌缩到首日
          const startKey = dateKeyFromISO(sess.createdAt) || dateKeyFromISO(sess.updatedAt) || todayKey();
          const endKey = dateKeyFromISO(sess.updatedAt) || dateKeyFromISO(sess.createdAt) || todayKey();
          const days = daysBetweenInclusive(startKey, endKey);
          const perDay = Math.floor(userCount / days);
          const remainder = userCount % days;
          for (let i = 0; i < days; i++) {
            const k = addDaysKey(startKey, i);
            const add = perDay + (i < remainder ? 1 : 0);
            c.dailyChat[k] = (c.dailyChat[k] || 0) + add;
          }
        } catch (err) {
          console.error(`[stats] 回填会话 ${f} 失败，跳过：`, err instanceof Error ? err.message : err);
        }
      }
    }
  } catch (err) {
    console.error("[stats] 历史会话回填失败：", err instanceof Error ? err.message : err);
  }
  data.backfilled = true;
  data.backfillVersion = CURRENT_BACKFILL_VERSION;
  saveStats(data);
  console.log(`[stats] 历史会话回填完成 (backfillVersion ${CURRENT_BACKFILL_VERSION})`);
}

/** 启动时调用：未回填或回填版本落后则重跑。 */
export function ensureBackfilled(): void {
  const data = loadStats();
  if (!data.backfilled || (data.backfillVersion ?? 0) < CURRENT_BACKFILL_VERSION) {
    backfillFromSessions();
  }
}
