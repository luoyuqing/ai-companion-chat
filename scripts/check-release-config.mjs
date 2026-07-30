import fs from "node:fs/promises";
import path from "node:path";

const warnings = [];
const blockers = [];
const ALLOW_PLACEHOLDER_IDS = ["true", "1"].includes(String(process.env.DG_ALLOW_PLACEHOLDER_IDS || "").toLowerCase());

async function readText(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    blockers.push(`文件缺失：${filePath}`);
    return "";
  }
}

async function checkWechatConfig() {
  const appPath = path.resolve("wechat-mini/app.js");
  const configPath = path.resolve("wechat-mini/project.config.json");
  const appContent = await readText(appPath);
  const configContent = await readText(configPath);

  const wechatPlaceholders = [
    "your-domain.example.com",
    "your-backend-domain.com",
    "https://your-backend-domain.com",
    "https://your-domain.example.com"
  ];
  if (
    appContent &&
    wechatPlaceholders.some((item) => appContent.includes(item))
  ) {
    const message = "微信小程序 app.js 仍使用占位域名（如 your-domain.example.com / your-backend-domain.com），请替换为正式后端域名";
    if (ALLOW_PLACEHOLDER_IDS) {
      warnings.push(`${message}（当前为本地/试运行模式）`);
    } else {
      blockers.push(message);
    }
  }

  if (configContent) {
    const appIdMatch = configContent.match(/"appid"\s*:\s*"([^"]+)"/);
    const appId = appIdMatch?.[1]?.trim() ?? "";
    if (!appId) {
      blockers.push("微信小程序 project.config.json 中 appid 为空。");
      return;
    }
    if (
      appId === "your-wechat-appid" ||
      appId === "wx1234567890abcd" ||
      appId === "wxlocal000000000001"
    ) {
      if (ALLOW_PLACEHOLDER_IDS) {
        warnings.push(`project.config.json 中仍有示例 appid（${appId}），当前为本地/试运行模式。`);
      } else {
        blockers.push(`project.config.json 中仍有示例 appid（${appId}）。`);
      }
      return;
    }
  } else {
    blockers.push("无法读取 wechat-mini/project.config.json，无法校验 appid。");
  }
}

async function checkMobileConfig() {
  const capPath = path.resolve("mobile/capacitor.config.ts");
  const xcodeProjectPath = path.resolve("mobile/ios/App/App.xcodeproj/project.pbxproj");
  const xcodeCapConfigPath = path.resolve("mobile/ios/App/App/capacitor.config.json");
  const iosPodfile = path.resolve("mobile/ios/App/Podfile");
  const defaultBundleId = "com.example.digitalgirlfriend";

  const capText = await readText(capPath);
  const xcodeCapText = await readText(xcodeCapConfigPath);
  const xcodeProjectText = await readText(xcodeProjectPath);
  let podfileExists = false;
  try {
    await fs.access(iosPodfile);
    podfileExists = true;
  } catch {
    podfileExists = false;
  }

  if (capText && /appId:\s*['"]com\.example\.digitalgirlfriend(?:\.app)?['"]/.test(capText)) {
    if (ALLOW_PLACEHOLDER_IDS) {
      warnings.push("Capacitor appId 仍为示例值 com.example.digitalgirlfriend，请按商用包名替换。");
    } else {
      blockers.push("Capacitor appId 仍为示例值 com.example.digitalgirlfriend，请按商用包名替换。");
    }
  }

  if (xcodeCapText && /"appId":\s*"com\.example\.digitalgirlfriend(?:\.app)?"/.test(xcodeCapText)) {
    if (ALLOW_PLACEHOLDER_IDS) {
      warnings.push("mobile/ios/App/capacitor.config.json 仍为示例值 com.example.digitalgirlfriend，请重新 sync 原生工程。");
    } else {
      blockers.push("mobile/ios/App/capacitor.config.json 仍为示例值 com.example.digitalgirlfriend，请重新 sync 原生工程。");
    }
  }

  const safeBundleId = defaultBundleId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (xcodeProjectText && new RegExp(`PRODUCT_BUNDLE_IDENTIFIER\\s*=\\s*${safeBundleId};`).test(xcodeProjectText)) {
    if (ALLOW_PLACEHOLDER_IDS) {
      warnings.push("iOS 原生项目 PRODUCT_BUNDLE_IDENTIFIER 仍为示例值 com.example.digitalgirlfriend。");
    } else {
      blockers.push("iOS 原生项目 PRODUCT_BUNDLE_IDENTIFIER 仍为示例值 com.example.digitalgirlfriend。");
    }
  }
  const safeBundleIdApp = `${defaultBundleId}.app`.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (xcodeProjectText && new RegExp(`PRODUCT_BUNDLE_IDENTIFIER\\s*=\\s*${safeBundleIdApp};`).test(xcodeProjectText)) {
    if (ALLOW_PLACEHOLDER_IDS) {
      warnings.push("iOS 原生项目 PRODUCT_BUNDLE_IDENTIFIER 仍为示例值 com.example.digitalgirlfriend.app，请按商用包名替换。");
    } else {
      blockers.push("iOS 原生项目 PRODUCT_BUNDLE_IDENTIFIER 仍为示例值 com.example.digitalgirlfriend.app，请按商用包名替换。");
    }
  }

  if (podfileExists) {
    console.log("✅ iOS Podfile 已存在");
  } else {
    warnings.push("未检测到 mobile/ios/App/Podfile（若已执行 cap add ios，说明 iOS 工程未完整生成）");
  }
}

async function checkServerEnv() {
  const envPath = path.resolve("server/.env.example");
  const envText = await readText(envPath);
  if (!envText.includes("OPENAI_API_KEY=")) {
    warnings.push("server/.env.example 缺少 OPENAI_API_KEY，可能影响语音/回复体验");
  }
}

async function main() {
  await checkWechatConfig();
  await checkMobileConfig();
  await checkServerEnv();

  if (warnings.length) {
    console.log("⚠️  可选检查项：");
    warnings.forEach((item) => console.log(` - ${item}`));
  }

  if (blockers.length) {
    console.error("❌ 阻塞项：");
    blockers.forEach((item) => console.error(` - ${item}`));
    process.exit(1);
  }

  console.log("✓ 发布配置检查通过（仅检测关键阻塞项）");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
