import { getCharacters } from "../core/data";
import { loadSession, appendToSession } from "../services/session";
import { getOpenAiClient, resolveLlmModel } from "../services/llm";
import { getUserMemory } from "../services/userMemory";
import type { DigitalHumanConfig, ProactiveConfig } from "../types";
import { sendProactiveToOwner } from "./bot";

// 主动推送按北京时间解释时间点，避免服务器时区（KST）与用户（中国）不一致导致错位。
const PROACTIVE_TZ = "Asia/Shanghai";

// 记录每个 (角色:时间点) 最近一次已发送的 "YYYY-MM-DD HH:MM"，进程内去重，避免同分钟重复发送。
const sentMarkers = new Map<string, string>();

function shanghaiNow(): { hm: string; dayKey: string } {
  const parts = new Intl.DateTimeFormat("zh-CN", {
    timeZone: PROACTIVE_TZ,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).formatToParts(new Date());
  const get = (t: string) => parts.find((p) => p.type === t)?.value || "";
  const hm = `${get("hour")}:${get("minute")}`;
  const dayKey = `${get("year")}-${get("month")}-${get("day")}`;
  return { hm, dayKey };
}

interface ProactiveDecision {
  send: boolean;
  message: string;
}

function extractJson(text: string): Partial<ProactiveDecision> | null {
  const cleaned = text.trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(cleaned) as Partial<ProactiveDecision>;
  } catch {
    return null;
  }
}

async function generateProactiveText(
  character: DigitalHumanConfig,
  mode: ProactiveConfig["mode"]
): Promise<ProactiveDecision> {
  const sessionId = `mem-${character.id}`;
  const session = await loadSession(sessionId);
  const memoryFile = session?.memoryFile?.trim() || "（暂无长期记忆）";
  const recent = (session?.history ?? [])
    .filter((m) => m.role === "user" || m.role === "assistant")
    .slice(-12)
    .map((m) => `${m.role === "user" ? "用户" : character.name}：${m.content}`)
    .join("\n");
  const recentText = recent.trim() || "（最近还没有聊天）";
  // 长期记忆（后端唯一真源）；禁忌以用户记忆里的「聊天禁忌或边界」为准，旧 chatTaboos 仅作兜底。
  const mem = await getUserMemory(character.id);
  const taboos = (mem.boundaries && mem.boundaries.trim()) || character.chatTaboos?.trim() || "（无特别禁忌）";
  const userMemoryText = [
    mem.displayName && `用户自称：${mem.displayName}`,
    mem.preferredName && `用户希望被称呼：${mem.preferredName}`,
    mem.preferences && `聊天偏好：${mem.preferences}`,
    mem.importantFacts && `用户重要事实：${mem.importantFacts}`,
    mem.relationshipNotes && `关系备注：${mem.relationshipNotes}`
  ].filter(Boolean).join("\n");
  const time = shanghaiNow().hm;

  const systemPrompt =
    `你是${character.name}。\n` +
    `你的人设：${character.description}\n` +
    `人设口令：${character.personalityTagline || "（无）"}\n` +
    `你们的关系风格：${character.relationshipMode || "sweet"}\n` +
    `你们的关系与过往记忆：${memoryFile}\n` +
    `用户（主人）资料与偏好：${userMemoryText || "（暂无）"}\n` +
    `聊天禁忌（绝不能触碰，发消息时务必回避）：${taboos}\n\n` +
    `现在请你作为${character.name}，主动向你的主人（用户）发一条消息。要求：\n` +
    `1. 符合你的人设、关系阶段与近期互动，自然、有温度、不突兀，像真人主动想起对方时的碎碎念或关心。\n` +
    `2. 严禁违反聊天禁忌。\n` +
    `3. 只输出一个 JSON 对象：{"send": true 或 false, "message": "要发送的话"}。\n` +
    (mode === "smart"
      ? `4. 若当前时间/情境不适合主动打扰（例如刚聊完没必要再发、或禁忌冲突），请把 send 设为 false，message 留空。`
      : `4. 这是“到点必发”模式，请务必 send=true 并给出 message。`);

  const userPrompt = `当前时间（北京时间）：${time}。\n近期聊天片段：\n${recentText}\n\n请决定并生成这条主动消息：`;

  const client = getOpenAiClient();
  if (!client) {
    // 无可用模型：always 模式退化为通用问候，smart 模式放弃发送
    return mode === "always"
      ? { send: true, message: `${character.name}：主人，想你啦～今天过得还好吗？` }
      : { send: false, message: "" };
  }

  try {
    const completion = await client.chat.completions.create({
      model: resolveLlmModel(),
      temperature: 0.85,
      stream: false,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    });
    const raw = completion.choices?.[0]?.message?.content?.trim() || "";
    const parsed = extractJson(raw);
    if (parsed && typeof parsed.message === "string" && parsed.message.trim()) {
      const send = mode === "always" ? true : Boolean(parsed.send);
      return { send, message: parsed.message.trim() };
    }
    // 解析失败：always 模式用原文兜底，smart 模式放弃
    if (mode === "always" && raw) return { send: true, message: raw };
    return { send: false, message: "" };
  } catch (err) {
    console.error(`生成主动消息失败 (${character.id}):`, err);
    return { send: false, message: "" };
  }
}

async function tick(): Promise<void> {
  const { hm, dayKey } = shanghaiNow();
  let characters: DigitalHumanConfig[] = [];
  try {
    characters = await getCharacters();
  } catch (err) {
    console.error("主动推送：加载角色失败", err);
    return;
  }

  for (const c of characters) {
    if (!c.proactive?.enabled) continue;
    if (!c.telegramBotToken) continue; // 必须配置了专属 bot 才能主动发
    const timePoints = (c.proactive.timePoints || []).filter((t) => typeof t === "string");
    if (!timePoints.includes(hm)) continue;
    const markerKey = `${c.id}:${hm}`;
    const marker = `${dayKey} ${hm}`;
    if (sentMarkers.get(markerKey) === marker) continue; // 本次已发过，去重

    const decision = await generateProactiveText(c, c.proactive.mode);
    const shouldSend = c.proactive.mode === "always" ? true : decision.send;
    if (!shouldSend || !decision.message.trim()) {
      // 即使不发也标记，避免 smart 模式每分钟反复决策
      sentMarkers.set(markerKey, marker);
      continue;
    }

    const ok = await sendProactiveToOwner(c.id, decision.message.trim());
    if (ok) {
      sentMarkers.set(markerKey, marker);
      // 把主动消息写回会话，使网页/TG 历史一致、并影响后续上下文
      try {
        await appendToSession(`mem-${c.id}`, { role: "assistant", content: decision.message.trim() });
      } catch (err) {
        console.error(`主动消息写回会话失败 (${c.id}):`, err);
      }
    }
  }
}

export function startProactiveScheduler(intervalMs = 30000): void {
  // 启动瞬间先跑一次（捕获正好踩中时间点的边界情况），之后按间隔轮询
  tick().catch((err) => console.error("主动推送 tick 异常:", err));
  setInterval(() => {
    tick().catch((err) => console.error("主动推送 tick 异常:", err));
  }, intervalMs);
  console.log(`主动推送调度器已启动（间隔 ${intervalMs}ms，时区 ${PROACTIVE_TZ}）`);
}
