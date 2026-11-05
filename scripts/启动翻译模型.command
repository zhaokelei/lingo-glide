#!/bin/bash
# 启动 Hy-MT2-1.8B 本地翻译服务（双击运行）
# 服务：llama.cpp CPU 推理，OpenAI 兼容接口 http://127.0.0.1:8080/v1
#
# 放置位置：与 run.sh、models/、bin/ 同级的模型目录。
# 模型目录不在默认位置时，先设置环境变量：
#   export TRF_HOME=/path/to/your/model-dir
# 翻译网页默认找 ~/Desktop/translate.html，可用 TRF_HTML 覆盖。

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

echo "========================================"
echo "  混元翻译模型 Hy-MT2-1.8B"
echo "========================================"

# ---------- 1. 已在运行？ ----------
if [ -f "$PIDFILE" ]; then
  OLD_PID=$(cat "$PIDFILE" 2>/dev/null)
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "服务已在运行（PID $OLD_PID），无需重复启动。"
    echo "接口地址: http://127.0.0.1:$PORT/v1  模型名: hy-mt2"
    [ -f "$HTML" ] && open "$HTML"
    sleep 3
    exit 0
  fi
  rm -f "$PIDFILE"
fi

if curl -s --max-time 3 "$HEALTH" > /dev/null 2>&1; then
  echo "端口 $PORT 上已有一个翻译服务在运行（不是本脚本启动的），直接打开网页。"
  [ -f "$HTML" ] && open "$HTML"
  sleep 3
  exit 0
fi

# ---------- 2. 检查模型文件 ----------
MODEL="$ROOT/models/Hy-MT2-1.8B-Q4_K_M.gguf"
if [ ! -f "$MODEL" ]; then
  echo "错误：模型文件不存在："
  echo "  $MODEL"
  echo "模型权重需要自行下载，见仓库 README 的 Models 一节。"
  pause_on_error
  exit 1
fi

# ---------- 3. 启动 ----------
mkdir -p "$ROOT/logs"
echo "正在启动模型（CPU 推理，约需 10–20 秒加载）..."
echo "日志: $LOGFILE"

cd "$ROOT" || { echo "错误：无法进入目录 $ROOT"; pause_on_error; exit 1; }

# nohup 保证终端关闭后服务仍然存活
nohup "$ROOT/run.sh" 1.8b "$PORT" >> "$LOGFILE" 2>&1 &
NEW_PID=$!
echo "$NEW_PID" > "$PIDFILE"

# ---------- 4. 轮询等待就绪（最多 60 秒） ----------
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
  pause_on_error
  exit 1
fi

echo "就绪 (PID ${NEW_PID}, 用时约 ${i}s)"
echo ""
echo "  接口地址 : http://127.0.0.1:$PORT/v1"
echo "  模型名   : hy-mt2"
echo "  健康检查 : $HEALTH"
echo ""
[ -f "$HTML" ] && open "$HTML"
echo "已打开翻译网页。此窗口可关闭，服务会在后台继续运行。"
sleep 4
exit 0
