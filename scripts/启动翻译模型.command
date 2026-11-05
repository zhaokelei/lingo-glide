#!/bin/bash
# 启动 Hy-MT2-1.8B 本地翻译服务（双击运行）
# 服务：llama.cpp CPU 推理，OpenAI 兼容接口 http://127.0.0.1:8080/v1
# 任何一条启动路径（包括「接管已在运行的实例」）都会写 PID 文件，
# 并在就绪后校验 PID 文件指向的进程确实是监听该端口的 llama-server。

ROOT="${TRF_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PORT="${TRF_PORT:-8080}"
PIDFILE="$ROOT/logs/hy-mt.pid"
LOGFILE="$ROOT/logs/hy-mt.log"
HTML="${TRF_HTML:-$HOME/Desktop/translate.html}"
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

# 把 PID 写入文件前先确认它确实是监听本端口的 llama-server
write_pidfile() {
  local P="$1"
  if [ -n "$P" ] && kill -0 "$P" 2>/dev/null && is_llama_server "$P" && on_this_port "$P"; then
    mkdir -p "$ROOT/logs"
    echo "$P" > "$PIDFILE"
    return 0
  fi
  return 1
}

open_html() {
  [ -f "$HTML" ] && open "$HTML"
}

echo "========================================"
echo "  混元翻译模型 Hy-MT2-1.8B"
echo "========================================"

mkdir -p "$ROOT/logs"

# ---------- 1. PID 文件有效且端口对应？ ----------
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null && is_llama_server "$OLD_PID" && on_this_port "$OLD_PID"; then
    echo "服务已在运行（PID ${OLD_PID}），无需重复启动。"
    echo "接口地址: http://127.0.0.1:$PORT/v1  模型名: hy-mt2"
    open_html
    sleep 3
    exit 0
  fi
  echo "PID 文件已失效（PID ${OLD_PID:-空} 不存在或与端口不对应），清理后继续。"
  rm -f "$PIDFILE"
fi

# ---------- 2. 端口上已有实例：接管并补写 PID ----------
if curl -s --max-time 3 "$HEALTH" > /dev/null 2>&1; then
  L=$(listener_pid)
  if [ -n "$L" ] && is_llama_server "$L" && on_this_port "$L"; then
    if write_pidfile "$L"; then
      echo "端口 $PORT 上已有翻译服务在运行（PID ${L}，非本次启动），已接管并写入 PID 文件。"
      echo "接口地址: http://127.0.0.1:$PORT/v1  模型名: hy-mt2"
      open_html
      sleep 3
      exit 0
    fi
  fi
  echo "错误：端口 $PORT 有响应，但监听进程不是本机的 llama-server（PID ${L:-未知}），不接管。"
  echo "请检查：lsof -nP -iTCP:$PORT -sTCP:LISTEN"
  pause_on_error
  exit 1
fi

# ---------- 3. 检查模型文件 ----------
MODEL="$ROOT/models/Hy-MT2-1.8B-Q4_K_M.gguf"
if [ ! -f "$MODEL" ]; then
  echo "错误：模型文件不存在："
  echo "  $MODEL"
  pause_on_error
  exit 1
fi

# ---------- 4. 启动 ----------
echo "正在启动模型（CPU 推理，约需 10–20 秒加载）..."
echo "日志: $LOGFILE"

cd "$ROOT" || { echo "错误：无法进入目录 $ROOT"; pause_on_error; exit 1; }

# nohup 保证终端关闭后服务仍然存活；run.sh 末尾是 exec，PID 不变
nohup "$ROOT/run.sh" 1.8b "$PORT" >> "$LOGFILE" 2>&1 &
NEW_PID=$!

# ---------- 5. 轮询等待就绪（最多 60 秒） ----------
READY=0
for i in $(seq 1 60); do
  if ! kill -0 "$NEW_PID" 2>/dev/null; then
    echo ""
    echo "错误：服务进程已退出，启动失败。最近日志："
    echo "────────────────────────────────────────"
    tail -20 "$LOGFILE"
    rm -f "$PIDFILE"
    pause_on_error
    exit 1
  fi
  if curl -s --max-time 2 "$HEALTH" > /dev/null 2>&1; then
    READY=1
    break
  fi
  printf "."
  sleep 1
done

echo ""
if [ "$READY" -ne 1 ]; then
  echo "错误：等待 60 秒仍未就绪。"
  echo "日志：$LOGFILE"
  tail -20 "$LOGFILE"
  echo "可执行：lsof -nP -iTCP:$PORT -sTCP:LISTEN 查看端口占用。"
  rm -f "$PIDFILE"
  pause_on_error
  exit 1
fi

# ---------- 6. 校验 PID 与端口对应关系 ----------
ACTUAL=$(listener_pid)
if [ -z "$ACTUAL" ]; then
  echo "错误：接口有响应，但端口 $PORT 上找不到监听进程，无法写 PID 文件。"
  echo "请执行：lsof -nP -iTCP:$PORT -sTCP:LISTEN"
  pause_on_error
  exit 1
fi

if ! is_llama_server "$ACTUAL" || ! on_this_port "$ACTUAL"; then
  echo "错误：监听 $PORT 的进程（PID ${ACTUAL}）不是预期的 llama-server，拒绝写入 PID 文件。"
  echo "请执行：ps -p $ACTUAL -o command="
  pause_on_error
  exit 1
fi

if [ "$ACTUAL" != "$NEW_PID" ]; then
  echo "提示：启动 PID $NEW_PID 与监听 PID $ACTUAL 不一致，以实际监听进程为准。"
fi
echo "$ACTUAL" > "$PIDFILE"

echo "✓ 就绪 (PID $ACTUAL, 用时约 ${i}s)"
echo ""
echo "  接口地址 : http://127.0.0.1:$PORT/v1"
echo "  模型名   : hy-mt2"
echo "  健康检查 : $HEALTH"
echo "  PID 文件 : $PIDFILE"
echo ""
open_html
echo "已打开翻译网页。此窗口可关闭，服务会在后台继续运行。"
sleep 4
exit 0
