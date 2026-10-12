#!/bin/bash
# Antigravity 插件一键安装（macOS）
#   curl -fsSL https://raw.githubusercontent.com/Eugene20071112/antigravity-plugins/main/install.sh | bash
# 只装其中一个：在命令末尾加插件名，例如  ... | bash -s document-preview
set -euo pipefail

REPO="${AGY_PLUGINS_REPO:-Eugene20071112/antigravity-plugins}"
BRANCH="${AGY_PLUGINS_BRANCH:-main}"
DEST="$HOME/.gemini/config/plugins"
BACKUP="$HOME/.gemini/backups"
ALL=(document-preview claude-style antigravity-zh)
if [[ $# -gt 0 ]]; then PLUGINS=("$@"); else PLUGINS=("${ALL[@]}"); fi

bold() { printf '\033[1m%s\033[0m\n' "$1"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$1"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$1"; }
die() { printf '\033[31m✗ %s\033[0m\n' "$1" >&2; exit 1; }

[[ "$(uname)" == "Darwin" ]] || die "目前只支持 macOS。"
[[ -d "$HOME/.gemini" ]] || die "没有找到 ~/.gemini，请先安装并打开一次 Antigravity。"

bold "安装 Antigravity 插件：${PLUGINS[*]}"

# Use the plugins next to this script when run from a clone, else download.
TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || true)"
if [[ -n "$HERE" && -f "$HERE/plugins/document-preview/plugin.json" ]]; then
  SRC="$HERE/plugins"
else
  curl -fsSL "https://codeload.github.com/$REPO/tar.gz/refs/heads/$BRANCH" | tar -xz -C "$TMP" || die "下载失败，请检查网络。"
  SRC="$(echo "$TMP"/*/plugins)"
fi

# Ask Antigravity to restart a plugin's sidecar so new files take effect.
restart_sidecar() {
  local name="$1" pid
  for pid in $(pgrep -f "main.mjs" || true); do
    if lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep -q "/plugins/$name/"; then kill "$pid" 2>/dev/null || true; fi
  done
}

mkdir -p "$DEST"
STAMP="$(date +%Y%m%d-%H%M%S)"
for name in "${PLUGINS[@]}"; do
  [[ -f "$SRC/$name/plugin.json" ]] || die "没有这个插件：$name（可选：${ALL[*]}）"
  if [[ -e "$DEST/$name" ]]; then
    mkdir -p "$BACKUP"
    mv "$DEST/$name" "$BACKUP/$name-$STAMP"
    ok "已备份旧版本到 ~/.gemini/backups/$name-$STAMP"
  fi
  cp -R "$SRC/$name" "$DEST/$name"
  restart_sidecar "$name"
  ok "已安装 $name"
done

if [[ " ${PLUGINS[*]} " == *" document-preview "* ]]; then
  echo
  bold "可选依赖（文件预览）"
  if [[ -d /Applications/LibreOffice.app ]]; then ok "LibreOffice：已安装（Word/PPT/Excel/WPS 预览）"
  else warn "未安装 LibreOffice，Office/WPS 文档无法预览。安装：brew install --cask libreoffice"; fi
  if command -v ffmpeg >/dev/null || [[ -x /opt/homebrew/bin/ffmpeg || -x /usr/local/bin/ffmpeg ]]; then ok "ffmpeg：已安装（MKV/AVI/WMA 等格式转换）"
  else warn "未安装 ffmpeg，部分音视频格式无法播放。安装：brew install ffmpeg"; fi
fi

echo
bold "完成！"
echo "  插件会被 Antigravity 自动加载；如果没生效："
echo "  打开 Antigravity → 左侧 Customizations → Installed → 启用对应插件。"
