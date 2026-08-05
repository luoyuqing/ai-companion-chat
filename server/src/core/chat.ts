import { askAssistant, summarizeConversation } from "../services/llm";
import {
  appendToSession,
  buildSessionContext,
  loadSession,
  makeSessionId,
  updateSessionMeta
} from "../services/session";
import { recordChat, recordToken, recordApiCall } from "../services/stats";
import { getUserMemory, saveUserMemory, formatUserMemorySystemContent } from "../services/userMemory";
import { getCharacters, resolveCharacter } from "./data";
import { markUserActivity } from "./activity";
import {
  buildSceneSystemMessage,
  buildStyleSystemMessage,
  CompanionSceneId,
  getDefaultResponseStyle,
  getDefaultScene,
  getResponseStyleById,
  getSceneById,
  isCompanionSceneId,
  isResponseStyleId,
  ResponseStyleId
} from "./scenes";
import { ChatMessage, DigitalHumanConfig, RelationshipMode, SessionContext } from "../types";
import { SessionRecord } from "../services/session";

export interface ChatResult {
  sessionId: string;
  character: DigitalHumanConfig;
  text: string;
  emotion: string;
  context?: SessionContext;
}

// 总结模式参数：控制每轮发给模型的上下文规模
const RECENT_WINDOW = 12; // 每次携带给模型的最近消息条数（user+assistant 合计）
const SUMMARY_THRESHOLD = 12; // 历史达到多少条后首次生成记忆档案
const SUMMARY_INTERVAL = 16; // 之后每新增多少条重新生成一次档案

export function isSummaryModeEnabled(flag?: boolean): boolean {
  if (typeof flag === "boolean") return flag;
  return String(process.env.SUMMARY_MODE || "false").toLowerCase() === "true";
}

/**
 * 判断是否需要重新生成记忆档案。
 * - 历史不足阈值：不生成
 * - 尚无档案：达到阈值即生成
 * - 已有档案：之后每隔 SUMMARY_INTERVAL 条重新生成一次
 */
export function shouldSummarize(totalMessages: number, hasMemory: boolean): boolean {
  if (totalMessages < SUMMARY_THRESHOLD) return false;
  if (!hasMemory) return true;
  return (totalMessages - SUMMARY_THRESHOLD) % SUMMARY_INTERVAL === 0;
}

// 把 Unix 毫秒时间戳格式化为「2026-08-03 周一 21:14」可读串（统一 Asia/Shanghai，与实时块一致）；无值回退"时间未知"。
export function formatMsgTimestamp(ts?: number): string {
  if (!ts || !Number.isFinite(ts)) return "时间未知";
  const d = new Date(ts);
  const fmt = new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });
  const p: Record<string, string> = {};
  for (const part of fmt.formatToParts(d)) p[part.type] = part.value;
  return `${p.year}-${p.month}-${p.day} ${p.weekday} ${p.hour}:${p.minute}`;
}

// 给一条历史消息加「（用户·时间）」前缀，让模型感知其真实发生时刻；系统消息与时间未知者原样保留。
export function withTimestampPrefix(m: ChatMessage): ChatMessage {
  if (m.role === "system") return m;
  const who = m.role === "user" ? "用户" : "助手";
  return { ...m, content: `（${who}·${formatMsgTimestamp(m.ts)}）${m.content}` };
}

/**
 * 构造实际发给模型的对话历史：
 * - 总结模式关闭：原样返回（场景系统消息在前）
 * - 总结模式开启：保留全部系统消息（场景/语气提示），追加记忆档案系统消息，
 *   再只带最近 RECENT_WINDOW 条 user/assistant 消息，从而把上下文长度稳定在上限内。
 */
export function buildModelHistory(params: {
  history: ChatMessage[];
  summaryMode: boolean;
  memoryFile?: string;
  recentWindow?: number;
  sceneMessages?: ChatMessage[];
}): ChatMessage[] {
  const sceneMessages = params.sceneMessages ?? [];
  if (!params.summaryMode) {
    return [...sceneMessages, ...params.history.map(withTimestampPrefix)];
  }
  const recents = params.history
    .filter((m) => m.role !== "system")
    .slice(-(params.recentWindow ?? RECENT_WINDOW));
  const result: ChatMessage[] = [...sceneMessages];
  if (params.memoryFile && params.memoryFile.trim()) {
    result.push({
      role: "system",
      content: `长期记忆档案（据此延续对话，无需向用户复述档案内容）：\n${params.memoryFile}`
    });
  }
  result.push(...recents.map(withTimestampPrefix));
  return result;
}

/** 回合结束后按需重新生成记忆档案（仅总结模式且达到触发条件时）。 */
export async function maybeSummarize(
  session: SessionRecord,
  character: DigitalHumanConfig
): Promise<void> {
  if (!shouldSummarize(session.history.length, Boolean(session.memoryFile))) return;
  const memory = await summarizeConversation(character, session.history, session.memoryFile);
  await updateSessionMeta(session.sessionId, { memoryFile: memory });
}

/** 立即为某个会话生成记忆档案（用于开启总结模式时一次性产出）。 */
export async function generateMemoryForSession(
  sessionId: string,
  character: DigitalHumanConfig
): Promise<string> {
  const session = await loadSession(sessionId);
  if (!session) return "";
  const memory = await summarizeConversation(character, session.history, session.memoryFile);
  await updateSessionMeta(sessionId, { memoryFile: memory });
  return memory;
}

/**
 * 一次完整的对话回合：加载会话历史 → 生成回复 → 更新并落盘会话上下文。
 * 被 HTTP /api/chat 与 Telegram bot 共用，保证网页端与 TG 端行为一致。
 */
export async function runChat(opts: {
  sessionId?: string;
  message: string;
  characterId?: string;
  relationshipMode?: RelationshipMode;
  sceneId?: CompanionSceneId;
  styleId?: ResponseStyleId;
  adultVerified?: boolean;
  /** 来源渠道：网页端 web / Telegram 端 tg（用于统计分渠道计数） */
  channel?: "web" | "tg";
}): Promise<ChatResult> {
  const sessionId = (opts.sessionId && String(opts.sessionId).trim()) || makeSessionId();
  const message = String(opts.message || "").trim();
  if (!message) {
    throw new Error("message is required");
  }

  const characters = await getCharacters();
  const character = resolveCharacter(characters, opts.characterId);
  if (!character) {
    throw new Error("未配置数字人");
  }

  const existingSession = await loadSession(sessionId);
  const history = (existingSession?.history ?? []) as ChatMessage[];
  const summaryMode = isSummaryModeEnabled(existingSession?.summaryMode);

  // 注入场景与语气系统提示（仅 Telegram bot 等显式传入时生效；网页端仍由前端构造）
  const systemMessages: ChatMessage[] = [];
  const sceneId = isCompanionSceneId(opts.sceneId) ? opts.sceneId : undefined;
  const styleId = isResponseStyleId(opts.styleId) ? opts.styleId : undefined;
  if (sceneId) {
    const scene = getSceneById(sceneId) ?? getDefaultScene();
    systemMessages.push(buildSceneSystemMessage(scene, character, opts.adultVerified));
  }
  if (styleId) {
    const style = getResponseStyleById(styleId) ?? getDefaultResponseStyle();
    systemMessages.push(buildStyleSystemMessage(style));
  }

  // B4：跨会话时间锚点——让数字人感知"上次聊天发生在何时"，并刷新本次聊天时间为真实时刻
  const memBefore = await getUserMemory(character.id);
  if (memBefore.lastChatAt) {
    const lastStr = formatMsgTimestamp(Date.parse(memBefore.lastChatAt));
    systemMessages.push({
      role: "system",
      content: `【对话时间锚点】你与用户的上一次聊天发生在 ${lastStr}。若用户提及"上次/昨天/前天"等，以此为参照，不要臆造时间。`
    });
  }
  // B 类长期记忆（提升为 A 类：后端统一注入，TG 与非流式网页端均生效，双端一致）
  const memoryContent = formatUserMemorySystemContent(memBefore, character.name);
  if (memoryContent) {
    systemMessages.push({ role: "system", content: memoryContent });
  }
  await saveUserMemory(character.id, { ...memBefore, lastChatAt: new Date().toISOString() });

  // 总结模式下只把「记忆档案 + 最近窗口」发给模型，避免短上下文模型超限
  const modelHistory = buildModelHistory({
    history,
    summaryMode,
    memoryFile: existingSession?.memoryFile,
    sceneMessages: systemMessages
  });
  const answer = await askAssistant(
    modelHistory,
    character,
    message,
    existingSession?.context,
    opts.relationshipMode
  );

  const nextContext = buildSessionContext(existingSession, message, answer.text, opts.relationshipMode);
  await appendToSession(sessionId, { role: "user", content: message }, nextContext);
  markUserActivity(character.id); // 用户主动发消息 → 标记活跃，抑制主动推送
  const saved = await appendToSession(sessionId, { role: "assistant", content: answer.text }, nextContext);
  recordChat(character.id, opts.channel ?? "web"); // 统计：每轮 user 消息 +1（分渠道）
  // 统计：LLM token 消耗与 API 请求次数（仅真实 LLM 请求计入，本地兜底不计入）
  if (answer.calledApi) recordApiCall(character.id, opts.channel ?? "web");
  if (answer.usage) recordToken(character.id, opts.channel ?? "web", answer.usage.promptTokens, answer.usage.completionTokens);

  // 总结模式：回合结束后按需重新生成记忆档案（记忆随对话持续压缩更新）
  if (summaryMode) {
    await maybeSummarize(saved, character);
  }

  return {
    sessionId,
    character,
    text: answer.text,
    emotion: answer.emotion,
    context: nextContext
  };
}
