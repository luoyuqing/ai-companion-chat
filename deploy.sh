#!/usr/bin/env bash
# Digital Girlfriend 一键部署脚本 (在服务器一 1.14.73.64 上运行)
#
# 用法:
#   git clone -b dg-deploy https://github.com/luoyuqing/practise.git dg
#   cd dg
#   MIMO_API_KEY=sk-xxx OPENAI_API_KEY=sk-xxx MIMO_TTS_VOICE=冰糖 bash deploy.sh
#
# 可选环境变量:
#   BASIC_AUTH_PASSWORD  整站 BasicAuth 密码 (默认 As8k@123)
#   AUTH_USER            BasicAuth 账号 (默认 luoyuqing)
#   OPENAI_BASE_URL      LLM 基地址 (默认 https://3585616.xyz/v1)
#   OPENAI_MODEL         LLM 模型 (默认 ds)
#   MIMO_BASE_URL / MIMO_TTS_MODEL / MIMO_ASR_MODEL / TTS_PROVIDER / ASR_PROVIDER
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APP_DIR="$SCRIPT_DIR"
SERVER_DIR="$APP_DIR/server"
WEB_DIR="$APP_DIR/web"
WWW_DIR="/var/www/dg"
SERVICE_NAME="digital-girlfriend"
NGINX_AVAILABLE="/etc/nginx/sites-available/${SERVICE_NAME}"
NGINX_ENABLED="/etc/nginx/sites-enabled/${SERVICE_NAME}"

AUTH_USER="${AUTH_USER:-luoyuqing}"
BASIC_AUTH_PASSWORD="${BASIC_AUTH_PASSWORD:-As8k@123}"

MIMO_API_KEY="${MIMO_API_KEY:-}"
OPENAI_API_KEY="${OPENAI_API_KEY:-}"
OPENAI_BASE_URL="${OPENAI_BASE_URL:-https://3585616.xyz/v1}"
OPENAI_MODEL="${OPENAI_MODEL:-ds}"
MIMO_BASE_URL="${MIMO_BASE_URL:-https://api.xiaomimimo.com/v1}"
MIMO_TTS_MODEL="${MIMO_TTS_MODEL:-mimo-v2.5-tts}"
MIMO_TTS_VOICE="${MIMO_TTS_VOICE:-冰糖}"
MIMO_ASR_MODEL="${MIMO_ASR_MODEL:-mimo-v2.5-asr}"
TTS_PROVIDER="${TTS_PROVIDER:-mimo}"
ASR_PROVIDER="${ASR_PROVIDER:-mimo}"
DG_UNRESTRICTED_CHAT="${DG_UNRESTRICTED_CHAT:-true}"
PORT="${PORT:-8787}"
HOST_BIND="${HOST_BIND:-127.0.0.1}"

if [ -z "$MIMO_API_KEY" ] || [ -z "$OPENAI_API_KEY" ]; then
  echo "错误: 必须提供 MIMO_API_KEY 与 OPENAI_API_KEY 环境变量" >&2
  exit 1
fi

echo "==> [1/7] 安装系统依赖 (nginx / openssl / curl)"
sudo apt-get update -y
sudo apt-get install -y nginx openssl curl

echo "==> [2/7] 安装后端依赖"
cd "$SERVER_DIR"
npm install

echo "==> [3/7] 解析运行路径 (兼容 nvm / 系统安装)"
NODE_BIN="$(command -v node || true)"
if [ -z "$NODE_BIN" ] && [ -s "$HOME/.nvm/nvm.sh" ]; then
  export NVM_DIR="$HOME/.nvm"
  # shellcheck disable=SC1090
  . "$NVM_DIR/nvm.sh"
  NODE_BIN="$(command -v node || true)"
fi
if [ -z "$NODE_BIN" ]; then
  for p in /usr/bin/node /usr/local/bin/node /opt/node/bin/node; do
    if [ -x "$p" ]; then NODE_BIN="$p"; break; fi
  done
fi
if [ -z "$NODE_BIN" ]; then
  echo "错误: 找不到 node，请先安装 Node 20+" >&2
  exit 1
fi
echo "使用 node: $NODE_BIN"
TSX_BIN="$SERVER_DIR/node_modules/.bin/tsx"
# npm workspaces 会把依赖提升到仓库根目录
if [ ! -x "$TSX_BIN" ]; then TSX_BIN="$(cd "$SERVER_DIR/.." && pwd)/node_modules/.bin/tsx"; fi
if [ ! -x "$TSX_BIN" ]; then
  echo "错误: 未找到 tsx，npm install 可能失败" >&2
  exit 1
fi

echo "==> [4/7] 写入后端 .env (含 API 密钥，已通过环境变量传入，不会进仓库)"
cat > "$SERVER_DIR/.env" <<EOF
OPENAI_API_KEY=${OPENAI_API_KEY}
OPENAI_BASE_URL=${OPENAI_BASE_URL}
OPENAI_MODEL=${OPENAI_MODEL}
MIMO_API_KEY=${MIMO_API_KEY}
MIMO_BASE_URL=${MIMO_BASE_URL}
MIMO_TTS_MODEL=${MIMO_TTS_MODEL}
MIMO_TTS_VOICE=${MIMO_TTS_VOICE}
MIMO_ASR_MODEL=${MIMO_ASR_MODEL}
TTS_PROVIDER=${TTS_PROVIDER}
ASR_PROVIDER=${ASR_PROVIDER}
DG_UNRESTRICTED_CHAT=${DG_UNRESTRICTED_CHAT}
PORT=${PORT}
HOST=${HOST_BIND}
EOF
echo "已写入 $SERVER_DIR/.env"

echo "==> [5/7] 部署前端静态文件"
if [ ! -d "$WEB_DIR/dist" ]; then
  echo "未找到 web/dist，改为服务器本地构建..."
  ( cd "$WEB_DIR" && npm install && npm run build )
fi
sudo mkdir -p "$WWW_DIR"
sudo rm -rf "$WWW_DIR"/*
sudo cp -r "$WEB_DIR/dist/." "$WWW_DIR/"
sudo chown -R www-data:www-data "$WWW_DIR" 2>/dev/null || true

echo "==> [6/7] 配置 Nginx (IP:80 default_server, 整站 BasicAuth)"
# 清理可能存在的旧站点 (museai 等)，保留干净环境
sudo systemctl stop museai.service 2>/dev/null || true
sudo systemctl disable museai.service 2>/dev/null || true
sudo rm -f /etc/nginx/sites-available/museai /etc/nginx/sites-enabled/museai
sudo rm -f /etc/nginx/sites-enabled/default
sudo rm -f /etc/nginx/sites-enabled/* 2>/dev/null || true

sudo tee "$NGINX_AVAILABLE" > /dev/null <<'NGINX'
server {
    listen 80 default_server;
    listen [::]:80 default_server;
    server_name _;

    auth_basic "digital-girlfriend";
    auth_basic_user_file /etc/nginx/.htpasswd;

    root __WWW_DIR__;
    index index.html;

    location /api/ {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }
    location /audio/  { proxy_pass http://127.0.0.1:__PORT__; }
    location /models/ { proxy_pass http://127.0.0.1:__PORT__; }
    location /avatars/ { proxy_pass http://127.0.0.1:__PORT__; }
    # /assets/ 本地前端构建产物优先（JS/CSS/头像），找不到再回落后端动态资源
    location /assets/ {
        try_files $uri @backend;
    }
    location @backend {
        proxy_pass http://127.0.0.1:__PORT__;
        proxy_set_header Host $host;
    }
    location /healthz { proxy_pass http://127.0.0.1:__PORT__; }

    # 防止 Service Worker 与入口 HTML 被浏览器缓存，确保更新即时生效
    location = /sw.js {
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Pragma "no-cache" always;
        try_files $uri =404;
    }
    location = /index.html {
        add_header Cache-Control "no-cache, no-store, must-revalidate" always;
        add_header Pragma "no-cache" always;
        try_files $uri =404;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
NGINX
sudo sed -i "s|__WWW_DIR__|${WWW_DIR}|g; s|__PORT__|${PORT}|g" "$NGINX_AVAILABLE"
sudo ln -sf "$NGINX_AVAILABLE" "$NGINX_ENABLED"

echo "==> [6b] 配置 BasicAuth 账号"
HTPASSWD_HASH="$(openssl passwd -apr1 "${BASIC_AUTH_PASSWORD}")"
sudo bash -c "printf '%s:%s\n' '${AUTH_USER}' '${HTPASSWD_HASH}' > /etc/nginx/.htpasswd"

sudo nginx -t
sudo systemctl restart nginx
sudo systemctl enable nginx

echo "==> [7/7] 写入并启动 systemd 服务"
sudo tee "/etc/systemd/system/${SERVICE_NAME}.service" > /dev/null <<UNIT
[Unit]
Description=Digital Girlfriend API
After=network.target

[Service]
Type=simple
User=${USER}
WorkingDirectory=${SERVER_DIR}
ExecStart=${NODE_BIN} ${TSX_BIN} src/index.ts
Environment=NODE_ENV=production
Restart=on-failure
RestartSec=3

[Install]
WantedBy=multi-user.target
UNIT

sudo systemctl daemon-reload
sudo systemctl enable ${SERVICE_NAME}
sudo systemctl restart ${SERVICE_NAME}

echo ""
echo "==> 部署完成"
echo "访问地址:  http://<服务器公网IP>/"
echo "BasicAuth: 账号=${AUTH_USER}  密码=${BASIC_AUTH_PASSWORD}"
echo "后端状态:  sudo systemctl status ${SERVICE_NAME}"
echo "后端日志:  sudo journalctl -u ${SERVICE_NAME} -f"
echo "健康检查:  curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:${PORT}/healthz"
