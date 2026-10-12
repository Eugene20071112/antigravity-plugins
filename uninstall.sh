#!/bin/bash
# 卸载：curl -fsSL https://raw.githubusercontent.com/Eugene20071112/antigravity-plugins/main/uninstall.sh | bash
set -euo pipefail
DEST="$HOME/.gemini/config/plugins"
ALL=(document-preview claude-style antigravity-zh)
if [[ $# -gt 0 ]]; then PLUGINS=("$@"); else PLUGINS=("${ALL[@]}"); fi
for name in "${PLUGINS[@]}"; do
  [[ "$name" =~ ^(document-preview|claude-style|antigravity-zh)$ ]] || { echo "跳过未知插件：$name"; continue; }
  for pid in $(pgrep -f "main.mjs" || true); do
    if lsof -a -p "$pid" -d cwd -Fn 2>/dev/null | grep -q "/plugins/$name/"; then kill "$pid" 2>/dev/null || true; fi
  done
  if [[ -d "$DEST/$name" ]]; then rm -rf "$DEST/$name"; echo "✓ 已卸载 $name"; else echo "- 未安装 $name"; fi
done
echo "完成。Antigravity 会恢复原样（如界面未刷新，重开一次窗口即可）。"
