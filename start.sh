#!/bin/sh
# plan: POSIX 一键启动 —— 三条路找运行时（系统 node → .runtime 便携版 → docker），首次进向导，起服务并开浏览器
#
#   ./start.sh              # 默认 http://127.0.0.1:7789/
#   ./start.sh 8090         # 换端口
#   ./start.sh 8090 0.0.0.0 # 换端口 + 对外监听（局域网 / 容器内）
#
# 环境变量：DSH_TAGGER_DATA（数据目录）、DSH_TAGGER_BASE_URL / API_KEY / MODEL（模型接口）、DSH_TAGGER_WORKFLOW_DIR
set -eu

DIR=$(cd "$(dirname "$0")" && pwd)
PORT="${1:-${DSH_TAGGER_PORT:-7789}}"
HOST="${2:-${DSH_TAGGER_HOST:-127.0.0.1}}"
DATA="${DSH_TAGGER_DATA:-$DIR/.data}"
URL="http://127.0.0.1:$PORT/"
cd "$DIR"

# ── 第 1 条路：系统里的 node / nodejs ──
NODE=""
if command -v node >/dev/null 2>&1; then
  NODE=node
elif command -v nodejs >/dev/null 2>&1; then
  NODE=nodejs
else
  # ── 第 2 条路：自己解开的便携版（把官方 tarball 解到 .runtime/node，得到 .runtime/node/bin/node）──
  for candidate in "$DIR/.runtime/node/bin/node" "$DIR"/.runtime/node-v*/bin/node; do
    if [ -x "$candidate" ]; then
      NODE="$candidate"
      break
    fi
  done
fi

if [ -z "$NODE" ]; then
  # ── 第 3 条路：docker（连 node 都没有时用容器跑）──
  if command -v docker >/dev/null 2>&1; then
    echo "本机没有 node，改用 Docker 起（端口 $PORT）"
    export DSH_TAGGER_PORT="$PORT"
    if docker compose version >/dev/null 2>&1; then
      docker compose up --build
    else
      docker build -t dsh-tagger:0.2.0 .
      docker run --rm -p "$PORT:7789" -v "$DATA:/data" dsh-tagger:0.2.0
    fi
    exit 0
  fi
  echo "三条路都没走通：这台机器既没有 node、也没有 .runtime/node 便携版、也没有 docker。" >&2
  cat >&2 <<EOF
任选一条再跑 ./start.sh：
  1. 装 Node（推荐）https://nodejs.org/  需要 >= 18.18
  2. 便携版：下载 https://nodejs.org/dist/v22.14.0/node-v22.14.0-linux-x64.tar.xz
     解到 .runtime/node（解完应有 .runtime/node/bin/node），不用装系统 node
  3. 装 Docker https://docs.docker.com/engine/install/ 后重跑本脚本（会用 docker compose up --build）
也可以从别的机器带一份打好的包过来，解开后同样跑 ./start.sh。
EOF
  exit 1
fi

# 首次运行：还没有 settings.json 就先走一遍向导（非交互终端会自动用默认值）
if [ ! -f "$DATA/settings.json" ]; then
  echo "首次运行：先配一下模型接口与 ComfyUI（直接回车 = 方括号里的默认值）"
  "$NODE" "$DIR/scripts/setup.mjs" --data-dir "$DATA" || true
  echo
fi

echo "运行时：$NODE（$("$NODE" -v)）"
echo "面板：$URL"
exec "$NODE" "$DIR/bin/tagger.mjs" --port "$PORT" --host "$HOST" --data-dir "$DATA" --open
