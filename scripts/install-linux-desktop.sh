#!/bin/sh
# Registers the development copy of MinBrowser with the Linux desktop: an
# entry in the app launcher, and the MinBrowser icon in the dock/taskbar
# (GNOME and KDE match windows to this entry by name; without it they show
# a generic icon). Installed packages (.deb) do this themselves.
set -eu

ROOT=$(cd "$(dirname "$0")/.." && pwd)
DATA="${XDG_DATA_HOME:-$HOME/.local/share}"
APPS="$DATA/applications"
ICONS="$DATA/icons/hicolor"
NODE_DIR=$(dirname "$(command -v node)")

mkdir -p "$APPS" "$ICONS/512x512/apps" "$ICONS/scalable/apps"
cp "$ROOT/src/assets/icon.png" "$ICONS/512x512/apps/minbrowser.png"
cp "$ROOT/build/icon.svg" "$ICONS/scalable/apps/minbrowser.svg"

# Launchers don't load your shell profile, so pin the node that is installed now.
cat > "$APPS/minbrowser.desktop" <<EOF
[Desktop Entry]
Type=Application
Name=MinBrowser
GenericName=Web Browser
Comment=私密浏览器：数据加密保存在你自己的电脑上
Exec=env PATH=$NODE_DIR:/usr/local/bin:/usr/bin:/bin "$ROOT/start.sh"
Icon=minbrowser
Terminal=false
Categories=Network;WebBrowser;
StartupWMClass=minbrowser
EOF

command -v update-desktop-database >/dev/null && update-desktop-database "$APPS" 2>/dev/null || true
command -v gtk-update-icon-cache >/dev/null && gtk-update-icon-cache -q -t "$ICONS" 2>/dev/null || true
echo "已添加 MinBrowser 到应用菜单：$APPS/minbrowser.desktop"
echo "如果任务栏图标没有马上更新，注销后重新登录一次即可。"
