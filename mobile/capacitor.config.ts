import { CapacitorConfig } from "@capacitor/cli";

const apiHost = process.env.VITE_API_URL?.trim() || process.env.WECHAT_API_BASE?.trim() || "";
const serverConfig: CapacitorConfig["server"] = {
  cleartext: true
};
if (apiHost) {
  serverConfig.url = apiHost;
}

const config: CapacitorConfig = {
  appId: "com.digitalgirlfriend.demo",
  appName: "AI伴聊",
  webDir: "../web/dist",
  server: serverConfig
};

export default config;
