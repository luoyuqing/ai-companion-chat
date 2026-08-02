// 跨 TG / web 共享的「用户最近活跃」信号，供主动推送判断「是否正在聊天」。
// key = characterId；value = 最后一条用户主动消息的时间戳(ms)。
// 用户在 TG 或 web 端发消息时打点（markUserActivity）；主动推送判断时若距今 < 窗口则跳过。
// 内存表重启即清空（窗口仅 30 分钟，影响极小；proactive 启动时会用 mem-${id}.updatedAt 给 TG 做种子）。

const lastUserActivity = new Map<string, number>();

// 窗口（毫秒）：用户最后一次发消息距今小于该值视为「正在聊天」，主动推送跳过。
export const CHAT_ACTIVE_WINDOW_MS = 30 * 60 * 1000;

// 用户主动发消息时调用（TG / web 两处 handler 落库用户消息后调用）
export function markUserActivity(characterId: string): void {
  lastUserActivity.set(characterId, Date.now());
}

// 灌入历史时间戳（供 proactive 启动时用 mem-${id}.updatedAt 做种子）
export function seedActivity(characterId: string, ts: number): void {
  lastUserActivity.set(characterId, ts);
}

// 判断某数字人是否「正在聊天」（仅内存表）
export function isUserActiveRecently(characterId: string, windowMs: number = CHAT_ACTIVE_WINDOW_MS): boolean {
  const t = lastUserActivity.get(characterId);
  if (t == null) return false;
  return Date.now() - t < windowMs;
}
