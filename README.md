# AI 伴聊（AI Companion Chat）

一个可私有部署的多端 AI 陪伴平台：以「数字人」为载体，提供有记忆、有性格、可跨设备连贯对话的陪伴体验。支持 **Web 站点 / Telegram / 微信小程序 / iOS** 多端接入，后端为唯一真源，跨设备无缝衔接。

---

## 核心亮点

- **多端一致的陪伴体验**：Web、Telegram、小程序、iOS 共用同一套数字人配置、会话与长期记忆，后端是唯一真源，换设备不丢上下文、不串记忆。
- **每个数字人都有长期记忆与关系**：后端持久化每个角色的聊天历史与长期记忆（称呼、偏好、禁忌、关系备注），数字人能「记得你」，而不是每轮重新开始。
- **系统配置全网页化、保存即生效**：LLM、TTS、生图、提示词、数字人管理都能在网页设置页完成，**保存后立即生效，无需重启服务**。
- **「拍张照」生图（RunningHub）**：在 Telegram 端说一句触发词，数字人会「去拍张照」，过程中先攒着你的消息，照片生成后再基于上下文统一回复一条，体验拟真。
- **陪伴场景与回复风格**：内置日常 / 约会 / 安慰 / 亲密 / 睡前等场景，驱动关系风格与情绪预设，对话语气随之变化。
- **设置页二次密码保护**：系统配置入口带独立二次密码（加盐 SHA256、防爆破），避免敏感密钥被随意改动。
- **开箱即用的语音与形象**：文本回复可走云端 TTS 语音播报；支持头像 + 情绪表情、情绪视频、以及 Web 端 3D 模型形象。

---

## 功能介绍

### 多数字人管理
可在网页设置页新增、编辑、删除数字人，并为每个数字人清除记忆。每个数字人拥有独立的人设（`description`）、头像、情绪档案与回复风格。

### 多端一致的对话与记忆
- **聊天历史**：保存在后端（按角色隔离，上限 2000 轮），跨浏览器与 Telegram 全量一致；切换角色时自动加载并合并本地历史。
- **长期记忆 / 关系 / 禁忌**：持久化在后端，跨端一致；数字人主动使用你保存的偏好与禁忌，而非每轮重新询问。

### 系统配置网页化
「系统设置页」需二次密码解锁，可配置以下项，**保存即生效**：
- **LLM**：Base URL、模型名、是否支持视觉、API Key（写时不回显，仅返回 `hasApiKey`）。
- **TTS**：云端语音合成 API Key。
- **生图（RunningHub）**：API Key、触发词（可配多个，至少 1 个）、超时秒数（10–600）。
- **提示词**：系统提示与各规则提示（可一键重置为默认）。
- **数字人管理**：新增 / 编辑 / 删除 / 清除记忆。

配置落盘于 `server/src/data/system-config.json`（明文密钥，已 gitignore），内存缓存即时刷新。

### 「拍张照」生图（RunningHub）
在 **Telegram 端**，当消息包含任一触发词（默认「拍张照」，可在设置页自定义多个）时：
1. 数字人仅回复「📷 好的，那我去拍张照，稍等一下下哦~」，不生成内容；
2. 等待照片期间，用户的任何消息只记为未读、不回复；
3. 照片生成成功 / 接口报错 / 超时后，基于累积未读上下文 **统一回复一条**（模拟「拍完照回来翻未读」）；
4. 接口报错会打印完整堆栈并立即回复；超时（默认 120s，可配）则放弃等待直接回复。

生图链路（RunningHub API）：上传头像 → 提交生图任务（输入图 / 分辨率 / 数量 / 比例 / 提示词节点）→ 轮询取 ZIP 解压回传首图。提示词由 LLM 按数字人人设 + 上下文现编（上下文不足时按人设随机生成、每次不同），不使用固定模板；每个数字人与 RunningHub 的通讯全程落日志，统一前缀 `[RB][角色名]`。

### 陪伴场景与回复风格
`core/scenes.ts` 提供日常 / 约会 / 安慰 / 亲密 / 睡前等场景，驱动关系风格与情绪预设，作为 `system` 上下文影响回复。

### 语音与形象
- 文本回复可选 TTS 语音回放（失败时回退浏览器语音）。
- 形象支持头像 + 情绪表情图、`avatarType=video` 情绪视频、以及 Web 端 GLB/GLTF 3D 模型。
- 情绪识别驱动表情 / 视频 / 3D 动作切换。

### 设置页二次密码
`core/settings-auth.ts` 以加盐 SHA256 存储密码，Token 内存态 2h 滑动过期，拦截 `/api/settings*`，含防爆破（5 次锁 5 分钟），修改密码后旧令牌全部作废。

---

## 技术架构

- **monorepo（pnpm workspace）**：
  - `server/`：Node + Express API，运行于 `127.0.0.1:8787`
  - `web/`：React + Vite 前端
  - `wechat-mini/`：微信小程序源码
  - `mobile/`：Capacitor 打包配置（用于 iOS）
- **生产运行**：后端以 systemd 服务形式运行（单元名沿用既有部署配置 `digital-girlfriend.service`），由 `tsx` 启动 `server/src/index.ts`，前置 Nginx 反代。
- **AI 后端**：走本机 OmniRoute 网关（`OPENAI_BASE_URL` + `OPENAI_MODEL=ds`）；`DG_UNRESTRICTED_CHAT=true` 开启 18+ 内容。
- **TTS / ASR**：云端语音合成服务（voice=冰糖）。
- **Telegram**：Bot 以 polling 模式运行，每个数字人可绑定独立 Bot。

---

## 使用方法

### 一、本地开发

```bash
# 安装依赖（pnpm 优先，npm 亦可）
npm install

# 开启后端（另一个终端）
cd server && npm install && cp .env.example .env
npm run dev

# 开启网站（另一个终端）
cd web && npm install
npm run dev
```

启动后：后端默认 `http://127.0.0.1:8787`，Web 前端默认 `http://localhost:5173`。

一键同时启动前后端：

```bash
npm run dev:all
```

### 二、服务端部署

1. 将 `server/` 与 `web/` 源码部署到服务器；
2. 构建前端：`web/` 下使用仓库根 `node_modules/.bin/vite build`（pnpm workspace 依赖会被提升安装到根目录）；
3. 将构建产物 `web/dist/` 放入站点目录（如 `/var/www/dg`），由 Nginx 反代并提供静态访问；
4. 以后端 systemd 服务运行 `server/src/index.ts`，前置 Nginx 反代到 `127.0.0.1:8787`；
5. 配置环境变量（OmniRoute 网关地址、模型名、TTS Key、`DG_UNRESTRICTED_CHAT` 等）。

> 注意：请勿直接运行会清空 Nginx 站点配置的部署脚本；前端改动应只更新 `web/src` 源码与 `dist` 产物，避免影响同机其他站点。

### 三、网页系统设置（给管理员）

1. 访问站点，进入「系统设置页」；
2. **首次访问（未设置过密码）**：设置页会自动显示「设置访问密码」表单，输入两次新密码（至少 4 位）即可完成初始化并直接解锁——无需 SSH、无需手动生成文件。之后其他接手者都用此密码进入设置页。
3. **已初始化后**：输入**二次密码**解锁即可进入；
4. 在对应 Tab 配置 LLM / TTS / 生图 / 提示词 / 数字人，点击保存即生效；
4. 「拍张照」相关：在生图 Tab 配置触发词（多个）、超时秒数、RunningHub API Key；
5. 修改某数字人的 Telegram Bot Token 后，需点「重启服务」使新 Token 生效。

### 四、Telegram 使用

- 每个数字人在配置中绑定独立 `telegramBotToken`，服务以 polling 模式各自拉取私聊消息；
- 用户直接私聊对应 Bot 即可对话；发送触发词即可触发「拍张照」生图流程。

### 五、数据与记忆管理

为避免多端记忆互相串扰，以下数据以**后端为唯一真源**：
- **聊天历史**：`server/src/data/sessions/`，按角色存为 `mem-<characterId>`；切角色时前端 `GET /api/session/mem-<characterId>` 加载并与本地合并。
- **长期记忆 / 关系 / 禁忌**：`server/src/data/user-memories/<id>.json`，经 `GET/PUT/DELETE /api/user-memory/:characterId` 读写；聊天禁忌以该记忆为权威主源。
- **前端隔离**：按角色分别存储，Lina / Moon / 自定义数字人的后端历史与长期记忆互不干扰。

---

## API 概览

| 接口 | 说明 |
|------|------|
| `GET /api/digital-humans` | 数字人列表 |
| `POST /api/digital-humans` | 创建自定义数字人 |
| `DELETE /api/digital-humans/:id` | 删除自定义数字人 |
| `POST /api/chat` | 同步对话 |
| `POST /api/chat/stream` | SSE 流式对话（返回 `chunk` / `emotion` / `done` 事件） |
| `POST /api/transcribe` | 语音转写 |
| `GET /api/session/mem-<characterId>` | 加载某角色会话历史 |
| `GET/PUT/DELETE /api/user-memory/:characterId` | 读写长期记忆 |
| `GET /api/settings` | 读取系统配置（脱敏，需二次密码 Token） |
| `PUT /api/settings` | 更新系统配置（保存即生效） |
| `POST /api/settings/prompts/reset` | 恢复默认提示词 |
| `POST /api/settings/llm/models` | 拉取模型列表 |
| `POST /api/settings/auth` | 二次密码登录 |
| `POST /api/settings/auth/password` | 修改二次密码 |
| `POST /api/settings/restart-service` | 重启后端服务 |

---

## 部署到各端

- **网站**：将 `web/dist` 部署到任意静态托管（Nginx、Cloudflare Pages、Vercel 等）。
- **微信小程序**：在微信开发者工具导入 `wechat-mini/`，将后端地址对齐到 `app.js` 的 `apiBase`，配置 request 合法域名后上传审核。
- **iOS（Capacitor）**：`npm run build:ios` 先构建 Web 包，`npm run sync:ios` 同步到 `ios/`，`npm run open:ios` 打开 Xcode 打包。

---

## 目录结构

- `server/`：Node + Express API 服务
- `web/`：网站前端（React + Vite）
- `wechat-mini/`：微信小程序源码
- `mobile/`：Capacitor 打包配置（iOS）

---

## 合规说明

- 平台默认不做严格敏感词过滤，便于自由表达。
- 真实上线前建议加入：年龄确认与未成年人保护、用户反馈/举报机制、数据留存与隐私说明（语音/聊天内容脱敏）、区域化合规（尤其是跨境存储）。
