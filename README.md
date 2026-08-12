# 数字女友数字人平台（网站 + 小程序 + iOS）

该仓库用于快速搭建「数字女友」产品的基础形态，目标平台：
- Web 站点（React + Vite）
- 微信小程序（标准小程序源码）
- iOS（Capacitor 壳）

目标能力：
- 多数字人管理（可创建新数字人）
- AI 对话接口（`/api/chat`）
- 情绪识别驱动的表情切换
- 文本回复可选 TTS 语音回放（可单独配置 `OPENAI_TTS_API_KEY`，失败时回退浏览器中文女声）
- Web 端支持语音输入、自动语音开关、逐条重播，以及温柔 / 轻声 / 沉稳三种浏览器语音节奏
- 数字人创建与切换（头像/默认情绪同步显示）
- Web 端支持 GLB/GLTF 3D 模型地址与本地上传，聊天情绪会继续驱动 3D 外层动作
- Web 端支持陪伴场景切换（日常、约会、安慰、18+ 亲密、睡前），场景会进入下一轮 `system` 上下文并影响静态 fallback / 真实后端回复
- 18+ 亲密模式需要先完成成年确认；确认后可使用更直接的成年人自愿亲密表达，未确认时仍可恋爱暧昧但不进入露骨内容
- Web 端内置两张 ComfyUI 本地生成的虚构成年混血人物肖像，2D 模式会以竖幅照片舞台呈现人物，同时保留说话状态和 3D 切换
- Web 端支持一点即聊的亲密互动：抱抱、牵手、耳语、依靠、晚安；每个动作都会切换对应场景、触发照片动画并直接开始一轮聊天
- 小程序端创建数字人也会保留 `modelUrl`，并提供 3D/2D 低性能回退状态提示
- Web / 小程序 / iOS 的同一会话与数字人配置使用同一套 API
- 支持数字人实时表情图/视频映射（`avatarType=video`）

## 目录

- `server/`：Node + Express API 服务
- `web/`：网站前端
- `wechat-mini/`：微信小程序源码
- `mobile/`：Capacitor 打包配置（用于 iOS）

## 本地启动（开发）

> 网络环境中如果 pnpm 无法安装，请用 npm 管理依赖（示例命令已改用 npm）。

```bash
# 安装依赖
npm install

# 开启后端（另外一个终端）
cd server && npm install && cp .env.example .env
npm run dev

# 开启网站
cd web && npm install
npm run dev
```

## GitHub Pages 发布（可直接访问）

建议在 GitHub 上新建仓库后，按以下步骤直接发布到 GitHub Pages：

发布成功后，默认访问地址为：

`https://<你的GitHub用户或组织>.github.io/<你的仓库名>/`

1. 在仓库 Settings → Secrets and variables → Actions 中新增环境变量（可选，推荐 Repository variable）：
   - `VITE_API_URL`（你的后端公网地址，例如 `https://api.xxx.com`）
2. 保证主分支推送到 `main`。
3. Push 后 `.github/workflows/gh-pages.yml` 会自动执行：
   - `npm run build:web`（即 `npm run build --workspace @dg/web`）
   - 自动上传构建产物并发布到 GitHub Pages（`workflow` 模式）。
   - workflow 会设置 `VITE_BASE_PATH=/digital-girlfriend/`，保证 GitHub Pages 子目录下的 JS/CSS/图片路径稳定。
   - 构建会同时生成 `404.html`，用于 GitHub Pages 静态站点的 SPA 路由兜底；直接访问或刷新 `/chat` 等子路径不会落到 GitHub 的默认 404 页。

未配置 `VITE_API_URL` 时，GitHub Pages 会自动启用前端本地静态体验：内置数字人可加载，聊天会用本地流式回复，表情、关系状态和浏览器语音播报仍可使用；用户创建的数字人、当前 3D/2D 模式、每个数字人的聊天记录和关系状态会保存在当前浏览器 `localStorage`，刷新后仍可继续使用。配置公网 API 后会优先使用真实后端。

聊天页左侧支持“长期记忆”：用户可主动保存自己的称呼、聊天偏好、重要事实、聊天禁忌和关系备注。保存后，下一条消息会把这段记忆作为 `system` 上下文发送给静态 fallback 或真实后端，让数字人自然使用这些偏好，而不是每轮重新询问。网页版与微信小程序都已支持这套本地记忆。

聊天页右侧支持“陪伴场景”：可在日常陪伴、虚拟约会、情绪安慰、亲密 18+、睡前陪伴之间切换，也可点击场景快捷话题快速发起对话。场景会同步关系风格和情绪预设，并作为 `system` 上下文影响静态 Pages fallback、流式后端和真实模型回复。亲密 18+ 场景只在用户确认成年后生效。

## ComfyUI 原创人物图

仓库包含可重复生成主人物肖像的 API workflow：

`scripts/comfyui-adult-companion.json`

默认使用 `juggernautXL.safetensors`，正向提示明确角色为 28 岁虚构成年人，负向提示排除未成年、真人明星、裸体和露骨画面。当前内置图及种子记录在 `web/public/assets/avatars/PHOTO_CREDITS.md`。本机 ComfyUI 启动后可提交该 workflow：

```bash
jq -c '{prompt: .}' scripts/comfyui-adult-companion.json \
  | curl -X POST http://127.0.0.1:8188/prompt \
      -H 'Content-Type: application/json' --data-binary @-
```

静态体验还支持“导出记录 / 导入记录”：导出的 JSON 会包含本机自定义数字人、聊天记录、关系状态、长期记忆、当前会话和 3D/2D 模式；在另一台设备或另一个浏览器导入后会自动刷新并恢复对应体验。该导入只写入项目白名单内的本地键，不会写入任意浏览器存储。微信小程序的“迁移记录”面板使用同一 JSON schema，可通过剪贴板和网页版互相迁移。

本地一键验证（按你要求）：

```bash
# 安装依赖
npm install

# 打包网站
npm run build:web

# 本地联调（后端+网站）
npm run dev:all
```

验证 8787 提示页与 5173 页面：

```bash
curl -I http://127.0.0.1:8787/ | head -n 1
```

应返回 200，并在页面上看到「请访问 5173」提示；再打开 `http://127.0.0.1:5173/` 能进入聊天页。

## 一键启动（后端 + 网站）

```bash
npm run dev:all
```

该命令会同时启动：
- 后端 API（默认 `http://127.0.0.1:8787`）
- Web 前端（默认 `http://localhost:5173`）

可通过环境变量改端口：

```bash
PORT=19010 npm run dev:all
```

退出可按 `Ctrl + C`，会一并关闭两个进程。

发布前统一配置（建议先执行）：

```bash
WECHAT_API_BASE=https://你的后端域名 \
WECHAT_APP_ID=你的小程序AppID \
IOS_APP_ID=com.yourcompany.digitalgirlfriend \
npm run setup:platform-config
```

也可使用 `.env.release` / `.env.release.example` 一次性配置：

```bash
cp .env.release.example .env.release
# 编辑 .env.release 后
npm run setup:release
```

本地联调（不阻塞占位小程序/AppID）可以先用：

```bash
DG_ALLOW_PLACEHOLDER_IDS=true npm run setup:release
DG_ALLOW_PLACEHOLDER_IDS=true npm run verify:ready
```

`setup:release` 会顺带跑三端安装能力检查（PWA 安装资产、微信小程序配置、iOS 配置）：

```bash
npm run verify:ready
```

也可一次性跑：

```bash
npm run verify:release
```

说明：
- `verify:ready` = `verify:install-readiness + verify:release`；
- `verify:release` = `check:release` +（如设置 `API_BASE`）`verify:all`；
- `verify:all` 会在本机服务验收可用时执行流式/会话/数字人闭环检查（需先启动后端并设置 `API_BASE`）。
- `DG_ALLOW_PLACEHOLDER_IDS=true` 为本地试运行/开发模式（不把 demo 占位 appId/domain 当阻塞项）；发布前请改用正式配置并移除该环境变量。

`npm run setup:release` 已内置：
1) 执行 `setup:platform-config`
2) 执行 `verify-install-readiness`
3) 执行 `check:release`
4) 如检测到 `WECHAT_API_BASE` / `API_BASE`，自动执行 `verify:all`

## 网页可安装（PWA）

项目现在支持网页安装增强（生产环境）：

- `web/public/manifest.webmanifest`
- `web/public/sw.js`
- `web/src/main.tsx`（生产环境自动注册）
- `web/src/App.tsx`（安装引导按钮）

访问站点时，若浏览器支持，会出现“安装网页版（可直接进入）”按钮。安装后可像 App 一样从主屏启动。

当前 `sw.js` 会在安装时缓存 app shell、manifest、图标、默认头像、情绪表情以及 Vite 构建后的 hash JS/CSS；页面导航在离线时会回退到 `index.html`。因此已安装的网页版在无网络时仍能打开静态聊天界面，并继续读取本机 `localStorage` 中的数字人、聊天记录和关系状态。远程 `/api/*`、`/audio/*`、`/models/*` 仍保持网络直连，断网时会交给前端静态 fallback 处理。

## 三端跳转链接（可选）

如你要在网页页头直接放出小程序 / iOS 入口，设置以下环境变量即可：

- `VITE_WECHAT_MINI_LINK`：微信小程序跳转链接（开放平台链接或自定义页面）。
- `VITE_WECHAT_MINI_QRCODE`：小程序体验码图片地址（可直接打开图片）。
- `VITE_IOS_APP_LINK`：iOS App Store 或 TestFlight 链接。
- `VITE_IOS_INSTALL_HINT`：iOS 安装说明（例如：请到 TestFlight 安装内测版本）。

示例：

```bash
VITE_WECHAT_MINI_LINK=https://mp.weixin.qq.com/....   # 如有
VITE_WECHAT_MINI_QRCODE=https://example.com/mini_qr.png
VITE_IOS_APP_LINK=https://apps.apple.com/app/你的应用/idxxxx
VITE_IOS_INSTALL_HINT=当前需 TestFlight 内测，请先加开发者白名单
```

说明：当前离线策略采用 app shell + 静态资源优先缓存，`/api/*`、`/audio/*`、`/models/*` 仍走网络请求；如需真正跨设备同步和远程模型离线缓存，需要接入正式后端和 CDN 缓存策略。

## 联调验收

```bash
npm run verify:all
```

默认检查：
- `GET /healthz`
- `GET /api/digital-humans`
- `POST /api/chat`

如服务不在本机，请设置：

```bash
API_BASE=https://your-api.example.com
npm run verify:all
```

新增说明：

- 当前脚手架已加上 `DELETE /api/digital-humans/:id`，便于清理自定义数字人。
- 验收脚本会在创建临时数字人后自动回收，避免 `custom-humans.json` 被持续污染。
- 建议上线前保持 `server/src/data/custom-humans.json` 只保留你希望长期展示/可选的人物数据（初始可为空）。

也可只跑“数字人闭环”验收（创建数字人 + 对话流 + 情绪切换 + 清理）：

```bash
API_BASE=http://127.0.0.1:8787
npm run verify:digital-human-loop
```

## 本地开发 API 地址说明

- Web 端优先级：`VITE_API_URL` > `window.__DG_API_BASE` > 自动推断地址。  
  在本地双服务启动时，自动推断会优先尝试 `http://<host>:8787`（原样支持 localhost / 127.0.0.1 / [::1]）。
- 小程序端继续通过 `WECHAT_API_BASE` 指向后端域名。

## API 概览

### `GET /api/digital-humans`
返回可用数字人列表（`id / name / description / avatarUrl / modelUrl / emotionProfile / avatarType / avatarVideoProfile / voiceProfile / defaultMood`）。

### `POST /api/digital-humans`
创建自定义数字人（开发态持久化到 `server/src/data/custom-humans.json`）：

```json
{
  "name": "Lina 2",
  "description": "活泼甜美",
  "avatarUrl": "/assets/avatars/lina2.png",
  "modelUrl": "https://your-cdn/models/lina.glb",
  "voice": "nova",
  "personalityTagline": "轻松甜蜜，但不失礼貌。",
  "relationshipMode": "sweet",
  "defaultMood": "happy",
  "emotionProfile": {
    "happy": "https://your-cdn/emotion/happy.png",
    "sad": "https://your-cdn/emotion/sad.png"
  },
  "avatarType": "video",
  "avatarVideoProfile": {
    "happy": "https://your-cdn/video/happy.mp4",
    "sad": "https://your-cdn/video/sad.mp4"
  }
}
```

说明：
- `avatarType`：`image`（默认）或 `video`
- `avatarType=image` 时读取 `emotionProfile`（情绪图）
- `avatarType=video` 时读取 `avatarVideoProfile`（情绪视频）
- `modelUrl`：可选 GLB/GLTF 模型地址；Web 端开启 3D 模式时优先加载该模型，未配置或加载失败会回退到内置程序化 3D 形象
- `personalityTagline`：补充角色人设偏好
- `relationshipMode`：关系风格，可填 `sweet`、`flirty`、`playful`、`mature`

### `POST /api/models/upload`

上传 GLB/GLTF 模型文件（JSON base64），服务端会保存到 `server/data/models` 并返回可访问的 `/models/...` 地址：

```json
{
  "fileName": "lina.glb",
  "fileBase64": "base64模型文件内容",
  "mimeType": "model/gltf-binary"
}
```

返回示例：

```json
{
  "modelUrl": "/models/lina-mqxyz-abc123.glb",
  "fileName": "lina-mqxyz-abc123.glb",
  "mimeType": "model/gltf-binary",
  "size": 123456
}
```

说明：
- 支持 `.glb` / `.gltf`，单文件上限 25MB。
- Web 创建页选择本地 GLB/GLTF 文件时，会优先上传到该接口；静态 Pages 无后端时会自动保留本地临时预览。

### `DELETE /api/digital-humans/:id`
删除自定义数字人（仅移除 `custom-humans.json` 中用户创建项），示例：

```bash
curl -X DELETE "https://your-api.example.com/api/digital-humans/custom-1680000000000"
```

默认会返回：

```json
{ "ok": true }
```

### 行为策略配置

- 环境变量 `DG_UNRESTRICTED_CHAT` 控制回复限制：
  - `true`（默认）：按角色关系风格输出，不额外拦截聊天内容
  - `false`：改为较保守回复策略

### `POST /api/chat`

```json
{
  "sessionId": "session-01",
  "characterId": "lina",
  "message": "今天过得好吗？",
  "history": [{ "role": "user", "content": "..." }]
}
```

返回：

```json
{
  "sessionId": "session-01",
  "characterId": "lina",
  "text": "我也挺好的，想和你聊一会儿…",
  "emotion": "happy",
  "audioUrl": "/audio/xxx.mp3"
}
```

### `POST /api/chat/stream`

SSE 流式接口，返回事件：

- `meta`：会话元信息
- `chunk`：文本增量片段
- `emotion`：情绪增量
- `done`：完整文本和语音地址

### `POST /api/transcribe`

浏览器语音输入在不支持 Web Speech 的环境下会走录音文件转写链路。

请求体：

```json
{
  "audioBase64": "base64 音频内容",
  "mimeType": "audio/webm",
  "language": "zh"
}
```

返回：

```json
{ "text": "用户说的话" }
```

后端转写目前使用 OpenAI Whisper（`OPENAI_API_KEY` 未配置时返回错误）。

## 真实 3D 数字人和高质量语音

当前版本支持多种形象方式：

- 默认采用头像 + 情绪表情图；
- 可选 `emotionProfile`（JSON 映射）为不同情绪配置独立图片，服务端和端侧将按实时情绪事件切换形象；
- 新增 `avatarVideoProfile` 后可在 `avatarType=video` 下按情绪播放视频，替代静态图层。
- Web 端可在创建数字人时填写 `modelUrl` 或上传本地 GLB/GLTF 模型；3D/2D 开关开启 3D 时会优先加载该模型，聊天情绪会复用同一套 3D 外层动作。
- 小程序端可在创建数字人时填写 `modelUrl` 并保留到同一套数字人配置；当前小程序形象仍以 2D 表情/视频预览为主，页面会显示 3D/2D 回退状态，方便低性能设备一键切换语义状态。
- 项目已内置 `/assets/expressions/{emotion}.svg`（happy / sad / surprise / wink / neutral / angry / love）用于默认数字人的情绪图形化显示。

可在 `web/src/components/Avatar.tsx` 与 `web/src/components/ChatPanel.tsx`、`server/src/services/tts.ts`
替换为：
- 更完整的 VRM/Live2D 数字人渲染组件
- 第三方数字人合成/播报服务（如 D-ID、HeyGen、Azure Speech）
- 真实口型同步（WebRTC/Lip-sync）

## 微信小程序部署

1. 在微信开发者工具中导入 `wechat-mini/` 目录。
2. 将 `app.js` 中 `globalData.apiBase` 替换为后端公网地址（示例：`https://api.example.com`）。  
   已在发布前配置脚本支持一次性替换，可执行：
   - `WECHAT_API_BASE=https://api.example.com WECHAT_APP_ID=... npm run setup:platform-config`

   同时在小程序后台配置 request 合法域名，至少包含：
   - `https://api.example.com`
   - `https://api.example.com/audio`
   - `https://api.example.com/assets`
3. 小程序端已支持：
   - 自动拉取数字人列表并切换当前数字人
   - 创建数字人（会话内保持配置）
   - 文字返回打字机式展示（每段文字同步更新情绪）
   - 形象展示（头像 + 实时表情）
   - `avatarType` 与 `avatarVideoProfile` 创建参数
   - `modelUrl` 创建参数与 3D/2D 回退状态提示
   - 创建数字人时可填写 `emotionProfile`（JSON），例如为 `happy`/`sad`/`love` 指定图片地址
   - 语音自动播放
4. 配置小程序域名白名单：`https://<你的域名>`。
5. 小程序当前直接对接 `/api/chat/stream`：若后端返回 `done` 与 `chunk` 事件，客户端会按收到片段/情绪逐步播放文本。
6. 小程序默认头像资源位于 `wechat-mini/assets/avatars`，可替换为你自己的形象素材。
7. `emotionProfile` 可以使用相对地址（如 `/assets/expressions/happy.svg`）或绝对地址。

## 语音与数字人形象说明

- 当前语音链路：
  - 后端有 `OPENAI_API_KEY`：返回 `/audio/xxx.mp3`，网站端会通过音频标签播放。
  - 后端无 `OPENAI_API_KEY`：网站端自动回退为浏览器语音合成（Web Speech）。
- 当前形象链路包括 2D 表情切图、情绪视频和 Web 端 GLB/GLTF 3D 模型；后续可替换为完整 VRM/Live2D 引擎或第三方数字人 SDK。

## iOS 打包（Capacitor）

### 前置环境

1. macOS + Xcode（需选择完整开发者工具链）
2. CocoaPods（`sudo gem install cocoapods`）
3. 安装后在命令行切换到完整 Xcode：
   - `sudo xcode-select -s /Applications/Xcode.app/Contents/Developer`

4. 一次构建并同步：`npm run build:for-ios`（可带 `VITE_API_URL=https://你的后端地址`）
5. 第一次初始化 iOS 工程（若提示未初始化）：
   - `cd mobile && npm install`
   - `npm run init:ios`
6. 如果当前 `mobile/ios/` 目录存在但 `ios/App/Podfile` 缺失（表示旧构建不完整），请先执行：
   - `npm run rebuild:ios`
7. 打开 Xcode：
   - `npm run open:ios --workspace @dg/mobile`
   - 或使用根目录快捷命令：
     - `npm run build:ios`
     - `npm run sync:ios`
     - `npm run open:ios`
   - 排障：`npm run doctor:ios`（检查 xcodebuild / xcode-select / CocoaPods / Podfile）

> 新增说明：
> - 根目录 `prepare:ios` 会先构建 Web 再执行 iOS 预构建；
> - `build:ios` 会直接触发 `build:for-ios`；
> - `sync:ios` 会把最新 Web 内容同步到 Capacitor iOS 工程；
> - 若后端非同机部署，优先使用 `WECHAT_API_BASE`（`npm run setup:release` 会自动透传为 `VITE_API_URL`），或直接设置 `VITE_API_URL`；否则移动端可能请求到文件 origin。

> iOS 安装建议：如 Web 包里无法访问到后端，请在打包前设置环境变量
> `VITE_API_URL=https://你的后端地址`，构建后的页面会优先使用该值。

> iOS 本地文件调试下，Web 端 API 地址优先级为：
> `VITE_API_URL` > `window.__DG_API_BASE__` > 当前页面 origin。

## 常见联调问题

- `verify:all` 可能在某些环境遇到 `localhost:8787` 被其他服务占用。若 `/healthz` 不通，可显式执行：
  - `API_BASE=http://127.0.0.1:8787 npm run verify:all`
  - `API_BASE=http://[::1]:8787 npm run verify:all`
- 微信小程序上线前需同步配置合法域名白名单（`request` 域名 + `audio` + `assets`）。

## 交付：安装与发布路径

- 网站：
  - 本地验收无障碍后，可直接部署 `web/dist` 到任何静态站点（Vercel、Cloudflare Pages、Nginx）。
- 微信小程序：
  - 在微信开发者工具内导入 `wechat-mini/`，上传后提交审核即可生成体验版二维码。
  - 上线前将 `app.js` 的 `apiBase` 与正式域名对齐。
- iOS（Capacitor）：
  - `npm run build:ios` 会先构建 Web。
  - `npm run sync:ios` 将最新 Web 包同步到 `ios/`。
  - `npm run open:ios` 打开 Xcode 后打包 `.ipa` 走企业签名或 TestFlight 审核流。

## 联调顺序

1. 先启动后端：`cd server && npm run dev`
2. 启动网站：`cd web && npm run dev`
3. 验证 `/api/chat/stream` 是否返回 `chunk`、`emotion`、`done` 三类事件。
4. 验证网站和小程序都能创建数字人并在聊天中触发情绪切换（表情变化明显）。
5. 验证小程序与 iOS 使用同一套 `sessionId` 能看到连续上下文（可复用角色语气）。

## 合规说明

- 该模板默认不做严格敏感词过滤（按你的需求“不设限”）。  
- 真实上线前建议加入：
  - 年龄确认与未成年人保护
  - 用户反馈/举报机制
  - 数据留存与隐私说明（语音/聊天内容脱敏）
  - 区域化合规（尤其是跨境存储）
