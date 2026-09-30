/**
 * Matrix Client-Server API 客户端（零依赖实现）。
 *
 * 为什么不用 matrix-bot-sdk：本项目在服务器上属「无版本控制的文件直部署」，
 * 引入 npm 依赖需要额外的安装/构建步骤，且会拉入大量传递依赖（含可能的原生模块），
 * 对生产环境扰动面大。这里用到的都是标准 CS API 的单次 HTTP 调用
 * （login/verify、createRoom、invite、state 查询、sync 长轮询、send、media upload/download、
 * typing、profile），Node 20 内置 fetch/FormData/Blob 已完全覆盖，
 * 因此零依赖实现同时满足「扰动最小」与「可审计」两个目标。
 *
 * 关键设计点：
 * - `/sync` 的 timeout 固定由调用方传 30s：CF 隧道对空闲长连接有约 100s 超时，
 *   设 30s 可保证隧道内始终有数据流动，避免被静默切断（方案 11.3）。
 * - 媒体上传必须用 **raw body**（`Content-Type` 直接声明 MIME），不要用 multipart，
 *   否则部分 homeserver 会把文件存成损坏内容（X2 文档第十二节踩坑）。
 * - 媒体下载优先走认证媒体端点 `/_matrix/client/v1/media/download`，
 *   失败回退 legacy `/_matrix/media/v3/download`（X2 已开启 allow_legacy_media）。
 */

import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import path from "node:path";

export interface MatrixClientOptions {
  homeserver: string;
  accessToken: string;
  /** 账号完整 id，如 @dg-jiangrouyi:matrix.3585616.xyz；未提供时由 whoami 自动获取 */
  userId?: string;
}

export interface MatrixEvent {
  type: string;
  sender: string;
  event_id?: string;
  origin_server_ts?: number;
  room_id?: string;
  /** 部分响应（如 timeline 内）会给 state_key */
  state_key?: string;
  content?: Record<string, unknown>;
  unsigned?: Record<string, unknown>;
}

export interface MatrixSyncResponse {
  next_batch: string;
  rooms?: {
    join?: Record<
      string,
      {
        timeline?: { events?: MatrixEvent[]; limited?: boolean; prev_batch?: string };
        state?: { events?: MatrixEvent[] };
        ephemeral?: { events?: MatrixEvent[] };
      }
    >;
    invite?: Record<string, unknown>;
    leave?: Record<string, unknown>;
  };
  to_device?: { events?: MatrixEvent[] };
  device_lists?: unknown;
  presence?: unknown;
}

export type MatrixMediaKind = "image" | "video" | "audio" | "file";

/** 从服务器返回的 JSON 里提取错误信息（Matrix 错误结构：{errcode, error}） */
function matrixError(status: number, body: string): Error {
  let detail = body.slice(0, 200);
  try {
    const j = JSON.parse(body) as { errcode?: string; error?: string };
    if (j.error) detail = `${j.errcode || status}: ${j.error}`;
  } catch {
    /* 非 JSON 响应，保留原文 */
  }
  return new Error(`Matrix HTTP ${status} ${detail}`);
}

export function normalizeHomeserver(raw: string): string {
  const s = String(raw || "").trim();
  if (!s) return "";
  const withScheme = /^https?:\/\//i.test(s) ? s : `https://${s}`;
  return withScheme.replace(/\/+$/, "");
}

/** 生成幂等事务 id（同一 txnId 重发不会被 homeserver 重复投递） */
function makeTxnId(prefix = "dg"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;
}

/**
 * 探测图片像素尺寸（PNG / JPEG / GIF / WebP），仅用于给 m.image 事件补 info.w/h。
 * 解析失败返回 null —— 缺 w/h 的 m.image 客户端仍可正常显示，不影响可用性。
 */
export function detectImageSize(buf: Buffer): { w: number; h: number } | null {
  try {
    // PNG: 89 50 4E 47 0D 0A 1A 0A，IHDR 紧接其后
    if (buf.length > 24 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // GIF: "GIF87a" / "GIF89a"
    if (buf.length > 10 && buf.slice(0, 3).toString("latin1") === "GIF") {
      return { w: buf.readUInt16LE(6), h: buf.readUInt16LE(8) };
    }
    // WebP: RIFF....WEBP
    if (buf.length > 30 && buf.slice(0, 4).toString("latin1") === "RIFF" && buf.slice(8, 12).toString("latin1") === "WEBP") {
      const fmt = buf.slice(12, 16).toString("latin1");
      if (fmt === "VP8X") {
        const w = 1 + (buf.readUInt8(24) | (buf.readUInt8(25) << 8) | (buf.readUInt8(26) << 16));
        const h = 1 + (buf.readUInt8(27) | (buf.readUInt8(28) << 8) | (buf.readUInt8(29) << 16));
        return { w, h };
      }
      if (fmt === "VP8 ") {
        return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      }
      if (fmt === "VP8L") {
        const b = buf.readUInt32LE(21);
        return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 };
      }
    }
    // JPEG: 扫描 SOFn 段
    if (buf.length > 4 && buf[0] === 0xff && buf[1] === 0xd8) {
      let off = 2;
      while (off + 9 < buf.length) {
        if (buf[off] !== 0xff) {
          off++;
          continue;
        }
        const marker = buf.readUInt8(off + 1);
        // SOF0..SOF15（排除 DHT=C4 / JPG=C8 / DAC=CC）
        if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
          return { h: buf.readUInt16BE(off + 5), w: buf.readUInt16BE(off + 7) };
        }
        const len = buf.readUInt16BE(off + 2);
        if (len <= 0) break;
        off += 2 + len;
      }
    }
  } catch {
    /* 解析失败即返回 null */
  }
  return null;
}

const EXT_MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".mp4": "video/mp4",
  ".webm": "video/webm",
  ".mov": "video/quicktime",
  ".mp3": "audio/mpeg",
  ".ogg": "audio/ogg",
  ".opus": "audio/ogg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".json": "application/json",
  ".txt": "text/plain"
};

export function guessMimeType(filePath: string): string {
  return EXT_MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream";
}

export class MatrixClient {
  readonly homeserver: string;
  readonly accessToken: string;
  userId: string;

  constructor(opts: MatrixClientOptions) {
    this.homeserver = normalizeHomeserver(opts.homeserver);
    this.accessToken = String(opts.accessToken || "").trim();
    this.userId = String(opts.userId || "").trim();
    if (!this.homeserver) throw new Error("Matrix homeserver 未配置");
    if (!this.accessToken) throw new Error("Matrix accessToken 未配置");
  }

  private url(p: string): string {
    return `${this.homeserver}${p}`;
  }

  private headers(extra?: Record<string, string>): Record<string, string> {
    return { Authorization: `Bearer ${this.accessToken}`, ...(extra || {}) };
  }

  /** 通用 JSON 请求；网络类错误由调用方决定是否重试 */
  private async request<T>(method: string, p: string, body?: unknown, timeoutMs = 30000): Promise<T> {
    const resp = await fetch(this.url(p), {
      method,
      headers: this.headers(body !== undefined ? { "Content-Type": "application/json" } : undefined),
      body: body !== undefined ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(timeoutMs)
    });
    const text = await resp.text();
    if (!resp.ok) throw matrixError(resp.status, text);
    return (text ? JSON.parse(text) : {}) as T;
  }

  // ---------- 账号 ----------

  /** 校验 access_token 并取得 userId（启动自检用） */
  async whoami(): Promise<string> {
    const r = await this.request<{ user_id?: string }>("GET", "/_matrix/client/v3/account/whoami", undefined, 15000);
    const uid = String(r.user_id || "").trim();
    if (!uid) throw new Error("whoami 未返回 user_id");
    this.userId = uid;
    return uid;
  }

  // ---------- 房间 ----------

  /**
   * 建房并邀请主人。
   * ⚠️ 绝不设置 `m.room.encryption` —— bot 建房是保证房间明文的关键（方案 3.2）。
   * preset 用 trusted_private_chat（邀请制私聊），is_direct 让 Element 侧显示为 DM。
   */
  async createRoom(opts: { name?: string; topic?: string; invite?: string[] }): Promise<string> {
    const body: Record<string, unknown> = {
      preset: "trusted_private_chat",
      is_direct: true,
      invite: (opts.invite || []).filter(Boolean)
    };
    if (opts.name) body.name = opts.name;
    if (opts.topic) body.topic = opts.topic;
    const r = await this.request<{ room_id?: string }>("POST", "/_matrix/client/v3/createRoom", body, 30000);
    const roomId = String(r.room_id || "").trim();
    if (!roomId) throw new Error("createRoom 未返回 room_id");
    return roomId;
  }

  async invite(roomId: string, userId: string): Promise<void> {
    await this.request(
      "POST",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/invite`,
      { user_id: userId },
      20000
    );
  }

  async joinRoom(roomId: string): Promise<void> {
    await this.request("POST", `/_matrix/client/v3/join/${encodeURIComponent(roomId)}`, {}, 20000);
  }

  async getJoinedRooms(): Promise<string[]> {
    const r = await this.request<{ joined_rooms?: string[] }>("GET", "/_matrix/client/v3/joined_rooms");
    return Array.isArray(r.joined_rooms) ? r.joined_rooms : [];
  }

  /**
   * 查询房间是否开启加密。返回 null = 明文（期望结果）；
   * 返回内容 = 已加密（bot 全盲，需重建房间）。
   */
  async getRoomEncryption(roomId: string): Promise<Record<string, unknown> | null> {
    try {
      return await this.request<Record<string, unknown>>(
        "GET",
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/state/m.room.encryption`,
        undefined,
        15000
      );
    } catch (err) {
      // 404 = 无该状态事件 = 明文，属正常路径
      if (err instanceof Error && /HTTP 404/.test(err.message)) return null;
      throw err;
    }
  }

  /** 读取房间成员的显示名（用于识别主人的 userId） */
  async getJoinedMembers(roomId: string): Promise<string[]> {
    try {
      const r = await this.request<{ joined?: Record<string, unknown> }>(
        "GET",
        `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/joined_members`,
        undefined,
        15000
      );
      return Object.keys(r.joined || {});
    } catch {
      return [];
    }
  }

  // ---------- 同步（长轮询） ----------

  /**
   * 长轮询同步。timeoutMs 建议固定 30s（见文件头说明）。
   * 调用方需自行处理异常退避。
   */
  async sync(since: string | undefined, timeoutMs = 30000, extraFilter?: string): Promise<MatrixSyncResponse> {
    const params = new URLSearchParams();
    if (since) params.set("since", since);
    params.set("timeout", String(timeoutMs));
    if (extraFilter) params.set("filter", extraFilter);
    // HTTP 超时留出 20s 余量（sync 长轮询本身会占满 timeout 窗口）
    return await this.request<MatrixSyncResponse>(
      "GET",
      `/_matrix/client/v3/sync?${params.toString()}`,
      undefined,
      timeoutMs + 20000
    );
  }

  // ---------- 发送 ----------

  /** 发送 m.room.message 事件（自动生成幂等 txnId） */
  async sendEvent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
    timeoutMs = 30000
  ): Promise<string> {
    const txnId = makeTxnId();
    const r = await this.request<{ event_id?: string }>(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/send/${eventType}/${txnId}`,
      content,
      timeoutMs
    );
    return String(r.event_id || "");
  }

  async sendText(roomId: string, text: string): Promise<string> {
    return await this.sendEvent(roomId, "m.room.message", {
      msgtype: "m.text",
      body: text
    });
  }

  /** 发送带回复关系的文本（m.in_reply_to，用于「回复某张照片」语义） */
  async sendReply(roomId: string, text: string, replyToEventId: string): Promise<string> {
    return await this.sendEvent(roomId, "m.room.message", {
      msgtype: "m.text",
      body: text,
      "m.relates_to": { "m.in_reply_to": { event_id: replyToEventId } }
    });
  }

  /**
   * 上传媒体，返回 mxc:// URI。
   * ⚠️ raw body 上传（非 multipart），见文件头说明。
   */
  async uploadMedia(filePath: string, contentType?: string, fileName?: string): Promise<string> {
    const buf = readFileSync(filePath);
    const type = contentType || guessMimeType(filePath);
    const name = fileName || path.basename(filePath);
    const resp = await fetch(
      this.url(`/_matrix/media/v3/upload?filename=${encodeURIComponent(name)}`),
      {
        method: "POST",
        headers: this.headers({ "Content-Type": type }),
        body: new Uint8Array(buf),
        signal: AbortSignal.timeout(300000)
      }
    );
    const text = await resp.text();
    if (!resp.ok) throw matrixError(resp.status, text);
    const r = JSON.parse(text) as { content_uri?: string };
    const uri = String(r.content_uri || "").trim();
    if (!uri) throw new Error("媒体上传未返回 content_uri");
    return uri;
  }

  /**
   * 上传并发送媒体消息（m.image / m.video / m.audio / m.file）。
   * @param caption 媒体附带的文字说明（m.image/m.video 用 body 承载）
   */
  async sendMedia(
    roomId: string,
    kind: MatrixMediaKind,
    filePath: string,
    opts?: { caption?: string; durationMs?: number; width?: number; height?: number }
  ): Promise<string> {
    const buf = readFileSync(filePath);
    const mime = guessMimeType(filePath);
    const fileName = path.basename(filePath);
    const mxc = await this.uploadMedia(filePath, mime, fileName);

    // image 补 w/h（客户端据此优化布局）；解析失败则省略
    let width = opts?.width;
    let height = opts?.height;
    if (kind === "image" && (!width || !height)) {
      const size = detectImageSize(buf);
      if (size) {
        width = size.w;
        height = size.h;
      }
    }

    const info: Record<string, unknown> = { mimetype: mime, size: buf.length };
    if (width && height) {
      info.w = width;
      info.h = height;
    }
    if (opts?.durationMs && opts.durationMs > 0) info.duration = opts.durationMs;

    const content: Record<string, unknown> = {
      msgtype: kind === "image" ? "m.image" : kind === "video" ? "m.video" : kind === "audio" ? "m.audio" : "m.file",
      body: opts?.caption?.trim() || fileName,
      url: mxc,
      info
    };
    return await this.sendEvent(roomId, "m.room.message", content, 300000);
  }

  // ---------- 媒体下载 ----------

  /** mxc:// URI 转 HTTP 地址（认证媒体端点 v1） */
  mxcToHttp(mxcUri: string): string | null {
    const m = /^mxc:\/\/([^/]+)\/(.+)$/.exec(String(mxcUri || "").trim());
    if (!m) return null;
    return this.url(`/_matrix/client/v1/media/download/${m[1]}/${m[2]}`);
  }

  /** legacy 媒体下载地址（部分 homeserver 未开认证媒体时使用） */
  private mxcToLegacyHttp(mxcUri: string): string | null {
    const m = /^mxc:\/\/([^/]+)\/(.+)$/.exec(String(mxcUri || "").trim());
    if (!m) return null;
    return this.url(`/_matrix/media/v3/download/${m[1]}/${m[2]}`);
  }

  /** 下载媒体到本地文件（先尝试认证端点，失败回退 legacy）。返回写入的字节数。 */
  async downloadMedia(mxcUri: string, destPath: string): Promise<number> {
    const candidates = [this.mxcToHttp(mxcUri), this.mxcToLegacyHttp(mxcUri)].filter(
      (u): u is string => Boolean(u)
    );
    if (candidates.length === 0) throw new Error(`无效的 mxc URI: ${mxcUri}`);
    let lastErr: unknown;
    for (const u of candidates) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const resp = await fetch(u, {
            headers: this.headers(),
            signal: AbortSignal.timeout(300000)
          });
          if (!resp.ok) {
            const t = await resp.text().catch(() => "");
            throw matrixError(resp.status, t);
          }
          const buf = Buffer.from(await resp.arrayBuffer());
          if (!buf.length) throw new Error("下载到空文件");
          mkdirSync(path.dirname(destPath), { recursive: true });
          writeFileSync(destPath, buf);
          return buf.length;
        } catch (e) {
          lastErr = e;
          // 404/403 属端点不可用或未授权，直接换下一个候选；网络错误则退避重试
          const msg = e instanceof Error ? e.message : String(e);
          if (/HTTP 40[0-9]/.test(msg)) break;
          await new Promise((r) => setTimeout(r, 700 * attempt));
        }
      }
    }
    throw lastErr instanceof Error ? lastErr : new Error("媒体下载失败");
  }

  // ---------- 交互状态与资料 ----------

  /** typing 指示。注意：homeserver 侧会自动过期，需周期性续期（调用方每 ~20s 调用一次）。 */
  async setTyping(roomId: string, typing: boolean, timeoutMs = 20000): Promise<void> {
    if (!this.userId) return; // 未取得自身 userId 时无法发送
    await this.request(
      "PUT",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/typing/${encodeURIComponent(this.userId)}`,
      { typing, timeout: typing ? timeoutMs : 0 },
      15000
    );
  }

  /** 已读回执（可选，用于清理未读气泡） */
  async sendReadReceipt(roomId: string, eventId: string): Promise<void> {
    await this.request(
      "POST",
      `/_matrix/client/v3/rooms/${encodeURIComponent(roomId)}/receipt/m.read/${encodeURIComponent(eventId)}`,
      {},
      15000
    );
  }

  async setDisplayName(name: string): Promise<void> {
    if (!this.userId) throw new Error("userId 未知，无法设置昵称");
    await this.request(
      "PUT",
      `/_matrix/client/v3/profile/${encodeURIComponent(this.userId)}/displayname`,
      { displayname: name },
      15000
    );
  }

  /** 设置头像（上传头像图后写 profile.avatar_url） */
  async setAvatar(imagePath: string): Promise<void> {
    if (!this.userId) throw new Error("userId 未知，无法设置头像");
    const mxc = await this.uploadMedia(imagePath, guessMimeType(imagePath));
    await this.request(
      "PUT",
      `/_matrix/client/v3/profile/${encodeURIComponent(this.userId)}/avatar_url`,
      { avatar_url: mxc },
      15000
    );
  }
}

export function createMatrixClient(homeserver: string, accessToken: string, userId?: string): MatrixClient {
  return new MatrixClient({ homeserver, accessToken, userId });
}
