import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const envFilePath = path.resolve(process.cwd(), ".env.release");

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  const raw = fs.readFileSync(filePath, "utf8");
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

function run(name, cmd, options = {}) {
  const result = spawnSync(cmd, {
    stdio: "inherit",
    env: process.env,
    shell: true,
    ...options
  });

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${name} failed (exit ${result.status})`);
  }
}

loadEnvFile(envFilePath);

const required = ["WECHAT_API_BASE", "WECHAT_APP_ID", "IOS_APP_ID"];
const missing = required.filter((key) => !String(process.env[key] || "").trim());

if (missing.length) {
  console.log("❌ 发布前缺少必需配置：");
  missing.forEach((k) => console.log(` - ${k}`));
  console.log("请先填写 .env.release（或导出环境变量）后再执行");
  process.exit(1);
}

if (process.env.WECHAT_API_BASE && !process.env.VITE_API_URL) {
  process.env.VITE_API_URL = process.env.WECHAT_API_BASE;
}

console.log("🚀 开始发布链路：平台配置同步");
run("platform sync", "node ./scripts/configure-platform-config.mjs");

console.log("🔎 检查三端安装能力链路（网站安装、微信小程序、iOS）");
run("install readiness", "node ./scripts/verify-install-readiness.mjs");

console.log("🔎 校验关键发布配置");
run("release check", "node ./scripts/check-release-config.mjs");

if (process.env.API_BASE || process.env.WECHAT_API_BASE) {
  process.env.API_BASE = process.env.API_BASE || process.env.WECHAT_API_BASE;
  console.log(`✅ 发现 API_BASE=${process.env.API_BASE}，执行联调验收`);
  run("verify all", "node ./scripts/verify-stack.mjs");
}

if (process.argv.includes("--build-ios")) {
  console.log("🍎 自动构建 iOS（请先完成 Xcode/CocoaPods 环境）");
  run("build ios", "npm run build:ios");
}

console.log(
  "🎉 发布链路脚本执行完成。" +
    (process.argv.includes("--build-ios")
      ? "建议执行 npm run open:ios 打开 Xcode。"
      : "建议执行 `npm run open:ios` 打开 Xcode 或 `npm run build:ios`（如需立即出包）。")
);
