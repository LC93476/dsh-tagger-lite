#!/bin/sh
# plan: 老入口保留 —— deploy.sh 只做转发（docker / 便携 node 逻辑都在 start.sh 里，别再抄一份）
exec "$(cd "$(dirname "$0")" && pwd)/start.sh" "$@"
