#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/xhs
RAW="https://raw.githubusercontent.com/Lin6916/xhs-deploy/main"

[ "$(id -u)" -eq 0 ] || { echo "请用 sudo 运行"; exit 1; }

mkdir -p "$APP_DIR"
echo "==> 下载 server.js"
curl -fsSL "$RAW/server.js" -o "$APP_DIR/server.js"
chmod 644 "$APP_DIR/server.js"
node --check "$APP_DIR/server.js" && echo "    语法检查通过"

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
  echo "    （没给链接，跳过。用法：deploy.sh <小红书链接>）"
fi

echo "==> 容器日志"
docker logs -n 5 xhs-card

echo
echo "完成。接口在 127.0.0.1:8790，等 nginx 反代 /api/xhs-card 与 /api/xhs-images。"
