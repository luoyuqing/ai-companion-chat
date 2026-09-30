/**
 * 渠道分发：把「给主人发一条消息」这件事按渠道开关路由到具体实现。
 *
 * 路由顺序（与方案第 8 章一致）：
 *   1. Matrix：全局开 && 角色开 && 凭据完整 && 有 home room → 发到 Matrix 房间
 *   2. Telegram：全局开 && 角色开 && 有专属 bot token → 走原 TG 路径
 *   3. 都不满足 → 记日志后静默跳过（不抛错，避免影响调度器）
 *
 * 说明：Matrix 发送失败**不回退 Telegram** —— 双渠道同时在线时回退会造成重复投递，
 * 宁可本分钟失败（调度器下一分钟会以新 marker 重新触发）。
 */

import { isMatrixEnabledFor, isTelegramEnabledFor, resolveMatrixEndpoint } from "../core/channel";
import type { MatrixEndpoint } from "../core/channel";
import { MatrixClient } from "../matrix/client";
import { audioUrlToPath } from "../core/data";
import { synthesizeSpeech } from "./tts";
import { sendProactiveToOwner } from "../telegram/bot";
import type { DigitalHumanConfig } from "../types";

/** 通过 Matrix home room 给主人发消息（文本，可选附带语音） */
async function sendViaMatrix(
  character: DigitalHumanConfig,
  endpoint: MatrixEndpoint & { roomId: string },
  text: string
): Promise<boolean> {
  const client = new MatrixClient({
    homeserver: endpoint.homeserver,
    accessToken: endpoint.accessToken,
    userId: endpoint.userId
  });
  try {
    await client.sendText(endpoint.roomId, text);
    console.log(`[主动推送][Matrix] 已发送 → ${character.name}(${character.id})`);
  } catch (err) {
    console.error(`[主动推送][Matrix] 发送失败 ${character.name}(${character.id}):`, err);
    return false;
  }

  // 语音默认关闭（省 TTS 额度）；开启时发 m.audio，失败不影响文字已送达的事实
  if (character.proactive?.voiceEnabled) {
    try {
      const audioUrl = await synthesizeSpeech(text, character);
      const audioPath = audioUrlToPath(audioUrl);
      if (audioPath) {
        await client.sendMedia(endpoint.roomId, "audio", audioPath, {});
      }
    } catch (err) {
      console.warn(`[主动推送][Matrix] 语音发送失败（文字已送达）:`, err instanceof Error ? err.message : err);
    }
  }
  return true;
}

/**
 * 主动推送的统一出口。返回是否发送成功。
 * 供 proactive 调度器调用；调度器本身与渠道无关。
 */
export async function sendProactiveMessage(character: DigitalHumanConfig, text: string): Promise<boolean> {
  // 1) Matrix 优先
  if (isMatrixEnabledFor(character)) {
    const endpoint = resolveMatrixEndpoint(character);
    if (endpoint?.roomId) {
      return await sendViaMatrix(character, { ...endpoint, roomId: endpoint.roomId }, text);
    }
    if (endpoint) {
      console.warn(
        `[主动推送] ${character.name}(${character.id}) 已启用 Matrix 但尚无 home room（首次启动会自动建房），本次跳过`
      );
    } else {
      console.warn(`[主动推送] ${character.name}(${character.id}) 已启用 Matrix 但凭据不完整，本次跳过`);
    }
  }

  // 2) 回退 Telegram（仅当该角色 TG 渠道实际启用）
  if (isTelegramEnabledFor(character) && character.telegramBotToken?.trim()) {
    const ok = await sendProactiveToOwner(character, text);
    return ok;
  }

  // 3) 双渠道均不可用
  console.warn(
    `[主动推送] ${character.name}(${character.id}) 当前无可用投递渠道（TG 全局/角色开关关闭或未配置，Matrix 未配置），本次跳过`
  );
  return false;
}
