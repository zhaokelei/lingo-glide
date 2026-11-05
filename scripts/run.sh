#!/usr/bin/env bash
# Hy-MT2 本地启动脚本（llama.cpp CPU 推理 + OpenAI 兼容接口）
# 用法:
#   ./run.sh              # 默认启动 1.8B Q4_K_M，端口 8080
#   ./run.sh 1.8b         # 1.8B Q4_K_M（推荐）
#   ./run.sh 1.8b-q8      # 1.8B Q8_0（仅对照，较慢）
#   ./run.sh 1.8b 8090    # 指定端口
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BIN="$ROOT/bin/llama-b12125/llama-server"
TAG="${1:-1.8b}"
PORT="${2:-8080}"

case "$TAG" in
  1.8b)    MODEL="$ROOT/models/Hy-MT2-1.8B-Q4_K_M.gguf"; THREADS=4 ;;
  1.8b-q8) MODEL="$ROOT/models/Hy-MT2-1.8B-Q8_0.gguf";   THREADS=4 ;;
  *) echo "未知规格: $TAG（可选 1.8b / 1.8b-q8）"; exit 1 ;;
esac

if [[ ! -f "$MODEL" ]]; then
  echo "模型不存在: $MODEL"
  echo "请先下载，例如:"
  echo "  curl -L -o \"$MODEL\" 'https://modelscope.cn/models/Tencent-Hunyuan/Hy-MT2-7B-GGUF/resolve/master/Hy-MT2-7B-Q4_K_M.gguf'"
  exit 1
fi

# 纯 CPU 推理：-ngl 0；4 物理核 -> 4 线程
# -np 1：单槽串行。实测 3 并发时 -np2 仅 +12% 吞吐、-np3 反而掉到 -21%，
#         且每个槽分到的上下文变小；本地单实例排队比并行更稳。
# --temp 0.3：客户端（陪读蛙）不传采样参数时用这个；比官方 0.7 更稳定，
#         同一段重复翻译结果一致，术语不容易漂。
exec "$BIN" \
  -m "$MODEL" \
  --alias hy-mt2 \
  --host 127.0.0.1 --port "$PORT" \
  -c 4096 -t "$THREADS" -ngl 0 -np 1 \
  --temp 0.3 --top-p 0.6 --top-k 20 \
  --repeat-penalty 1.05 \
  --no-webui
