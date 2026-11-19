#!/bin/sh
# plan: POSIX 一键部署——有 node 用 node，有 docker 用 docker，一条命令把面板起在 7789
#
#   ./deploy.sh              # 默认 http://127.0.0.1:7789/
#   ./deploy.sh 8090         # 换端口
#   ./deploy.sh 8090 0.0.0.0 # 换端口 + 对外监听（局域网/容器内）
#
# 环境变量：DSH_TAGGER_DATA（数据目录）、DSH_TAGGER_BASE_URL / API_KEY / MODEL（模型接口）、DSH_TAGGER_WORKFLOW_DIR
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
PORT="${1:-${DSH_TAGGER_PORT:-7789}}"
HOST="${2:-${DSH_TAGGER_HOST:-127.0.0.1}}"
DATA="${DSH_TAGGER_DATA:-$DIR/.data}"
URL="http://127.0.0.1:$PORT/"

open_browser() {
  # 后台等端口就绪再开浏览器；没有图形环境时静默跳过
  if command -v xdg-open >/dev/null 2>&1; then
    ( sleep 3; xdg-open "$URL" >/dev/null 2>&1 || true ) &
  elif command -v open >/dev/null 2>&1; then
    ( sleep 3; open "$URL" >/dev/null 2>&1 || true ) &
  fi
}

if command -v node >/dev/null 2>&1; then
  echo "用本机 node $(node -v) 启动 DSh Tagger：$URL"
  open_browser
  exec node "$DIR/server/standalone.mjs" --host "$HOST" --port "$PORT" --data-dir "$DATA"
fi

if command -v docker >/dev/null 2>&1; then
  echo "本机没有 node，改用 Docker 起（端口 $PORT）"
  cd "$DIR"
  export DSH_TAGGER_PORT="$PORT"
  if docker compose version >/dev/null 2>&1; then
    docker compose up --build
  else
    docker build -t dsh-tagger:0.2.0 .
    exec docker run --rm -p "$PORT:7789" -v "$DATA:/data" dsh-tagger:0.2.0
  fi
  exit 0
fi

cat >&2 <<EOF
这台机器既没有 node 也没有 docker，先装一个再跑这条命令：
  node    https://nodejs.org/（≥ 18.18）
  docker  https://docs.docker.com/engine/install/
或者从别的机器带一份 portable 包（scripts/pack.mjs 打出来的 zip）过来，解开后同样跑 ./deploy.sh。
EOF
exit 1
