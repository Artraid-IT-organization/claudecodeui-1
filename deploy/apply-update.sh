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
    # Собираем не в рабочей копии, откуда пришла версия, а в своей замороженной
    # копии ровно этого коммита. 19.10.26 20:45 кнопка не сработала: чат-автор
    # успел докоммитить в свою копию (9a6902b3 поверх 5a82c0bb), сверка
    # «копия = кнопка» упала, а плашка ещё минуту показывала старую версию.
    # Рабочая копия чата живёт своей жизнью (коммиты, несохранённые правки),
    # собирать из неё — гонка. sourceWorktree теперь только для справки.
    REPO=/home/claude/claudecodeui
    git -C "$REPO" cat-file -e "$ID^{commit}" 2>/dev/null || {
        echo "Коммита ${ID:0:12} нет в $REPO — собрать нечего"; exit 1;
    }
    # Пока версия ждала нажатия, на сайт могли выкатить другую ветку напрямую
    # (19.10.26 20:49 — 4ea93a98 мимо кнопки). Тогда эта версия сняла бы чужую
    # работу; сборщик её всё равно отклонит, но после минут сборки. Отказываем
    # сразу и снимаем плашку, которую применить уже нельзя.
    LIVE="$(git -C /home/claude/claudecodeui-shared rev-parse HEAD 2>/dev/null || true)"
    if [ -n "$LIVE" ] && ! git -C "$REPO" merge-base --is-ancestor "$LIVE" "$ID"; then
        echo "Обновление ${ID:0:12} устарело: на сайте уже ${LIVE:0:8}, которого в нём нет. Плашка снята — версию нужно собрать заново поверх живой"
        clear_pending
        write_failed "версия устарела — на сайт уже выкатили более новую, её нужно собрать заново"
        /home/claude/scripts/notify.sh "Обновление сайта ${ID:0:8} устарело (на сайте уже ${LIVE:0:8}) — плашка снята, соберите заново поверх живой" error >/dev/null 2>&1
        exit 1
    fi
    SNAP_ROOT=/home/claude/.cloudcli/update-builds
    SNAP="$SNAP_ROOT/${ID:0:12}"
    # Прошлые замороженные копии — одноразовые артефакты этого же скрипта.
    for old in "$SNAP_ROOT"/*; do
        [ -d "$old" ] && git -C "$REPO" worktree remove --force "$old" 2>/dev/null
    done
    git -C "$REPO" worktree prune
    mkdir -p "$SNAP_ROOT"
    [ -d "$SNAP" ] || git -C "$REPO" worktree add -q --detach "$SNAP" "$ID" || {
        echo "Не удалось создать копию ${ID:0:12} для сборки"; exit 1;
    }
    bash "$SNAP/deploy/build-shared.sh" "$ID" --apply || exit 1
else
    bash /home/claude/scripts/ccui-accept-remote.sh || exit 1
fi

clear_pending
write_ok
SUCCESS=1
exit 0
