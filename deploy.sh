#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/xhs
MIRRORS=(
  "https://cdn.jsdelivr.net/gh/Lin6916/xhs-deploy@main"
  "https://ghproxy.net/https://raw.githubusercontent.com/Lin6916/xhs-deploy/main"
  "https://gh-proxy.com/https://raw.githubusercontent.com/Lin6916/xhs-deploy/main"
)

[ "$(id -u)" -eq 0 ] || { echo "请用 sudo 运行"; exit 1; }

mkdir -p "$APP_DIR"

echo "==> 下载 server.js"
ok=0
for m in "${MIRRORS[@]}"; do
  if curl -fsSL --max-time 40 "$m/server.js" -o "$APP_DIR/server.js" && [ -s "$APP_DIR/server.js" ]; then
    echo "    来自 ${m:0:42}"
    ok=1
    break
  fi
  echo "    失败，换下一个"
done
[ "$ok" = 1 ] || { echo "所有镜像都没下载下来"; exit 1; }

chmod 644 "$APP_DIR/server.js"
echo "==> 语法检查"
docker run --rm -v "$APP_DIR":/app -w /app node:22-alpine node --check server.js && echo "    OK"

echo "==> 重建容器"
docker rm -f xhs-card >/dev/null 2>&1 || true
docker run -d --name xhs-card --restart always \
  -p 127.0.0.1:8790:8790 -v "$APP_DIR":/app -w /app \
  node:22-alpine node server.js >/dev/null

for i in $(seq 1 20); do
  curl -fsS http://127.0.0.1:8790/health >/dev/null 2>&1 && break
  sleep 1
done

echo "==> 自测 /health"
curl -s http://127.0.0.1:8790/health; echo

echo "==> 自测 /api/xhs-card"
if [ $# -ge 1 ]; then
  curl -s -X POST http://127.0.0.1:8790/api/xhs-card \
    -H 'content-type: application/json' \
    -d "{\"url\":\"$1\"}" | head -c 900
  echo
else
  echo "    （没给链接，跳过。用法：sudo bash deploy.sh <小红书链接>）"
fi

echo "==> 容器日志"
docker logs -n 8 xhs-card

echo
echo "完成：接口在 127.0.0.1:8790。"
