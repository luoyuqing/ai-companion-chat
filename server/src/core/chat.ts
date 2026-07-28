import { askAssistant } from "../services/llm";
import { appendToSession, buildSessionContext, loadSession, makeSessionId } from "../services/session";
import { getCharacters, resolveCharacter } from "./data";
import { ChatMessage, DigitalHumanConfig, RelationshipMode, SessionContext } from "../types";

export interface ChatResult {
  sessionId: string;
  character: DigitalHumanConfig;
  text: string;
  emotion: string;
  context?: SessionContext;
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
  const answer = await askAssistant(
    history,
    character,
    message,
    existingSession?.context,
    opts.relationshipMode
  );

  const nextContext = buildSessionContext(existingSession, message, answer.text, opts.relationshipMode);
  await appendToSession(sessionId, { role: "user", content: message }, nextContext);
  await appendToSession(sessionId, { role: "assistant", content: answer.text }, nextContext);

  return {
    sessionId,
    character,
    text: answer.text,
    emotion: answer.emotion,
    context: nextContext
  };
}
