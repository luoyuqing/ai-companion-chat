import fs from "node:fs/promises";
import path from "node:path";

const blockers = [];
const warnings = [];
const notes = [];
const ALLOW_PLACEHOLDER_IDS = ["true", "1"].includes(String(process.env.DG_ALLOW_PLACEHOLDER_IDS || "").toLowerCase());

const PLACEHOLDER_DOMAINS = [
  "your-domain.example.com",
  "your-backend-domain.com",
  "https://your-backend-domain.com",
  "https://your-domain.example.com"
];
const PLACEHOLDER_WECHAT_APPID = ["your-wechat-appid", "wx1234567890abcd", "wxlocal000000000001"];
const PLACEHOLDER_IOS_ID = "com.example.digitalgirlfriend";

function addBlocker(message) {
  blockers.push(message);
}

function addWarning(message) {
  warnings.push(message);
}

function addNote(message) {
  notes.push(message);
}

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return "";
  }
}

function hasPlaceholder(raw, patterns) {
  return patterns.some((item) => raw.includes(item));
}

function candidateApiBases(apiBase) {
  const bases = [apiBase];
  if (!apiBase.startsWith("http://") && !apiBase.startsWith("https://")) {
    return bases;
  }

  try {
    const parsed = new URL(apiBase);
    const host = parsed.hostname;
    const port = parsed.port || (parsed.protocol === "https:" ? "443" : "80");
    const protocol = parsed.protocol;

    const add = (nextHost) => {
      const candidate = `${protocol}//${nextHost}:${port}`;
      if (!bases.includes(candidate)) {
        bases.push(candidate);
      }
    };

    if (host === "localhost") {
      add("127.0.0.1");
      add("[::1]");
    }
    if (host === "127.0.0.1") {
      add("[::1]");
    }
  } catch {
    // ignore malformed api URL
  }

  return bases;
}

async function requestHealthCheck(apiBase, timeoutMs = 3500) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${apiBase}/healthz`, { signal: controller.signal });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }
    const body = await response.json().catch(() => ({}));
    if (body?.ok !== true) {
      throw new Error("响应字段不符合预期");
    }
  } finally {
    clearTimeout(timer);
  }
}

async function verifyApi(apiBase) {
  const bases = candidateApiBases(apiBase);
  let lastErr = null;

  for (const base of bases) {
    try {
      await requestHealthCheck(base);
      addNote(`已通过健康检查：${base}`);
      return;
    } catch (error) {
      lastErr = error;
    }
  }

  const message = `未能在可用候选域名上通过 /healthz 校验: ${lastErr?.message || lastErr}`;
  addBlocker(message);
}

async function verifyWebInstallAssets() {
  const manifestPath = path.resolve("web/public/manifest.webmanifest");
  const swPath = path.resolve("web/public/sw.js");

  const manifestRaw = await readText(manifestPath);
  if (!manifestRaw) {
    addBlocker("web/public/manifest.webmanifest 不存在或无法读取，PWA 安装校验失败。");
    return;
  }

  const swRaw = await readText(swPath);
  if (!swRaw) {
    addBlocker("web/public/sw.js 不存在或无法读取，Web 端离线与离线安装缓存链路未就绪。");
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestRaw);
  } catch {
    addBlocker("web/public/manifest.webmanifest 不是合法 JSON。");
    return;
  }

  if (!manifest.start_url || !manifest.name || !manifest.icons?.length) {
    addWarning("manifest 缺少关键字段（name/start_url/icons），建议补齐以提升安装体验。");
  }

  if (swRaw) {
    const requiredSwMarkers = [
      ["cacheAppShell", "service worker 缺少 app shell 预缓存逻辑。"],
      ["extractShellAssets", "service worker 缺少 Vite hash 静态资源发现逻辑。"],
      ["networkFirstAppShell", "service worker 缺少导航离线回退逻辑。"],
      ["request.mode === \"navigate\"", "service worker 未显式处理页面导航请求。"],
      ["cacheFirst", "service worker 缺少静态资源缓存优先策略。"],
      ["clients.claim", "service worker 激活后未接管已有客户端。"]
    ];
    requiredSwMarkers.forEach(([marker, message]) => {
      if (!swRaw.includes(marker)) {
        addBlocker(message);
      }
    });
  }

  addNote("已发现 Web 端 manifest + service worker（PWA）安装资产。");

  if (!manifest.icons || manifest.icons.length < 2) {
    addWarning("manifest icons 数量较少，建议补充标准尺寸图标。" );
  }
}

async function verifyWechatConfig() {
  const appPath = path.resolve("wechat-mini/app.js");
  const projectConfigPath = path.resolve("wechat-mini/project.config.json");
  const appContent = await readText(appPath);
  const projectConfigRaw = await readText(projectConfigPath);

  if (!appContent) {
    addBlocker("微信小程序 app.js 不存在，无法读取 apiBase 配置。");
  }

  if (appContent && hasPlaceholder(appContent, PLACEHOLDER_DOMAINS)) {
    const message = "微信小程序 app.js 仍使用示例后端域名，请替换为实际 API 地址。";
    if (ALLOW_PLACEHOLDER_IDS) {
      addWarning(message);
    } else {
      addBlocker(message);
    }
  }

  let appid = "";
  const match = projectConfigRaw.match(/\"appid\"\s*:\s*\"([^\"]+)\"/);
  if (match?.[1]) {
    appid = match[1].trim();
    if (PLACEHOLDER_WECHAT_APPID.includes(appid)) {
      if (ALLOW_PLACEHOLDER_IDS) {
        addWarning(`微信小程序 project.config.json appid 仍为示例值（${appid}），当前为本地/试运行模式。`);
      } else {
        addBlocker(`微信小程序 project.config.json appid 仍是示例值（${appid}）。`);
      }
    }
  } else {
    addWarning("未检测到 wechat-mini/project.config.json 的 appid 字段（或文件不可读）。");
  }

  if (appid) {
    addNote(`已检测到微信小程序 appid：${appid}`);
  }
}

async function verifyIosConfig() {
  const capTsPath = path.resolve("mobile/capacitor.config.ts");
  const capJsonPath = path.resolve("mobile/ios/App/App/capacitor.config.json");
  const xcodePbxPath = path.resolve("mobile/ios/App/App.xcodeproj/project.pbxproj");

  const capTs = await readText(capTsPath);
  const capJson = await readText(capJsonPath);
  const pbx = await readText(xcodePbxPath);

  if (!capTs) {
    addBlocker("未找到 mobile/capacitor.config.ts，iOS 打包链路无法继续。");
  }

  if (capTs && hasPlaceholder(capTs, [PLACEHOLDER_IOS_ID])) {
    const message = "Capacitor appId 仍为示例值 com.example.digitalgirlfriend.app。";
    if (ALLOW_PLACEHOLDER_IDS) {
      addWarning(`${message} 当前为本地/试运行模式。`);
    } else {
      addBlocker(message);
    }
  }

  if (capJson && hasPlaceholder(capJson, [PLACEHOLDER_IOS_ID])) {
    addWarning("iOS 产物中的 capacitor.config.json 仍保留示例 appId，建议 sync 后重新构建。");
  }

  if (capTs && capJson && !hasPlaceholder(capTs, [PLACEHOLDER_IOS_ID]) && !hasPlaceholder(capJson, [PLACEHOLDER_IOS_ID])) {
    addNote("已配置非示例 iOS 包名。可继续执行 Capacitor 同步与 iOS 打包。")
  }

  if (!pbx) {
    addWarning("未检测到 iOS 工程 xcodeproj，建议先执行 npm run init:ios。");
    return;
  }

  if (hasPlaceholder(pbx, [PLACEHOLDER_IOS_ID])) {
    const message = "Podfile/工程仍可能包含示例 Bundle ID：com.example.digitalgirlfriend(app)，请核对重建。";
    if (ALLOW_PLACEHOLDER_IDS) {
      addWarning(`${message} 当前为本地/试运行模式。`);
    } else {
      addWarning(message);
    }
  }
}

async function verifyServerEnv() {
  const envPath = path.resolve("server/.env.example");
  const envText = await readText(envPath);

  if (!envText.includes("OPENAI_API_KEY=")) {
    addWarning("server/.env.example 未包含 OPENAI_API_KEY，语音与高质量回复可能受限。");
  }

  const unrestrictedValue = process.env.DG_UNRESTRICTED_CHAT || "";
  if (unrestrictedValue && unrestrictedValue.toLowerCase() === "false") {
    addWarning("DG_UNRESTRICTED_CHAT 当前为 false，回复会保持更严格限制策略。若需无审查体验请设置 true。");
  }
}

async function verifyWechatApiIfSet() {
  const fromEnv = process.env.WECHAT_API_BASE || process.env.API_BASE || "";
  if (!fromEnv) {
    addNote("未设置 WECHAT_API_BASE/API_BASE，安装验收仅做静态配置检查，不做后端健康校验。");
    return;
  }

  if (hasPlaceholder(fromEnv, PLACEHOLDER_DOMAINS)) {
    addBlocker(`WECHAT_API_BASE/API_BASE 仍为示例域名：${fromEnv}`);
    return;
  }

  await verifyApi(fromEnv);
}

function printSection(title, list) {
  if (!list.length) {
    return;
  }
  console.log(title);
  list.forEach((item) => console.log(` - ${item}`));
}

async function main() {
  await verifyWebInstallAssets();
  await verifyWechatConfig();
  await verifyIosConfig();
  await verifyServerEnv();
  await verifyWechatApiIfSet();

  if (notes.length) {
    printSection("✅ 通过项：", notes);
  }
  if (warnings.length) {
    printSection("⚠️  建议优化：", warnings);
  }
  if (blockers.length) {
    console.error("❌ 阻塞项：");
    blockers.forEach((item) => console.error(` - ${item}`));
    process.exit(1);
  }

  console.log("✅ 三端可安装能力与发布前配置检查通过。");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
