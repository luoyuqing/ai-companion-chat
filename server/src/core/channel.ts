/**
 * 渠道判定（纯逻辑，不做任何 IO）。
 *
 * 双层开关生效规则：**渠道实际启用 = 全局开关 AND 角色开关**。
 * 目的：既能「一键全关某渠道」，也能按角色灰度（例如只让某几个角色走 Matrix）。
 *
 * ⚠️ 兼容性约定（务必遵守）：
 * - 角色级 `telegramEnabled` **缺省（undefined）必须视为 true**。老配置升级后没有该字段，
 *   若按 false 处理会让全部角色的 TG 被静默关闭。
 * - 角色级 `matrixEnabled` **缺省视为 false**。未配置 Matrix 的角色不该自动启动客户端。
 */

import { getChannelsConfig } from "./config";
import type { DigitalHumanConfig } from "../types";

export interface MatrixEndpoint {
  homeserver: string;
  accessToken: string;
  userId: string;
  /** home room；未配置时为空串（启动阶段会自动建房并回填） */
  roomId: string;
}

/** 全局 TG 开关 */
export function isTelegramGloballyEnabled(): boolean {
  return getChannelsConfig().telegramEnabled;
}

/** 全局 Matrix 开关 */
export function isMatrixGloballyEnabled(): boolean {
  return getChannelsConfig().matrixEnabled;
}

/** 角色级 TG 开关（缺省视为 true —— 见文件头兼容性约定） */
export function isTelegramEnabledFor(character: DigitalHumanConfig): boolean {
  if (!isTelegramGloballyEnabled()) return false;
  if (character.telegramEnabled === false) return false;
  return true;
}

/**
 * 角色级 Matrix 开关（缺省视为 false）。
 * 仅看「是否声明要接入」，不校验凭据是否齐全 —— 凭据校验见 resolveMatrixEndpoint。
 */
export function isMatrixEnabledFor(character: DigitalHumanConfig): boolean {
  if (!isMatrixGloballyEnabled()) return false;
  return character.matrixEnabled === true;
}

/**
 * 解析角色的 Matrix 连接信息。凭据不完整（缺 homeserver 或 accessToken）返回 null。
 * homeserver 优先取角色配置，留空回退全局默认。
 */
export function resolveMatrixEndpoint(character: DigitalHumanConfig): MatrixEndpoint | null {
  const accessToken = String(character.matrixAccessToken || "").trim();
  if (!accessToken) return null;
  const homeserver = String(character.matrixHomeserver || "").trim() || getChannelsConfig().matrixHomeserverDefault;
  if (!homeserver) return null;
  return {
    homeserver: homeserver.replace(/\/+$/, ""),
    accessToken,
    userId: String(character.matrixUserId || "").trim(),
    roomId: String(character.matrixRoomId || "").trim()
  };
}

/**
 * 该角色是否具备「可启动的 Matrix 渠道」条件：
 * 全局开 + 角色开 + 凭据齐（roomId 可缺省，启动时自动建房）。
 */
export function canStartMatrixChannel(character: DigitalHumanConfig): boolean {
  return isMatrixEnabledFor(character) && resolveMatrixEndpoint(character) !== null;
}

/**
 * 该角色是否具备「可启动的 Telegram 专属 bot」条件：
 * 全局开 + 角色开 + token 已配置。
 */
export function canStartTelegramChannel(character: DigitalHumanConfig): boolean {
  return isTelegramEnabledFor(character) && Boolean(character.telegramBotToken && character.telegramBotToken.trim());
}

/** 日志用的渠道描述 */
export function describeChannelRouting(character: DigitalHumanConfig): string {
  const parts: string[] = [];
  if (canStartMatrixChannel(character)) parts.push("matrix");
  if (canStartTelegramChannel(character)) parts.push("tg");
  return parts.length ? parts.join("+") : "none";
}
