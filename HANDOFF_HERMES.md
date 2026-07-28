# Hermes Handoff - Digital Girlfriend

## Repository

- GitHub repo: https://github.com/MoKangMedical/digital-girlfriend
- Live GitHub Pages: https://mokangmedical.github.io/digital-girlfriend/
- Product feature commit before this handoff document: `97c13817eb888bf106fcef846e936d1746a2b8bc`
- Latest verified Pages workflow before this handoff file: https://github.com/MoKangMedical/digital-girlfriend/actions/runs/27057945427

## Clone And Run

```bash
git clone https://github.com/MoKangMedical/digital-girlfriend.git
cd digital-girlfriend
npm install
npm run build:web
npm run dev:all
```

Expected local URLs:

- Web: `http://127.0.0.1:5173/`
- API: `http://127.0.0.1:8787/`
- API root should show the hint page that points users to the Web app.

## Verified Commands

These passed on the source machine before handoff:

```bash
npm run build:web
npm run build --workspace @dg/server
npm run verify:ready:local
```

Playwright local QA also passed for the Web scene workflow:

- Opened `http://127.0.0.1:5173/`
- Selected `暧昧互动`; verified `localStorage.dg-active-companion-scene-v1 = flirty`
- Clicked quick starter `我有点想你了，哄哄我`
- Sent the message and confirmed the assistant reply included scene-specific fallback text
- Repeated desktop/mobile checks for `睡前陪伴`

## Current Product State

Implemented:

- Web React/Vite chat app, published through GitHub Pages.
- Static Pages fallback when no `VITE_API_URL` is configured.
- Built-in digital humans: `Lina`, `Moon`.
- Custom digital human creation, deletion, import/export.
- GLB/GLTF model URL and upload path for Web; 3D/2D toggle.
- Text chat, streaming fallback replies, emotion detection, avatar expression switching.
- Browser speech input where supported, local/browser speech output fallback, backend TTS hook.
- Long-term user memory in Web and WeChat mini.
- Local archive export/import shared between Web and WeChat mini.
- Companion scenes in Web: `日常陪伴`, `虚拟约会`, `情绪安慰`, `暧昧互动`, `睡前陪伴`.
- Scene selection writes a `system` context message and influences static fallback, server fallback, and OpenAI-backed replies.
- GitHub Pages SPA fallback `404.html`.
- WeChat mini source and iOS Capacitor shell are present.

Important files:

- `web/src/components/ChatPanel.tsx` - primary Web chat/product UI.
- `web/src/services/api.ts` - Web API client and static fallback behavior.
- `web/src/components/Girlfriend3D.tsx` - 3D avatar behavior.
- `server/src/services/llm.ts` - server prompt/fallback/streaming logic.
- `server/src/services/session.ts` - session relationship context.
- `wechat-mini/pages/index/index.js` - mini-program chat, memory, archive import/export.
- `mobile/capacitor.config.ts` - iOS Capacitor config.
- `.github/workflows/gh-pages.yml` - Pages deployment workflow.
- `README.md` - setup, Pages, release, and verification instructions.

## Known External Gates

These are not local code blockers, but they are still required for a real public product:

- Configure a public backend and set `VITE_API_URL` for GitHub Pages.
- Replace WeChat mini placeholder appid `wxlocal000000000001` with the official appid.
- Configure WeChat legal request/upload/download domains.
- Prepare iOS signing, Team ID, TestFlight/App Store metadata, and production bundle settings.
- Decide production model/TTS providers and secret management.

## Recommended Next Work For Hermes

1. Upgrade `.github/workflows/gh-pages.yml` action/runtime versions to remove the Node 20 deprecation annotations.
2. Port Web companion scenes to `wechat-mini/pages/index/*` so mini-program interaction matches Pages.
3. Add a visible release/commit indicator in Web, so the user can confirm the deployed build from the UI.
4. Implement production backend configuration docs for `VITE_API_URL`, `OPENAI_API_KEY`, `OPENAI_MODEL`, and TTS settings.
5. Add a formal cross-device import/export E2E test for Web archive JSON and WeChat mini clipboard JSON.
6. Continue improving 3D digital human behavior: reusable GLB animation hooks for love/happy/angry/comfort states.

## Handoff Prompt

Use this prompt for another Hermes/Codex agent:

```text
Continue from https://github.com/MoKangMedical/digital-girlfriend on main.

The product goal is a digital girlfriend site/app inspired by Anima-like companion products: custom digital humans, voice, Web/WeChat mini/iOS installability, long-term memory, relationship growth, real-time emotion/avatar changes, and natural romantic/flirty conversation.

Current latest work adds Web companion scenes and has been pushed to main. First run:
  npm install
  npm run build:web
  npm run dev:all

Then inspect HANDOFF_HERMES.md, README.md, web/src/components/ChatPanel.tsx, web/src/services/api.ts, server/src/services/llm.ts, and wechat-mini/pages/index/index.js.

Recommended next task: port the Web companion scenes into the WeChat mini-program, keeping the same scene ids, labels, quick starters, localStorage/storage behavior, and system-context behavior, then run mini static checks and push main.
```
