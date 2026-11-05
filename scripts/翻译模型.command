#!/bin/bash
# Hy-MT2 本地翻译模型 · 启停控制菜单（双击运行）
#   1) 启动翻译模型（默认 Q4_K_M）
#   2) 启动第二模型（未配置时只提示，不启动任何东西）
#   3) 关闭翻译模型
#   0) 退出
#
# 可配置环境变量：
#   TRF_HOME        项目根目录（默认 /Users/calix/Documents/Trae-CN/temp_20261105_02）
#   TRF_PORT        服务端口（默认 8080）
#   TRF_MODEL       第一项模型文件（默认 models/Hy-MT2-1.8B-Q4_K_M.gguf）
#   TRF_CTX         第一项上下文长度（默认 4096）
#   TRF_THREADS     第一项线程数（默认 4）
#   TRF_MODEL_ALT   第二项模型文件（默认空 = 未配置）
#   TRF_ALT_CTX     第二项上下文长度（默认 4096）
#   TRF_ALT_THREADS 第二项线程数（默认 4）
#   TRF_ALIAS       模型别名（默认 hy-mt2，陪读蛙等客户端按此名匹配）
#
# 注意：macOS 自带 bash 3.2 在 zh_CN.UTF-8 下，$VAR 紧跟全角标点会丢字节，
# 本脚本统一写作 ${VAR}。

ROOT="${TRF_HOME:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)}"
PORT="${TRF_PORT:-8080}"
BIN="$ROOT/bin/llama-b12125/llama-server"
MODEL_MAIN="${TRF_MODEL:-$ROOT/models/Hy-MT2-1.8B-Q4_K_M.gguf}"
CTX_MAIN="${TRF_CTX:-4096}"
THREADS_MAIN="${TRF_THREADS:-4}"
MODEL_ALT="${TRF_MODEL_ALT:-}"
CTX_ALT="${TRF_ALT_CTX:-4096}"
THREADS_ALT="${TRF_ALT_THREADS:-4}"
ALIAS="${TRF_ALIAS:-hy-mt2}"
PIDFILE="$ROOT/logs/hy-mt.pid"
LOGFILE="$ROOT/logs/hy-mt.log"
HEALTH="http://127.0.0.1:${PORT}/v1/models"

# ---------- 进程识别 ----------
is_llama_server() {
  ps -p "$1" -o command= 2>/dev/null | grep -q "llama-server"
}

on_this_port() {
  ps -p "$1" -o command= 2>/dev/null | awk -v p="$PORT" '
    { for (i = 1; i <= NF; i++) if ($i == "--port" && $(i+1) == p) found = 1 }
    END { exit(found ? 0 : 1) }'
}

listener_pid() {
  lsof -nP -iTCP:"${PORT}" -sTCP:LISTEN -t 2>/dev/null | head -1
}

port_free() {
  [ -z "$(listener_pid)" ]
}

model_of_pid() {
  ps -p "$1" -o command= 2>/dev/null | awk '{ for (i = 1; i <= NF; i++) if ($i == "-m") { print $(i+1); exit } }'
}

current_pid() {
  local L
  L=$(listener_pid)
  if [ -n "$L" ] && is_llama_server "$L" && on_this_port "$L"; then
    echo "$L"
    return 0
  fi
  return 1
}

# ---------- 状态与菜单 ----------
print_status() {
  local P M L
  if P=$(current_pid); then
    M=$(model_of_pid "$P")
    [ -n "$M" ] && M=$(basename "$M")
    echo "当前状态：运行中   PID ${P}   端口 ${PORT}"
    echo "            模型 $( [ -n "$M" ] && echo "$M" || echo "未知")   别名 ${ALIAS}"
    echo "            接口 http://127.0.0.1:${PORT}/v1"
  else
    L=$(listener_pid)
    if [ -n "$L" ]; then
      echo "当前状态：端口 ${PORT} 被其它程序占用（PID ${L}），不是 llama-server"
    else
      echo "当前状态：未运行（端口 ${PORT} 空闲）"
    fi
  fi
}

print_menu() {
  echo ""
  echo "========================================"
  echo "  混元翻译模型 Hy-MT2 · 控制菜单"
  echo "========================================"
  print_status
  echo "----------------------------------------"
  echo "  1) 启动翻译模型   $(basename "${MODEL_MAIN}")（上下文 ${CTX_MAIN} / 线程 ${THREADS_MAIN}）"
  if [ -n "$MODEL_ALT" ]; then
    echo "  2) 启动第二模型   $(basename "${MODEL_ALT}")（上下文 ${CTX_ALT} / 线程 ${THREADS_ALT}）"
  else
    echo "  2) 启动第二模型   （未配置：当前只存在一个模型文件）"
  fi
  echo "  3) 关闭翻译模型"
  echo "  0) 退出"
  echo "----------------------------------------"
}

tail_log() {
  echo "最近日志（${LOGFILE}）最后 15 行："
  echo "────────────────────────────────────────"
  tail -15 "$LOGFILE" 2>/dev/null
  echo "────────────────────────────────────────"
}

# ---------- 启动 ----------
start_service() {
  local LABEL="$1" MODEL="$2" CTX="$3" THREADS="$4"
  local L NEW_PID ACTUAL READY i

  echo ""
  if [ ! -f "$BIN" ]; then
    echo "错误：推理程序不存在：${BIN}"
    return 1
  fi

  # 同端口已有实例：不重复启动
  L=$(listener_pid)
  if [ -n "$L" ]; then
    if is_llama_server "$L" && on_this_port "$L"; then
      echo "服务已在运行（PID ${L}，模型 $(basename "$(model_of_pid "$L")")），不重复启动。"
      return 0
    fi
    echo "错误：端口 ${PORT} 已被其它程序占用（PID ${L}），不启动。"
    echo "请先确认：lsof -nP -iTCP:${PORT} -sTCP:LISTEN"
    return 1
  fi

  if [ ! -f "$MODEL" ]; then
    echo "错误：模型文件不存在：${MODEL}"
    tail_log
    return 1
  fi

  mkdir -p "$ROOT/logs"
  echo "正在启动 ${LABEL}：$(basename "${MODEL}")（上下文 ${CTX} / 线程 ${THREADS}）..."
  echo "日志: ${LOGFILE}"

  # 参数与 run.sh 一致：纯 CPU、单槽（-np 1）、低温度
  nohup "$BIN" \
    -m "$MODEL" \
    --alias "$ALIAS" \
    --host 127.0.0.1 --port "$PORT" \
    -c "$CTX" -t "$THREADS" -ngl 0 -np 1 \
    --temp 0.3 --top-p 0.6 --top-k 20 \
    --repeat-penalty 1.05 \
    --no-webui >> "$LOGFILE" 2>&1 &
  NEW_PID=$!

  # 轮询就绪，最多 60 秒
  READY=0
  for i in $(seq 1 60); do
    if ! kill -0 "$NEW_PID" 2>/dev/null; then
      echo ""
      echo "错误：服务进程已退出，启动失败。"
      tail_log
      rm -f "$PIDFILE"
      return 1
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
    tail_log
    echo "可执行：lsof -nP -iTCP:${PORT} -sTCP:LISTEN"
    rm -f "$PIDFILE"
    return 1
  fi

  # 校验 PID 与端口对应关系，防止 stale PID 指向别的进程
  ACTUAL=$(listener_pid)
  if [ -z "$ACTUAL" ]; then
    echo "错误：接口有响应，但端口 ${PORT} 上找不到监听进程，无法写 PID 文件。"
    return 1
  fi
  if ! is_llama_server "$ACTUAL" || ! on_this_port "$ACTUAL"; then
    echo "错误：监听 ${PORT} 的进程（PID ${ACTUAL}）不是预期的 llama-server，拒绝写 PID 文件。"
    return 1
  fi
  if [ "$ACTUAL" != "$NEW_PID" ]; then
    echo "提示：启动 PID ${NEW_PID} 与监听 PID ${ACTUAL} 不一致，以实际监听进程为准。"
  fi
  echo "$ACTUAL" > "$PIDFILE"

  echo "✓ 就绪（PID ${ACTUAL}，用时约 ${i} 秒）"
  echo "  接口   : http://127.0.0.1:${PORT}/v1"
  echo "  模型名 : ${ALIAS}"
  echo "  文件   : ${MODEL}"
  echo "  PID 文件: ${PIDFILE}"
  return 0
}

# ---------- 关闭（含端口兜底） ----------
stop_service() {
  local TARGET="" SOURCE="" P L PROC i

  echo ""

  # 1. PID 文件：必须确认进程存在、是 llama-server、且监听本端口
  if [ -f "$PIDFILE" ]; then
    P=$(cat "$PIDFILE" 2>/dev/null)
    if [ -n "$P" ] && kill -0 "$P" 2>/dev/null && is_llama_server "$P" && on_this_port "$P"; then
      TARGET="$P"
      SOURCE="PID 文件"
    else
      echo "PID 文件已失效（记录 PID ${P:-空}），清理后按端口查找。"
      rm -f "$PIDFILE"
    fi
  fi

  # 2. 端口兜底
  if [ -z "$TARGET" ]; then
    L=$(listener_pid)
    if [ -n "$L" ]; then
      if is_llama_server "$L" && on_this_port "$L"; then
        TARGET="$L"
        SOURCE="端口 ${PORT} 兜底"
        echo "服务在运行但 PID 文件不存在，已按端口找到 PID ${L}。"
      else
        PROC=$(ps -p "$L" -o comm= 2>/dev/null | awk 'NR==1{print}')
        echo "端口 ${PORT} 被其它程序占用（PID ${L}，${PROC}），不是 llama-server，不终止。"
        echo "请先确认：lsof -nP -iTCP:${PORT} -sTCP:LISTEN"
        return 1
      fi
    fi
  fi

  # 3. 没找到
  if [ -z "$TARGET" ]; then
    echo "未在运行（端口 ${PORT} 空闲），无需关闭。"
    return 0
  fi

  # 4. 终止并等待端口释放
  echo "正在停止 PID ${TARGET}（来源：${SOURCE}）..."
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

  # 5. 复查
  if port_free && ! kill -0 "$TARGET" 2>/dev/null; then
    echo "✓ 已关闭，端口 ${PORT} 已释放。"
    rm -f "$PIDFILE"
    echo "PID 文件已清理。"
    return 0
  fi

  echo "警告：进程 ${TARGET} 已终止，但端口 ${PORT} 仍有监听或进程仍存活。"
  echo "下一步可执行："
  echo "  lsof -nP -iTCP:${PORT} -sTCP:LISTEN"
  echo "  kill -9 <上面列出的 PID>"
  return 1
}

# ---------- 主循环 ----------
mkdir -p "$ROOT/logs"

while true; do
  print_menu
  printf "请选择 [0-3]: "
  if ! IFS= read -r CHOICE; then
    echo ""
    echo "输入结束，退出。"
    exit 0
  fi

  case "$CHOICE" in
    1)
      start_service "翻译模型" "$MODEL_MAIN" "$CTX_MAIN" "$THREADS_MAIN"
      sleep 1
      ;;
    2)
      if [ -z "$MODEL_ALT" ]; then
        echo ""
        echo "第二项未配置：${ROOT}/models 下只有一个模型文件（$(basename "${MODEL_MAIN}")），已被第 1 项使用。"
        echo "如需指定第二模型，可这样运行本脚本："
        echo "  TRF_MODEL_ALT=\"/path/to/model.gguf\" TRF_ALT_CTX=4096 TRF_ALT_THREADS=4 bash \"$0\""
        echo "提示：run.sh 的 1.8b-q8 分支指向 Hy-MT2-1.8B-Q8_0.gguf，但该文件当前不存在。"
      else
        start_service "第二模型" "$MODEL_ALT" "$CTX_ALT" "$THREADS_ALT"
      fi
      sleep 1
      ;;
    3)
      stop_service
      echo ""
      echo "已退出控制菜单。"
      exit 0
      ;;
    0)
      echo ""
      echo "退出（服务状态未改变）。"
      exit 0
      ;;
    "")
      echo ""
      echo "未输入任何内容，请重新选择。"
      sleep 1
      ;;
    *)
      echo ""
      echo "无效输入：'${CHOICE}'，请输入 1 / 2 / 3 / 0。"
      sleep 1
      ;;
  esac
done
