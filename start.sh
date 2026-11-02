#!/bin/sh
# 启动 MinBrowser（macOS / Linux）。
#
#   ./start.sh          构建并在后台启动，终端可以直接关掉
#   ./start.sh --fg     在前台运行，日志直接显示在终端里（排查问题时用）
#
# 第一次运行或依赖有变化时会自动 npm install。
# 也可以双击 MinBrowser.command（macOS），或执行 npm run install-desktop 加进 Linux 应用菜单。
set -eu

ROOT=$(cd "$(dirname "$0")" && pwd)
cd "$ROOT"

FOREGROUND=0
[ "${1:-}" = "--fg" ] && FOREGROUND=1

case "$(uname -s)" in
  Darwin) OS=mac; LOG_DIR="$HOME/Library/Logs/MinBrowser" ;;
  *)      OS=linux; LOG_DIR="${XDG_STATE_HOME:-$HOME/.local/state}/minbrowser" ;;
esac
mkdir -p "$LOG_DIR"
chmod 700 "$LOG_DIR"
LOG="$LOG_DIR/launch.log"
: >"$LOG"
chmod 600 "$LOG"

# 从终端运行时打印到终端；双击或从应用菜单打开时（没有终端）弹出提示窗口。
fail() {
  if [ -t 1 ]; then
    printf '\n%s\n' "$1" >&2
  elif [ "$OS" = mac ]; then
    osascript -e "display alert \"MinBrowser 启动失败\" message \"$1\"" >/dev/null 2>&1 || true
  elif command -v zenity >/dev/null 2>&1; then
    zenity --error --title="MinBrowser 启动失败" --text="$1" 2>/dev/null || true
  elif command -v notify-send >/dev/null 2>&1; then
    notify-send "MinBrowser 启动失败" "$1" || true
  fi
  exit 1
}

say() { [ -t 1 ] && echo "$1" || true; }

# 双击或从应用菜单启动时不会加载 shell 配置，补上 Node 常见的安装位置。
PATH="/opt/homebrew/bin:/usr/local/bin:$HOME/.volta/bin:$HOME/.local/bin:$PATH"
if ! command -v node >/dev/null 2>&1; then
  NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  # shellcheck disable=SC1091
  [ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1 || true
fi
export PATH
[ "$(id -u)" != 0 ] || fail "请不要用 root（sudo）运行 MinBrowser：以 root 运行时无法开启网页沙箱。"
command -v node >/dev/null 2>&1 || fail "找不到 Node.js。请先安装 Node.js 20 或更新版本：https://nodejs.org"

NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 20 ] || fail "Node.js 版本太旧（$(node -v)），需要 20 或更新版本。"

# 依赖：第一次运行，或 package-lock.json 比上次安装新（例如 git pull 之后）。
ELECTRON="$ROOT/node_modules/.bin/electron"
if [ ! -x "$ELECTRON" ] || [ package-lock.json -nt node_modules/.package-lock.json ]; then
  say "正在安装依赖（只有第一次或更新后需要，可能要几分钟）…"
  npm install >>"$LOG" 2>&1 || fail "npm install 失败，详情见 $LOG"
fi

# Linux：系统限制普通用户创建沙箱时（Ubuntu 23.10+），需要给 chrome-sandbox 设置权限。
# 不用 --no-sandbox 绕过：那会关掉网页进程的沙箱。
if [ "$OS" = linux ]; then
  SANDBOX="$ROOT/node_modules/electron/dist/chrome-sandbox"
  RESTRICTED=0
  [ "$(cat /proc/sys/kernel/apparmor_restrict_unprivileged_userns 2>/dev/null || echo 0)" = 1 ] && RESTRICTED=1
  [ "$(cat /proc/sys/kernel/unprivileged_userns_clone 2>/dev/null || echo 1)" = 0 ] && RESTRICTED=1
  if [ "$RESTRICTED" = 1 ] && [ -f "$SANDBOX" ] && { [ "$(stat -c %u "$SANDBOX")" != 0 ] || [ ! -u "$SANDBOX" ]; }; then
    if [ -t 0 ] && [ -t 1 ]; then
      echo "这台电脑限制了普通程序创建沙箱，需要给 MinBrowser 的沙箱程序设置一次权限（会要求输入电脑的登录密码）。"
      sudo chown root:root "$SANDBOX" && sudo chmod 4755 "$SANDBOX" || fail "设置沙箱权限失败。"
    else
      fail "需要先设置一次沙箱权限：请打开终端，运行 $ROOT/start.sh"
    fi
  fi
fi

say "正在构建…"
node scripts/build.mjs >>"$LOG" 2>&1 || fail "构建失败，详情见 $LOG"

if [ "$FOREGROUND" = 1 ]; then
  exec "$ELECTRON" .
fi

nohup "$ELECTRON" . >>"$LOG" 2>&1 </dev/null &
PID=$!
# 启动后几秒内就退出，说明出错了（已经有一个 MinBrowser 在运行时，新进程会把窗口交给它然后正常退出）。
sleep 3
if ! kill -0 "$PID" 2>/dev/null; then
  wait "$PID" && exit 0
  fail "MinBrowser 启动后立即退出了，详情见 $LOG"
fi
say "MinBrowser 已启动。日志：$LOG"
