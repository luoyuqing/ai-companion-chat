# AI伴聊 · AI Companion Chat

> 一个可自托管的 AI 陪伴聊天平台：**一套后端 API，覆盖 Web / 微信小程序 / iOS / Telegram 四端**。
> 支持多数字人管理、跨端共享记忆、全局提示词编排、多语音引擎，以及「一角色一机器人」的 Telegram 陪伴体验。

**English:** AI Companion Chat is a self-hostable, multi-platform AI companion platform. One backend serves a React web app, a WeChat mini-program, an iOS (Capacitor) shell, and Telegram bots. It features multi-character management, cross-device persistent memory, editable system prompts, pluggable LLM/TTS providers, and per-character Telegram bots.

---

## ✨ 功能亮点

| # | 亮点 | 说明 |
|---|------|------|
| 1 | **多端覆盖** | Web（React PWA，可安装到桌面/手机）、微信小程序、iOS（Capacitor 壳）、Telegram 机器人，共用同一套后端 API |
| 2 | **多数字人管理** | 网页端创建 / 编辑 / 删除数字人，支持头像上传、3D 模型（GLB/GLTF）、情绪图 / 情绪视频，以及按角色独立的音色与机器人 Token |
| 3 | **跨端共享记忆** | 会话以 `mem:<角色Id>` 存于服务端，换浏览器 / 电脑 / 小程序打开同一角色自动续上；支持「记忆总结模式」压缩长上下文 |
| 4 | **全局提示词可编排** | 人设 / 场景 / 语气 / 记忆总结等模板全局可编辑，存于服务端配置，网页「系统设置 → 提示词」即可改，可一键恢复默认 |
| 5 | **多语音引擎（MiMo）** | TTS 支持预置音色 / 声音设计（文字描述）/ 声音克隆（音频样本）三种模式，ASR 负责语音输入转写 |
| 6 | **一角色一机器人** | 每个数字人可绑定独立 Telegram Bot Token，专属机器人只服务该角色，记忆按角色天然隔离 |
| 7 | **主动关怀推送** | 可配置的定时主动推送（proactive scheduler），经专属机器人向用户发送关怀消息 |
| 8 | **陪伴场景与语气** | 内置日常陪伴 / 虚拟约会 / 情绪安慰 / 暧昧互动 / 睡前陪伴等场景，以及「一点即聊」的快速互动（抱抱、牵手、耳语、依靠、晚安）；语气风格支持温柔 / 轻声 / 沉稳 |
| 9 | **设置二次密码** | 系统设置页（LLM / TTS / 提示词 / 安全）带内存级二次密码保护，避免他人误改关键配置 |
| 10 | **长期用户记忆** | 可保存用户称呼、聊天偏好、重要事实、聊天禁忌与关系备注，作为 `system` 上下文持续影响回复 |

> 注：亲密 / 暧昧类场景需完成**成年确认**后解锁；未确认时仅提供恋爱暧昧风格，不进入露骨内容。

---

## 🧩 技术栈

| 层 | 技术 |
|----|------|
| 后端 | Node.js + Express + TypeScript（`tsx` 运行） |
| 前端 Web | React 18 + Vite + TypeScript，PWA 可安装 |
| 微信小程序 | 原生小程序源码 |
| iOS | Capacitor 壳（复用 Web 构建产物） |
| LLM | OpenAI 兼容协议（默认 OmniRoute / DeepSeek `ds`，可在设置中切换） |
| 语音 | MiMo TTS / ASR（预置音色 / 声音设计 / 声音克隆） |
| 机器人 | Telegram（`grammy`） |
| 包管理 | npm workspaces（也可用 pnpm） |

---

## 📂 目录结构

```
.
├── server/            # Node + Express 后端 API（:8787）
│   └── src/
│       ├── core/      # config / prompts / scenes / settings-auth
│       ├── services/  # llm / tts / transcription / session / userMemory
│       ├── telegram/  # bot.ts / proactive.ts（主动推送）
│       └── data/      # 数字人数据 + 运行时会话/配置（部分 gitignore）
├── web/               # React + Vite 网站前端（可构建为 PWA）
├── wechat-mini/       # 微信小程序源码
├── mobile/            # Capacitor iOS 打包配置
├── scripts/           # 开发联调 / 发布辅助脚本
├── deploy.sh          # 部署脚本（⚠️ 见下方「部署」注意事项）
└── package.json       # npm workspaces 根配置
```

---

## 🏁 快速开始（本地开发）

### 环境要求
- Node.js ≥ 20
- npm（或 pnpm）

### 1. 安装依赖
```bash
npm install
```

### 2. 配置后端
```bash
cd server
cp .env.example .env      # 然后编辑 .env，填入 LLM / TTS / 可选 Telegram 的密钥
```
关键变量见下文「配置说明」。

### 3. 启动后端
```bash
cd server
npm run dev               # tsx watch，默认 http://127.0.0.1:8787
```

### 4. 启动前端
```bash
cd web
npm install
npm run dev               # Vite，默认 http://localhost:5173
```
打开 `http://localhost:5173/` 即可进入聊天页。Vite 会自动把 API 请求指向同机 `:8787`。

> 一键启动前后端：`npm run dev:all`（根目录脚本，同时拉起 8787 与 5173）。

### 5. 微信小程序 / iOS（可选）
- 小程序：微信开发者工具导入 `wechat-mini/`，将 `app.js` 中 `globalData.apiBase` 指向你的后端公网地址，并在小程序后台配置 request 合法域名。
- iOS：见下文「部署 → iOS」。

---

## ⚙️ 配置说明（`server/.env`）

| 变量 | 说明 | 示例 |
|------|------|------|
| `OPENAI_API_KEY` | LLM 密钥（OpenAI 兼容） | `sk-xxxx` |
| `OPENAI_BASE_URL` | LLM 接口地址 | `https://3585616.xyz/v1` |
| `OPENAI_MODEL` | LLM 模型名 | `ds` |
| `MIMO_API_KEY` | MiMo TTS / ASR 密钥 | `sk-xxxx` |
| `MIMO_BASE_URL` | MiMo 接口地址 | `https://api.xiaomimimo.com/v1` |
| `MIMO_TTS_MODEL` | TTS 模型 | `mimo-v2.5-tts` |
| `MIMO_TTS_VOICE` | 默认预置音色 | `冰糖` |
| `TTS_PROVIDER` | 语音引擎 | `mimo` |
| `MIMO_ASR_MODEL` | ASR 模型 | `mimo-v2.5-asr` |
| `ASR_PROVIDER` | 转写引擎 | `mimo` |
| `DG_UNRESTRICTED_CHAT` | 是否解除对话内容限制 | `true` / `false` |
| `PORT` | 后端监听端口 | `8787` |
| `HOST` | 后端监听地址 | `127.0.0.1` |
| `TELEGRAM_BOT_TOKEN` | 通用 Telegram Bot Token（留空不启动） | — |
| `TELEGRAM_WEBHOOK` | 可选 webhook 地址（否则 polling） | — |
| `ALLOWED_TG_USER_ID` | 允许使用的 TG 用户 ID（留空则首位 `/start` 用户成为主人） | `123456789` |

> LLM / TTS / 提示词等配置也可在网页「系统设置」中运行时修改，无需重启后端；只有 `.env` 里的密钥和 Telegram Bot Token 变更需要重启服务。

---

## 🖥️ 系统设置与提示词

网页端进入「系统设置」（需二次密码，仅内存保存，刷新即锁）包含四个分区：

- **LLM**：接口地址 / 密钥 / 模型（可拉取模型清单选择或手填）/ 视觉支持开关
- **TTS**：语音引擎配置（MiMo 的 baseUrl / 模型为只读展示，仅可配密钥）
- **提示词**：全局可编辑的人设 / 场景 / 语气 / 记忆总结模板，支持「恢复默认」
- **安全**：修改设置二次密码

提示词模板存于服务端 `server/src/data/system-config.json`（已 gitignore，含密钥），改完立即生效。

---

## 👤 数字人管理

- **创建 / 编辑 / 删除**：网页端操作，头像可上传，支持 GLB/GLTF 3D 模型地址与本地上传、情绪图（`emotionProfile`）与情绪视频（`avatarVideoProfile`）。
- **按角色独立配置**：每个数字人可单独设置音色（含声音设计 / 克隆）、以及绑定独立 **Telegram Bot Token**（实现「一角色一机器人」）。
- **数据位置**：预置与覆盖数据在 `server/src/data/{custom-humans,human-overrides,digital-humans}.json`；用户创建的数字人持久化到 `custom-humans.json`。

---

## 🔗 跨端记忆

- 每个角色的会话以 `mem:<角色Id>` 为 key 存于服务端 `server/src/data/sessions/mem-<角色Id>.json`。
- 网页端、小程序端、Telegram 机器人共用同一份记忆（通用 bot 主人与网页端共享 `mem:<id>`，其余授权 TG 用户各自独立）。
- 支持「记忆总结模式」：将长对话压缩为条目式档案，避免短上下文模型遗忘。
- `/reset`（机器人）或网页「清空对话」会清空该角色两端记忆。

---

## 🤖 Telegram 机器人

- **通用机器人**：通过 `TELEGRAM_BOT_TOKEN` 启动，支持命令
  `/start /help /list /select /scene /action /style /voice /summary /new /edit /delete /reset /export /import /cancel`，
  支持文字 / 语音（OGG→WAV→ASR）/ 图片（头像）输入，语音回复经 MP3→OGG/Opus 回传。
- **专属机器人（一角色一机器人）**：在数字人编辑表单填写 `Telegram Bot Token`，服务启动时会为每个含 Token 的角色拉起独立 bot，只服务该角色、记忆隔离；新增 / 修改 Token 后需重启后端服务。
- **主动推送**：`server/src/telegram/proactive.ts` 提供定时主动关怀消息能力，经专属机器人下发。

---

## 📡 API 概览

常用端点（完整列表见 `server/src/index.ts`）：

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/healthz` | 健康检查 |
| GET | `/api/digital-humans` | 数字人列表 |
| POST | `/api/digital-humans` | 创建自定义数字人 |
| DELETE | `/api/digital-humans/:id` | 删除自定义数字人 |
| POST | `/api/chat` | 非流式对话 |
| POST | `/api/chat/stream` | SSE 流式对话（返回 `meta`/`chunk`/`emotion`/`done` 事件） |
| POST | `/api/transcribe` | 语音转写（ASR） |
| POST | `/api/tts` | 文本转语音（TTS） |
| GET/PUT | `/api/settings` | 读取 / 更新系统设置（LLM / TTS / 提示词，密钥脱敏返回） |
| POST | `/api/settings/prompts/reset` | 恢复提示词默认 |
| GET/DELETE | `/api/session/:id` | 读取 / 清空某角色会话 |
| POST | `/api/session/:id/import` | 导入记忆 JSON 写回 |
| POST | `/api/session/:id/summary` | 开启 / 关闭记忆总结 |
| GET/POST | `/api/user-memory` | 长期用户记忆读取 / 更新 |
| POST | `/api/models/upload` | 上传 GLB/GLTF 模型 |

---

## 🚢 部署

### Web 前端（静态）
构建后将 `web/dist` 部署到任意静态服务（Nginx / Cloudflare Pages / Vercel）：
```bash
npm run build:web        # 等价于 npm run build --workspace @dg/web
```
- 设置 `VITE_API_URL` 指向后端公网地址（如 `https://ai.example.com`）；不设置时前端 API 基址自动取当前域名（适用于 Nginx 同机反代）。
- 网页支持 PWA 安装（需 HTTPS），离线时可打开静态聊天界面并读取本机 `localStorage`。

### 后端（systemd + Nginx 反代）
```bash
cd server
npm install
cp .env.example .env && vim .env
npm run build            # 可选：tsc 类型检查
# 用 tsx 或编译后的 js 以 systemd 服务运行，监听 127.0.0.1:8787
```
Nginx 将 `ai.example.com` 的 `/api/`、`/audio/`、`/models/` 等反代到 `127.0.0.1:8787`。

### iOS（Capacitor）
```bash
npm run build:ios        # 先构建 Web，再构建 iOS 工程
npm run sync:ios         # 同步最新 Web 包到 ios/
npm run open:ios         # 打开 Xcode 打包 .ipa（企业签名 / TestFlight）
```
打包前建议设置 `VITE_API_URL=https://你的后端地址`，避免移动端请求到文件 origin。

### ⚠️ 部署脚本注意事项
仓库根目录 `deploy.sh` 内含 `rm -f /etc/nginx/sites-enabled/*` 与 `rm -rf /var/www/dg/*` 等**破坏性操作**，仅适用于「独占的全新服务器」一键部署。**在已运行其他站点（如 OmniRoute / SillyTavern / 反向代理）的共享服务器上切勿直接运行该脚本**，否则会清掉其他站点。共享服务器请改用定向 SCP 部署：
```bash
npm run build:web
scp -r web/dist/* user@host:/var/www/dg/      # 原子切换前端目录
scp -r server/src user@host:~/dg/server/      # 同步后端源码
ssh user@host 'sudo systemctl restart digital-girlfriend'
```

---

## 🛡️ 合规说明

- 本项目默认不做严格敏感词过滤（按需求「不设限」设计）。
- 亲密 / 暧昧类场景需用户完成成年确认后解锁。
- 真实上线前建议补充：未成年人保护、用户反馈 / 举报机制、聊天与语音数据的留存与隐私说明、以及区域化合规（尤其是跨境存储）。

---

## 📄 License

[MIT](./LICENSE)
