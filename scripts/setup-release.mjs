import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const envFilePath = path.resolve(".env.release");
if (fs.existsSync(envFilePath)) {
  const raw = fs.readFileSync(envFilePath, "utf8");
  raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .forEach((line) => {
      const idx = line.indexOf("=");
      if (idx < 0) return;
      const key = line.slice(0, idx).trim();
      const value = line.slice(idx + 1).trim();
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    });
}

const required = ["WECHAT_API_BASE", "WECHAT_APP_ID", "IOS_APP_ID"];
const missing = required.filter((key) => !String(process.env[key] || "").trim());
if (missing.length > 0) {
  console.log("⚠️  以下环境变量未提供：");
  missing.forEach((key) => {
    if (key === "IOS_APP_ID") {
      console.log(` - ${key}（用于 iOS 包名，建议填写）`);
    } else {
      console.log(` - ${key}`);
    }
  });
  console.log("脚本会继续执行发布配置更新，但 check:release 可能仍阻塞。");
}

function runNodeScript(scriptPath, description) {
  const result = spawnSync("node", [scriptPath], {
    stdio: "inherit",
    env: process.env
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    const label = description || scriptPath;
    console.error(`❌ ${label} 执行失败（exit ${result.status}）`);
    process.exit(result.status || 1);
  }
}

console.log("🔧 写入平台配置（微信小程序 / 微信 appid / iOS appId）");
runNodeScript("./scripts/configure-platform-config.mjs", "平台配置同步");

console.log("🔎 检查三端安装能力链路（网站安装、微信小程序、iOS）");
runNodeScript("./scripts/verify-install-readiness.mjs", "安装能力与配置检查");

if (process.env.WECHAT_API_BASE && !process.env.VITE_API_URL) {
  process.env.VITE_API_URL = process.env.WECHAT_API_BASE;
}

console.log("🔎 检查发布阻塞项（域名 / appid / BundleId）");
runNodeScript("./scripts/check-release-config.mjs", "发布配置检查");

console.log("🚀 发布链路配置已完成。");
const verifyBase = process.env.API_BASE;
if (verifyBase) {
  process.env.API_BASE = verifyBase;
  console.log("🔁 检测到 API_BASE，执行后端服务验收...");
  runNodeScript("./scripts/verify-stack.mjs", "服务端验收");
} else if (process.env.WECHAT_API_BASE && /(^https?:\/\/(?:localhost|127\\.0\\.0\\.1|\\[::1\\])(:\\d+)?$|127\\.0\\.0\\.1|\\[::1\\])/.test(process.env.WECHAT_API_BASE)) {
  process.env.API_BASE = process.env.WECHAT_API_BASE;
  console.log("🔁 WECHAT_API_BASE 指向本地地址，自动执行后端服务验收...");
  runNodeScript("./scripts/verify-stack.mjs", "服务端验收");
} else {
  console.log("未检测到 API_BASE。后端验收未自动执行，如需验收请先设置 API_BASE 后运行：npm run verify:all");
}
