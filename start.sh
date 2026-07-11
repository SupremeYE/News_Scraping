#!/usr/bin/env bash
# 뉴스 대시보드 원클릭 실행 (macOS / Linux).
cd "$(dirname "$0")" || exit 1

if command -v python3 >/dev/null 2>&1; then
  python3 run.py
else
  python run.py
fi
