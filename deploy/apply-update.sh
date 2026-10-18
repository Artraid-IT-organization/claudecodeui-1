#!/usr/bin/env bash
set -uo pipefail

STATE=/home/claude/.cloudcli/update-state
PENDING="$STATE/pending.json"
APPLY_FILE="$STATE/apply.json"
SUCCESS=0

write_state() {
    local new_state="$1"
    local reason="${2:-}"
    if [ -z "${CCUI_UPDATE_ID:-}" ]; then
        return 0
    fi
    python3 - "$APPLY_FILE" "$CCUI_UPDATE_ID" "$new_state" "$reason" <<'PY'
import json, sys, time
path, expect_id, new_state, reason = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4]
try:
    st = json.load(open(path))
except Exception:
    sys.exit(1)
if st.get("state") == "running" and st.get("id") == expect_id:
    st.update(state=new_state, finishedAt=time.strftime("%Y-%m-%dT%H:%M:%S%z"), detail=reason or ("версия поднялась" if new_state == "ok" else "применение не завершилось"))
    json.dump(st, open(path, "w"), ensure_ascii=False, indent=1)
PY
}

write_ok()  { write_state "ok"  "версия поднялась"; }
write_failed() { write_state "failed" "${1:-применение не завершилось}"; }

# Применённый пул больше не ждёт решения: убираем pending.json, чтобы плашка
# «Обновить» не показывала уже вставленную версию ещё раз. Снимаем только при
# совпадении id — если за время установки пришёл новый пул, его не трогаем.
clear_pending() {
    [ -f "$PENDING" ] || return 0
    python3 - "$PENDING" "$ID" <<'PY' || true
import json, os, sys
path, expect_id = sys.argv[1], sys.argv[2]
try:
    st = json.load(open(path))
except Exception:
    sys.exit(0)
if st.get("id") == expect_id:
    os.remove(path)
PY
}

trap 'if [ "$SUCCESS" -ne 1 ]; then write_failed "применение прервалось на ошибке"; fi' EXIT

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
    bash "$SOURCE/deploy/build-shared.sh" "$ID" --apply || exit 1
else
    bash /home/claude/scripts/ccui-accept-remote.sh || exit 1
fi

clear_pending
write_ok
SUCCESS=1
exit 0
