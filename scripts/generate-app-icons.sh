#!/usr/bin/env bash
# Web App Manifest 用のアプリアイコン（PNG）を favicon.svg から再生成する（Issue #150）。
#
# アイコンの実体は「favicon.svg をラスタライズしたもの」であり、独自に描き起こしていない。
# タブの favicon とインストール後のアプリアイコンが同一の見た目になることを保証するため
# （デザインが 2 箇所に分岐すると favicon.svg を直しても Dock のアイコンが古いままになる）。
#
# 生成物（src/ui/public/icon-*.png）はリポジトリにコミット済みの静的アセットであり、
# npm run build はこのスクリプトに依存しない（rasterizer をビルドの必須依存にしない）。
# favicon.svg を変更したときだけ手で再実行し、差分をコミットする。
#
# 必要: librsvg の rsvg-convert（macOS なら `brew install librsvg`）
set -euo pipefail

cd "$(dirname "$0")/.."

for size in 192 512; do
  rsvg-convert \
    --width "$size" --height "$size" \
    --format png \
    --output "src/ui/public/icon-${size}.png" \
    src/ui/public/favicon.svg
  echo "generated: src/ui/public/icon-${size}.png (${size}x${size})"
done
