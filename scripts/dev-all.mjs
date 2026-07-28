import { spawn } from "node:child_process";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

const children = [];

function spawnChild(name, command, cwd) {
  const child = spawn(command, {
    cwd,
    stdio: "inherit",
    shell: true
  });

  children.push({ name, child });

  child.on("exit", (code, signal) => {
    console.log(`\n[${name}] exited (code=${code}, signal=${signal})`);
    if (signal === "SIGTERM") return;
    if (process.exitCode === null) {
      shutdown(0);
    }
  });

  return child;
}

function shutdown(code = 0) {
  for (const item of children) {
    if (!item.child.killed) {
      item.child.kill();
    }
  }
  process.exit(code);
}

process.on("SIGINT", () => shutdown(0));
process.on("SIGTERM", () => shutdown(0));

const API_PORT = process.env.PORT || "8787";
console.log("启动后端服务...");
spawnChild("server", `HOST=127.0.0.1 PORT=${API_PORT} npm run start --workspace @dg/server`, process.cwd());

console.log("启动 Web 开发服务器...");
spawnChild("web", "npm run dev --workspace @dg/web", process.cwd());

(async () => {
  await sleep(1500);
  console.log("基础服务已启动。可访问:");
console.log("- Web: http://localhost:5173");
console.log(`- API: http://127.0.0.1:${API_PORT}/healthz`);
})();
