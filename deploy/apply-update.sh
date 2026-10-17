#!/usr/bin/env bash
set -uo pipefail

STATE=/home/claude/.cloudcli/update-state
PENDING="$STATE/pending.json"

[ -f "$PENDING" ] || { echo "Нет ожидающего обновления"; exit 1; }
readarray -t values < <(python3 - "$PENDING" <<'PY'
import json, sys
state = json.load(open(sys.argv[1]))
print(state.get("id", ""))
print(state.get("remote", ""))
print(state.get("sourceWorktree", ""))
PY
)
ID="${values[0]:-}"
REMOTE="${values[1]:-}"
SOURCE="${values[2]:-}"

[ -n "$ID" ] || { echo "У ожидающего обновления нет id"; exit 1; }
[ -z "${CCUI_UPDATE_ID:-}" ] || [ "$CCUI_UPDATE_ID" = "$ID" ] || {
    echo "Кнопка относится к другому обновлению"; exit 1;
}

if [ "$REMOTE" = "local-build" ]; then
    [ -n "$SOURCE" ] && [ -f "$SOURCE/deploy/build-shared.sh" ] || {
        echo "Исходная рабочая копия готовой версии недоступна"; exit 1;
    }
    HEAD_NOW="$(git -C "$SOURCE" rev-parse HEAD 2>/dev/null || true)"
    [ "$HEAD_NOW" = "$ID" ] || { echo "Рабочая копия изменилась после подготовки обновления"; exit 1; }
    exec bash "$SOURCE/deploy/build-shared.sh" "$ID" --apply
fi

exec bash /home/claude/scripts/ccui-accept-remote.sh
