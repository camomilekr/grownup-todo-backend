#!/usr/bin/env bash
#
# 검토 대상을 고정하는 지문. 리뷰 시작 전과 커밋 직전에 찍어 대조한다.
#
#   .claude/scripts/fingerprint.sh [워크트리 경로]
#
# `git diff | shasum`만 찍으면 **추적되지 않는 파일이 빠진다.** 신규 테스트 파일 232줄이
# 지문에 들어가지 않아 "고정한 줄 알았던 것이 고정되지 않은" 사례가 있었다
# (`.claude/ref/incidents.md`). git add -N으로 경로만 인덱스에 등록하면 git diff가 그
# 파일을 신규로 취급해 전체 내용을 포함한다. 내용은 스테이징되지 않으므로 나중에 경로를
# 지정해 의미 단위로 나눠 커밋하는 데 지장이 없다.
set -euo pipefail

cd "${1:-.}"
git rev-parse --is-inside-work-tree >/dev/null

git add -N . >/dev/null
git diff HEAD | shasum | cut -c1-12
