#!/bin/bash
# 停止 Hy-MT2 本地翻译服务（双击运行）
# 优先用 PID 文件；PID 文件缺失或失效时，按端口兜底查找。
# 只终止「确认是 llama-server 且监听本端口」的进程，不影响其它 ollama / llama.cpp 实例。

ROOT="${TRF_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PORT="${TRF_PORT:-8080}"
PIDFILE="$ROOT/logs/hy-mt.pid"
HEALTH="http://127.0.0.1:$PORT/v1/models"

pause_on_error() {
  echo ""
  echo "────────────────────────────────────────"
  read -n 1 -p "按任意键关闭此窗口..." _
  echo ""
}

is_llama_server() {
  ps -p "$1" -o command= 2>/dev/null | grep -q "llama-server"
}

on_this_port() {
  ps -p "$1" -o command= 2>/dev/null | grep -q -- "--port $PORT"
}

listener_pid() {
  lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1
}

port_free() {
  [ -z "$(listener_pid)" ]
}

echo "========================================"
echo "  停止混元翻译模型服务"
echo "========================================"

TARGET=""
SOURCE=""

# ---------- 1. PID 文件 ----------
if [ -f "$PIDFILE" ]; then
  P=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$P" ] && kill -0 "$P" 2>/dev/null && is_llama_server "$P" && on_this_port "$P"; then
    TARGET="$P"
    SOURCE="PID 文件"
  else
    echo "PID 文件已失效（记录 PID ${P:-空}，进程不存在或不是监听 $PORT 的 llama-server），清理后按端口查找。"
    rm -f "$PIDFILE"
  fi
fi

# ---------- 2. 端口兜底 ----------
if [ -z "$TARGET" ]; then
  L=$(listener_pid)
  if [ -n "$L" ]; then
    if is_llama_server "$L" && on_this_port "$L"; then
      TARGET="$L"
      SOURCE="端口 $PORT 兜底"
      echo "服务在运行但 PID 文件不存在，已按端口找到 PID ${L}。"
    else
      PROC=$(ps -p "$L" -o comm= 2>/dev/null | awk 'NR==1{print}')
      echo "端口 $PORT 被其它程序占用（PID ${L}，${PROC}），不是 llama-server，不终止。"
      echo "请先确认该程序来源：lsof -nP -iTCP:$PORT -sTCP:LISTEN"
      pause_on_error
      exit 1
    fi
  fi
fi

# ---------- 3. 没找到 ----------
if [ -z "$TARGET" ]; then
  echo "未在运行（PID 文件不存在，端口 $PORT 也没有 llama-server 监听）。"
  sleep 2
  exit 0
fi

# ---------- 4. 终止 ----------
echo "正在停止进程 PID ${TARGET}（来源：${SOURCE}）..."
kill "$TARGET" 2>/dev/null

for i in $(seq 1 10); do
  if ! kill -0 "$TARGET" 2>/dev/null && port_free; then
    break
  fi
  sleep 1
done

if kill -0 "$TARGET" 2>/dev/null; then
  echo "进程未在 10 秒内退出，强制结束。"
  kill -9 "$TARGET" 2>/dev/null
  for i in $(seq 1 3); do
    port_free && break
    sleep 1
  done
fi

# ---------- 5. 复查 ----------
if port_free && ! kill -0 "$TARGET" 2>/dev/null; then
  echo "✓ 已停止，端口 $PORT 已释放。"
  rm -f "$PIDFILE"
  echo "PID 文件已清理。"
  sleep 2
  exit 0
fi

echo "警告：进程 $TARGET 已终止，但端口 $PORT 仍有监听或进程仍存活。"
echo "下一步可执行："
echo "  lsof -nP -iTCP:$PORT -sTCP:LISTEN"
echo "  kill -9 <上面列出的 PID>"
pause_on_error
exit 1
