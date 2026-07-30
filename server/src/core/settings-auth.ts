import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { NextFunction, Request, Response } from "express";
import { DATA_DIR } from "./data";

/**
 * 系统设置页二次密码验证。
 * - 密码只以「盐 + SHA-256 哈希」形式存在 data/settings-auth.json（已 gitignore 目录），前后端源码均无明文。
 * - 登录成功签发随机令牌（内存态，2 小时滑动过期，服务重启即全部失效）。
 * - 所有 /api/settings* 接口必须带 x-settings-token 请求头，否则 401 —— 前端未解锁时拿不到任何设置数据。
 * - 防爆破：连续 5 次密码错误锁定 5 分钟。
 */

const AUTH_FILE = path.join(DATA_DIR, "settings-auth.json");
const TOKEN_TTL_MS = 2 * 60 * 60 * 1000; // 2 小时滑动过期
const MAX_FAILS = 5;
const LOCK_MS = 5 * 60 * 1000;

interface AuthStore {
  salt: string;
  hash: string;
  updatedAt?: string;
}

const tokens = new Map<string, number>(); // token -> expiresAt
let failCount = 0;
let lockUntil = 0;

function sha256(text: string): string {
  return crypto.createHash("sha256").update(text, "utf8").digest("hex");
}

function hashPassword(salt: string, password: string): string {
  return sha256(`${salt}:${password}`);
}

function loadStore(): AuthStore | null {
  try {
    if (fs.existsSync(AUTH_FILE)) {
      const raw = JSON.parse(fs.readFileSync(AUTH_FILE, "utf8")) as AuthStore;
      if (raw && typeof raw.salt === "string" && typeof raw.hash === "string") {
        return raw;
      }
    }
  } catch (err) {
    console.error("[settings-auth] 读取 settings-auth.json 失败:", err);
  }
  return null;
}

function saveStore(store: AuthStore): void {
  fs.mkdirSync(path.dirname(AUTH_FILE), { recursive: true });
  const tmp = `${AUTH_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  fs.renameSync(tmp, AUTH_FILE);
}

function verifyPassword(password: string): boolean {
  const store = loadStore();
  if (!store) return false;
  const candidate = hashPassword(store.salt, password);
  try {
    return crypto.timingSafeEqual(Buffer.from(candidate, "hex"), Buffer.from(store.hash, "hex"));
  } catch {
    return false;
  }
}

function setPassword(password: string): void {
  const salt = crypto.randomBytes(16).toString("hex");
  saveStore({ salt, hash: hashPassword(salt, password), updatedAt: new Date().toISOString() });
}

function issueToken(): string {
  const token = crypto.randomBytes(32).toString("hex");
  tokens.set(token, Date.now() + TOKEN_TTL_MS);
  return token;
}

function pruneTokens(): void {
  const now = Date.now();
  for (const [token, expiresAt] of tokens) {
    if (expiresAt <= now) tokens.delete(token);
  }
}

function readToken(req: Request): string {
  const header = req.headers["x-settings-token"];
  return typeof header === "string" ? header.trim() : "";
}

function isTokenValid(token: string): boolean {
  pruneTokens();
  if (!token) return false;
  const expiresAt = tokens.get(token);
  if (!expiresAt || expiresAt <= Date.now()) {
    tokens.delete(token);
    return false;
  }
  // 滑动续期
  tokens.set(token, Date.now() + TOKEN_TTL_MS);
  return true;
}

/** 登录：POST /api/settings/auth  { password } */
export function settingsAuthLogin(req: Request, res: Response): void {
  const now = Date.now();
  if (lockUntil > now) {
    res.status(429).json({ error: `尝试次数过多，已锁定，请 ${Math.ceil((lockUntil - now) / 1000)} 秒后再试` });
    return;
  }
  if (!loadStore()) {
    res.status(503).json({ error: "设置密码未初始化，请联系管理员在服务器上初始化 settings-auth.json" });
    return;
  }
  const password = String((req.body as { password?: unknown })?.password ?? "");
  if (!password || !verifyPassword(password)) {
    failCount += 1;
    if (failCount >= MAX_FAILS) {
      lockUntil = now + LOCK_MS;
      failCount = 0;
      res.status(429).json({ error: "密码错误次数过多，已锁定 5 分钟" });
      return;
    }
    res.status(401).json({ error: `密码错误（剩余 ${MAX_FAILS - failCount} 次尝试机会）` });
    return;
  }
  failCount = 0;
  lockUntil = 0;
  const token = issueToken();
  res.json({ token, expiresInMs: TOKEN_TTL_MS });
}

/** 校验中间件：保护所有 /api/settings*（除登录接口本身） */
export function requireSettingsAuth(req: Request, res: Response, next: NextFunction): void {
  // 挂载在 /api/settings 下时，req.path 形如 /auth、/、/prompts/reset
  if (req.path === "/auth" || req.path === "/auth/") {
    next();
    return;
  }
  if (!isTokenValid(readToken(req))) {
    res.status(401).json({ error: "SETTINGS_UNAUTHORIZED" });
    return;
  }
  next();
}

/** 登出：POST /api/settings/auth/logout（受保护） */
export function settingsAuthLogout(req: Request, res: Response): void {
  tokens.delete(readToken(req));
  res.json({ ok: true });
}

/** 修改密码：POST /api/settings/auth/password  { oldPassword, newPassword }（受保护） */
export function settingsAuthChangePassword(req: Request, res: Response): void {
  const body = (req.body || {}) as { oldPassword?: unknown; newPassword?: unknown };
  const oldPassword = String(body.oldPassword ?? "");
  const newPassword = String(body.newPassword ?? "").trim();
  if (!verifyPassword(oldPassword)) {
    res.status(401).json({ error: "原密码错误" });
    return;
  }
  if (newPassword.length < 4) {
    res.status(400).json({ error: "新密码长度至少 4 位" });
    return;
  }
  setPassword(newPassword);
  tokens.clear(); // 改密后所有已发令牌作废
  res.json({ ok: true });
}
