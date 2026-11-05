#!/bin/bash
# 停止 Hy-MT2 本地翻译服务（双击运行）
# 只终止本脚本记录的 PID，不影响其它 ollama / llama.cpp 进程

ROOT="${TRF_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PORT="${TRF_PORT:-8080}"
PIDFILE="$ROOT/logs/hy-mt.pid"
HEALTH="http://127.0.0.1:$PORT/v1/models"

echo "========================================"
echo "  停止混元翻译模型服务"
echo "========================================"

if [ ! -f "$PIDFILE" ]; then
  echo "未在运行（PID 文件不存在），无需停止。"
  sleep 2
  exit 0
fi

PID=$(cat "$PIDFILE" 2>/dev/null)

if [ -z "$PID" ] || ! kill -0 "$PID" 2>/dev/null; then
  echo "进程（PID ${PID:-未知}）已不存在，清理 PID 文件。"
  rm -f "$PIDFILE"
  sleep 2
  exit 0
fi

echo "正在停止进程 PID $PID ..."
kill "$PID" 2>/dev/null

# 最多等 10 秒优雅退出
for i in $(seq 1 10); do
  if ! kill -0 "$PID" 2>/dev/null; then
    break
  fi
  sleep 1
done

if kill -0 "$PID" 2>/dev/null; then
  echo "进程未响应，强制结束。"
  kill -9 "$PID" 2>/dev/null
  sleep 2
fi

# 确认端口已释放
if curl -s --max-time 2 "$HEALTH" > /dev/null 2>&1; then
  echo "警告：进程已终止，但端口 $PORT 仍有响应（可能存在其它实例）。"
else
  echo "已停止，端口 $PORT 已释放。"
fi

rm -f "$PIDFILE"
echo "PID 文件已清理。"
sleep 2
exit 0
