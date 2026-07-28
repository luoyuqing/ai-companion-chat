import fs from "node:fs/promises";
import path from "node:path";
import crypto from "node:crypto";

import { ChatMessage, Emotion, RelationshipMode, SessionContext } from "../types";

const WORKSPACE_ROOT =
  path.basename(process.cwd()) === "server" ? path.resolve(process.cwd(), "..") : process.cwd();

export interface SessionRecord {
  sessionId: string;
  createdAt: string;
  updatedAt: string;
  history: ChatMessage[];
  context?: SessionContext;
}

const SESSION_DIR = path.join(WORKSPACE_ROOT, "server", "src", "data", "sessions");
const MAX_TURNS_PER_SESSION = 200;
const MAX_SIGNAL_COUNT = 4;

const AFFINITY_BOOST_KEYWORDS: Record<SessionContext["relationshipAffinity"], string[]> = {
  new: [],
  warm: ["可爱", "挺好", "谢谢你", "谢谢", "你很", "很甜", "好听", "好看"],
  close: ["想你", "宝贝", "亲亲", "抱抱", "爱你", "想念", "想聊", "特别"],
  intimate: ["我想你", "离不开", "更进一步", "亲爱", "在一起", "亲密", "不离开"]
};

const ANCHOR_KEYWORDS: string[] = [
  "工作", "学习", "压力", "烦", "情绪", "失落", "焦虑", "恋爱", "电影", "音乐", "旅行", "美食", "运动"
];

function toSafeAffinity(value: number): SessionContext["relationshipAffinity"] {
  if (value >= 3) return "intimate";
  if (value >= 2) return "close";
  if (value >= 1) return "warm";
  return "new";
}

function normalizeText(text: string): string {
  return String(text || "")
    .toLowerCase()
    .trim();
}

function inferEmotionFromText(text: string): Emotion {
  const lowered = normalizeText(text);
  if (["喜欢", "爱", "喜欢你", "抱抱", "宝贝", "亲", "想你", "亲爱"].some((w) => lowered.includes(w))) {
    return "love";
  }
  if (["生气", "讨厌", "烦", "气死", "烦躁", "不好", "不爽"].some((w) => lowered.includes(w))) {
    return "angry";
  }
  if (["难过", "伤心", "失落", "失望", "委屈", "伤感"].some((w) => lowered.includes(w))) {
    return "sad";
  }
  if (["哈哈", "好笑", "有趣", "开心", "棒", "nice", "great"].some((w) => lowered.includes(w))) {
    return "happy";
  }
  if (["惊讶", "天啊", "真的吗", "没想到", "意外", "wow", "哇"].some((w) => lowered.includes(w))) {
    return "surprise";
  }
  if (["wink", "撩", "俏皮", "坏", "调皮", "撒娇", "开玩笑"].some((w) => lowered.includes(w))) {
    return "wink";
  }
  return "neutral";
}

function normalizeRelationshipMode(mode: unknown): RelationshipMode | undefined {
  if (mode === "sweet" || mode === "flirty" || mode === "playful" || mode === "mature") {
    return mode;
  }
  return undefined;
}

function scoreAffinity(context: SessionContext, userText: string, assistantText: string): number {
  const user = normalizeText(userText);
  const assistant = normalizeText(assistantText);
  let score = context.relationshipAffinity === "new" ? 0 : context.relationshipAffinity === "warm" ? 1 : context.relationshipAffinity === "close" ? 2 : 3;

  const hasAny = (source: string, list: string[]) => list.some((keyword) => source.includes(keyword.toLowerCase()));

  if (hasAny(user, AFFINITY_BOOST_KEYWORDS.close) || hasAny(assistant, AFFINITY_BOOST_KEYWORDS.close)) {
    score += 1;
  }
  if (hasAny(user, AFFINITY_BOOST_KEYWORDS.intimate) || hasAny(assistant, AFFINITY_BOOST_KEYWORDS.intimate)) {
    score += 1;
  }
  if (["不想聊", "先别聊", "我走", "再见", "拜拜", "不要你", "你别继续"].some((keyword) => user.includes(keyword))) {
    score -= 1;
  }

  return score;
}

function detectSignals(texts: string[]): string[] {
  const joined = texts.map((item) => normalizeText(item)).join(" ");
  const hits = new Set<string>();

  ANCHOR_KEYWORDS.forEach((keyword) => {
    if (joined.includes(keyword.toLowerCase())) {
      hits.add(keyword);
    }
  });

  Object.values(AFFINITY_BOOST_KEYWORDS)
    .flat()
    .forEach((keyword) => {
      if (joined.includes(keyword.toLowerCase())) {
        hits.add(keyword);
      }
    });

  return Array.from(hits).slice(0, MAX_SIGNAL_COUNT);
}

function makeSummary(userSignals: string[]): string {
  if (userSignals.length === 0) {
    return "关系状态平稳，可继续基于当前角色风格自然互动。";
  }
  return `关系状态：已识别到偏好主题 ${userSignals.join("、")}。`;
}

export function buildSessionContext(
  previous: SessionRecord | null,
  userText: string,
  assistantText: string,
  requestedRelationshipMode?: RelationshipMode
): SessionContext {
  const baseContext: SessionContext =
    previous?.context ?? {
      relationshipAffinity: "new",
      summary: "关系状态平稳，可继续基于当前角色风格自然互动。",
      activeRelationshipMode: undefined,
      userSignals: [],
      lastEmotion: "neutral",
      turnCount: 0,
      updatedAt: new Date().toISOString()
    };

  const nextScore = scoreAffinity(baseContext, userText, assistantText);
  const historyForSignals = [
    ...((previous?.history || []).map((item) => item.content)),
    userText,
    assistantText
  ];
  const signals = detectSignals(historyForSignals);

  return {
    relationshipAffinity: toSafeAffinity(nextScore),
    summary: makeSummary(signals),
    activeRelationshipMode:
      normalizeRelationshipMode(requestedRelationshipMode) || baseContext.activeRelationshipMode,
    userSignals: signals,
    lastEmotion: inferEmotionFromText(assistantText),
    turnCount: baseContext.turnCount + 1,
    updatedAt: new Date().toISOString()
  };
}

function sanitizeSessionId(sessionId: string): string {
  const input = String(sessionId || "").trim();
  const safe = input.replace(/[^a-zA-Z0-9._-]/g, "-");
  return safe.slice(0, 120) || "session-anonymous";
}

export function makeSessionId(): string {
  return `s-${Date.now().toString(36)}-${crypto.randomBytes(4).toString("hex")}`;
}

export async function loadSession(sessionId: string): Promise<SessionRecord | null> {
  const safeId = sanitizeSessionId(sessionId);
  const file = path.join(SESSION_DIR, `${safeId}.json`);
  try {
    const raw = await fs.readFile(file, "utf8");
    return JSON.parse(raw) as SessionRecord;
  } catch {
    return null;
  }
}

export async function appendToSession(
  sessionId: string,
  message: ChatMessage,
  context?: SessionContext
): Promise<SessionRecord> {
  const safeId = sanitizeSessionId(sessionId);
  await fs.mkdir(SESSION_DIR, { recursive: true });
  const file = path.join(SESSION_DIR, `${safeId}.json`);
  const now = new Date().toISOString();

  const existing = await loadSession(safeId);
  const nextHistory = existing ? [...existing.history] : [];
  nextHistory.push(message);
  if (nextHistory.length > MAX_TURNS_PER_SESSION) {
    nextHistory.splice(0, nextHistory.length - MAX_TURNS_PER_SESSION);
  }

  const record: SessionRecord = {
    sessionId: safeId,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    history: nextHistory,
    context: context ?? existing?.context
  };

  await fs.writeFile(file, JSON.stringify(record, null, 2), "utf8");
  return record;
}

export async function clearSession(sessionId: string): Promise<void> {
  const safeId = sanitizeSessionId(sessionId);
  const file = path.join(SESSION_DIR, `${safeId}.json`);
  await fs.rm(file, { force: true });
}
