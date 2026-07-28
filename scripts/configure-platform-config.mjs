import fs from "node:fs/promises";
import path from "node:path";

const WECHAT_API_BASE = process.env.WECHAT_API_BASE?.trim();
const WECHAT_APP_ID = process.env.WECHAT_APP_ID?.trim();
const IOS_APP_ID = process.env.IOS_APP_ID?.trim();

const wechatAppPath = path.resolve("wechat-mini/app.js");
const wechatProjectPath = path.resolve("wechat-mini/project.config.json");
const capacitorConfigPath = path.resolve("mobile/capacitor.config.ts");
const capacitorJsonPath = path.resolve("mobile/ios/App/App/capacitor.config.json");
const xcodeProjectPath = path.resolve("mobile/ios/App/App.xcodeproj/project.pbxproj");
const messages = [];
const blockers = [];
const warnings = [];

async function applyWechatConfig() {
  let appJs = await fs.readFile(wechatAppPath, "utf8");
  let changed = false;

  if (WECHAT_API_BASE) {
    const next = appJs.replace(
      /apiBase:\s*["'`][^"'`]*["'`]/,
      `apiBase: "${WECHAT_API_BASE}"`
    );
    if (next !== appJs) {
      appJs = next;
      changed = true;
    }
  }

  if (changed) {
    await fs.writeFile(wechatAppPath, appJs);
    messages.push(`已更新 wechat-mini/app.js`);
  } else {
    messages.push("wechat-mini/app.js 未写入新内容（未提供 WECHAT_API_BASE）");
  }
}

async function applyWechatProject() {
  const raw = await fs.readFile(wechatProjectPath, "utf8");
  const config = JSON.parse(raw);

  if (WECHAT_APP_ID) {
    if (config.appid !== WECHAT_APP_ID) {
      config.appid = WECHAT_APP_ID;
      await fs.writeFile(wechatProjectPath, `${JSON.stringify(config, null, 2)}\n`);
      messages.push(`已更新 wechat-mini/project.config.json appid`);
    }
    return;
  }
  if (
    config.appid === "your-wechat-appid" ||
    config.appid === "wx1234567890abcd" ||
    config.appid === "wxlocal000000000001"
  ) {
    warnings.push("未提供 WECHAT_APP_ID，微信小程序 project.config.json 仍是示例 appid，发布前需替换。");
  }
}

async function applyMobileConfig() {
  let configText = await fs.readFile(capacitorConfigPath, "utf8");
  let configJsonText = "";
  let xcodeProjectText = "";

  if (IOS_APP_ID) {
    const next = configText.replace(
      /appId:\s*["'`][^"'`]*["'`]/,
      `appId: "${IOS_APP_ID}"`
    );
    if (next !== configText) {
      configText = next;
      await fs.writeFile(capacitorConfigPath, next);
      messages.push("已更新 mobile/capacitor.config.ts 的 appId");
    }

    try {
      configJsonText = await fs.readFile(capacitorJsonPath, "utf8");
      const nextJson = configJsonText.replace(
        /"appId":\s*"[^"]*"/,
        `"appId": "${IOS_APP_ID}"`
      );
      if (nextJson !== configJsonText) {
        await fs.writeFile(capacitorJsonPath, nextJson);
        messages.push("已同步 mobile/ios/App/capacitor.config.json 的 appId");
      }
    } catch (error) {
      warnings.push("未检测到 mobile/ios/App/capacitor.config.json，或文件格式不匹配，需执行 npm run rebuild:ios 同步原生配置。");
    }

    try {
      xcodeProjectText = await fs.readFile(xcodeProjectPath, "utf8");
      const nextPbx = xcodeProjectText.replace(
        /PRODUCT_BUNDLE_IDENTIFIER = [^;]+;/g,
        `PRODUCT_BUNDLE_IDENTIFIER = ${IOS_APP_ID};`
      );
      if (nextPbx !== xcodeProjectText) {
        await fs.writeFile(xcodeProjectPath, nextPbx);
        messages.push("已同步 iOS 原生项目 PRODUCT_BUNDLE_IDENTIFIER");
      }
    } catch (error) {
      warnings.push("未检测到 iOS 原生 Xcode 工程，或文件格式不匹配，建议执行 npm run init:ios/rebuild:ios 后重试。");
    }

    if (!configJsonText || !xcodeProjectText) {
      messages.push("如有差异，建议执行 npm run rebuild:ios 重新生成 iOS 工程以保持一致。");
    } else {
      messages.push("原生 iOS 配置已同步，建议检查 Xcode 工程后直接 open:ios。");
    }
    return;
  }
  if (configText.includes("com.example.digitalgirlfriend")) {
    warnings.push("未提供 IOS_APP_ID，mobile/capacitor.config.ts 仍为示例值。");
  }
}

function validateWechatDomain() {
  if (!WECHAT_API_BASE) {
    blockers.push("缺少 WECHAT_API_BASE，微信小程序与 iOS web 端仍无法对接正式服务。");
  }
  if (WECHAT_API_BASE && !/^https?:\/\/.+/.test(WECHAT_API_BASE)) {
    blockers.push("WECHAT_API_BASE 需要使用 http/https 形式的域名。");
  }
}

async function main() {
  validateWechatDomain();

  await applyWechatConfig();
  await applyWechatProject();
  await applyMobileConfig();

  if (warnings.length) {
    console.log("⚠️  配置提示：");
    warnings.forEach((item) => console.log(` - ${item}`));
  }
  if (blockers.length) {
    console.log("");
    blockers.forEach((item) => console.log(`❌ ${item}`));
    process.exitCode = 1;
  }

  messages.forEach((item) => console.log(`✓ ${item}`));
  if (!blockers.length) {
    console.log("配置脚本执行完成，可直接继续打包流程。");
  } else {
    console.log("配置脚本已执行，但有阻塞项需修复。");
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
