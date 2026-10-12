#!/usr/bin/env bash
#
# Проверяльщик «есть обновление» для Claude UI — пишет состояние, которое
# читает интерфейс (плашка «Обновить» в панели слева).
#
# Сама установка здесь НЕ делается — только обнаружение. Применяет человек
# кнопкой (server/modules/updates) или остаётся на своей версии.
#
# Запуск — по расписанию (крон/systemd-таймер, раз в ~30 минут):
#
#   CCUI_UPDATE_REPO=~/cc2/repo \
#   CCUI_UPDATE_REMOTE=egor/main \
#   CCUI_UPDATE_BASE_DIR=~/cc2/current \
#   CCUI_UPDATE_PATCH_DIR=~/cc2/local-patches \
#   CCUI_UPDATE_STATE_DIR=~/cc2/update-state \
#   CCUI_UPDATE_LABEL="Новая версия интерфейса" \
#   bash deploy/selfhost/check-updates.sh
#
# Переменные:
#   CCUI_UPDATE_REPO       — git-репозиторий, в котором делаем fetch (обязательна)
#   CCUI_UPDATE_REMOTE     — откуда берём новое: remote/branch (обязательна)
#   CCUI_UPDATE_BASE_DIR   — чей HEAD считать «работающей версией»: каталог
#                            (worktree/симлинк current). Если не задана —
#                            берётся HEAD самого CCUI_UPDATE_REPO.
#   CCUI_UPDATE_PATCH_DIR  — каталог локальных патчей (*.patch). Конфликт
#                            считаем накладыванием каждого на ЦЕЛЬ: патч,
#                            который не ложится и не снимается обратно, —
#                            реальное пересечение. Без переменной конфликт
#                            считаем сухим merge BASE←REMOTE.
#   CCUI_UPDATE_STATE_DIR  — куда писать pending.json (обязательна)
#   CCUI_UPDATE_LABEL      — подпись источника для человека («от Егора»…)
#   CCUI_UPDATE_SKIP_CONFLICT=1 — не считать конфликт (лёгкий режим)
#
# Состояние (все файлы в STATE_DIR):
#   pending.json   — есть что ставить: id, список коммитов, конфликт
#   apply.json     — идёт/закончилось применение (ставит бэкенд, закрываем мы)
#   dismissed.json — «отложить»: id, которые человек скрыл до следующего пула
#
# Побочный эффект reconcile: если apply.json говорит «running», а работающая
# версия уже равна цели — помечаем ok; если running висит дольше 45 минут —
# помечаем failed (применение могло умереть без следа).

set -uo pipefail

REPO="${CCUI_UPDATE_REPO:?нужен CCUI_UPDATE_REPO}"
REMOTE="${CCUI_UPDATE_REMOTE:?нужен CCUI_UPDATE_REMOTE}"
STATE="${CCUI_UPDATE_STATE_DIR:?нужен CCUI_UPDATE_STATE_DIR}"
BASE_DIR="${CCUI_UPDATE_BASE_DIR:-}"
PATCH_DIR="${CCUI_UPDATE_PATCH_DIR:-}"
LABEL="${CCUI_UPDATE_LABEL:-Обновление}"
APPLY_TIMEOUT_SEC=$((45 * 60))

mkdir -p "$STATE"
exec 9>"$STATE/.check.lock"; flock -n 9 || exit 0

log() { echo "[$(date '+%F %T')] $*"; }

# ── Работающая версия ────────────────────────────────────────────────────────

if [ -n "$BASE_DIR" ]; then
    BASE="$(git -C "$BASE_DIR" rev-parse HEAD 2>/dev/null || true)"
else
    BASE="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || true)"
fi
if [ -z "$BASE" ]; then
    log "не удалось узнать работающую версию — пропуск"
    exit 0
fi

# ── Reconcile применения (до fetch — состояние не должно зависеть от сети) ──

APPLY_FILE="$STATE/apply.json"
if [ -f "$APPLY_FILE" ]; then
    python3 - "$APPLY_FILE" "$BASE" "$APPLY_TIMEOUT_SEC" <<'PY'
import json, sys, time
path, base, timeout = sys.argv[1], sys.argv[2], int(sys.argv[3])
try:
    st = json.load(open(path))
except Exception:
    sys.exit(0)
if st.get("state") != "running":
    sys.exit(0)
if st.get("id", "").startswith(base) or base.startswith(st.get("id", "")):
    st.update(state="ok", finishedAt=time.strftime("%Y-%m-%dT%H:%M:%S%z"), detail="версия поднялась")
elif time.time() - st.get("startedTs", 0) > timeout:
    st.update(state="failed", finishedAt=time.strftime("%Y-%m-%dT%H:%M:%S%z"),
              detail="применение не завершилось за 45 минут — смотрите журнал")
else:
    sys.exit(0)
json.dump(st, open(path, "w"), ensure_ascii=False, indent=1)
PY
fi

# ── Свежая версия источника ──────────────────────────────────────────────────

REMOTE_NAME="${REMOTE%%/*}"
git -C "$REPO" fetch -q "$REMOTE_NAME" || { log "нет связи с источником $REMOTE_NAME"; exit 0; }
TARGET="$(git -C "$REPO" rev-parse "$REMOTE" 2>/dev/null || true)"
[ -z "$TARGET" ] && { log "не виден $REMOTE"; exit 0; }

PENDING_FILE="$STATE/pending.json"

if git -C "$REPO" merge-base --is-ancestor "$TARGET" "$BASE"; then
    rm -f "$PENDING_FILE"
    log "актуально: ${TARGET:0:12}"
    exit 0
fi

# ── Пул изменений ────────────────────────────────────────────────────────────

COMMITS_JSON="$(git -C "$REPO" log --format='{"sha":"%h","subject":"%s","date":"%cI","author":"%an"}' "$BASE..$TARGET" | python3 -c 'import sys,json; print(json.dumps([json.loads(l) for l in sys.stdin if l.strip()], ensure_ascii=False))')"
STAT="$(git -C "$REPO" diff --shortstat "$BASE..$TARGET")"
FILES_CHANGED="$(git -C "$REPO" diff --name-only "$BASE..$TARGET" | wc -l | tr -d ' ')"

# ── Конфликт: пересекается ли обновление с нашими правками ───────────────────

CONFLICT_JSON="null"
if [ "${CCUI_UPDATE_SKIP_CONFLICT:-}" != "1" ]; then
    WT="$STATE/.conflict-wt"
    git -C "$REPO" worktree remove --force "$WT" 2>/dev/null
    rm -rf "$WT"

    if [ -n "$PATCH_DIR" ] && ls "$PATCH_DIR"/*.patch >/dev/null 2>&1; then
        # Патч-режим: пробуем наложить каждый патч на ЦЕЛЬ. Не лёг и не
        # снимается обратно (т.е. не влит в обновление) — реальное пересечение.
        git -C "$REPO" worktree add -q --detach "$WT" "$TARGET" || { log "не создался пробный каталог"; exit 0; }
        CONFLICT_JSON="$(
        cd "$WT" || exit 1
        python3 - "$PATCH_DIR" <<'PY'
import glob, json, os, subprocess, sys
items = []
for patch in sorted(glob.glob(os.path.join(sys.argv[1], "*.patch"))):
    if subprocess.run(["git", "apply", "--check", patch], capture_output=True).returncode == 0:
        continue
    if subprocess.run(["git", "apply", "-R", "--check", patch], capture_output=True).returncode == 0:
        continue  # уже влит в обновление — не конфликт
    items.append({"path": os.path.basename(patch), "note": "локальная правка не ложится на новую версию"})
print(json.dumps({"kind": "patches", "items": items}, ensure_ascii=False) if items else "null")
PY
        )"
    else
        # Merge-режим: сухое слияние работающей версии с входящим пулом.
        # Важно: у источника-снапшота (живая копия другого сервера) голова
        # ВСЕГДА новее — коммит-разница сама по себе ни о чём не говорит.
        # Смотрим, что реально внесло бы слияние: пустой итог = источник несёт
        # только наши же уже принятые изменения (эхо), плашка не нужна.
        git -C "$REPO" worktree add -q --detach "$WT" "$BASE" || { log "не создался пробный каталог"; exit 0; }
        MERGE_RESULT="$(
        cd "$WT" || exit 1
        # stdout глушим весь: служебные строки merge (Auto-merging/CONFLICT)
        # не должны протекать в JSON результата.
        if git -c user.name=update-check -c user.email=update-check@local merge --no-commit --no-ff "$TARGET" >/dev/null 2>&1; then
            brought="$(git diff --cached --name-only | wc -l | tr -d ' ')"
            git merge --abort 2>/dev/null || git reset -q --hard >/dev/null 2>&1
            [ "$brought" = "0" ] && echo "EMPTY" || echo "null"
        else
            files="$(git diff --name-only --diff-filter=U | python3 -c 'import sys,json; print(json.dumps([{"path": l.strip(), "note": "меняется с обеих сторон"} for l in sys.stdin if l.strip()], ensure_ascii=False))')"
            git merge --abort 2>/dev/null || git reset -q --hard >/dev/null 2>&1
            python3 -c "import json,sys; items=json.loads(sys.argv[1]); print(json.dumps({'kind':'merge','total':len(items),'items':items[:15]}, ensure_ascii=False))" "$files"
        fi
        )"
        if [ "$MERGE_RESULT" = "EMPTY" ]; then
            rm -f "$PENDING_FILE"
            log "источник несёт только уже принятые изменения (эхо) — плашка не нужна"
            exit 0
        fi
        CONFLICT_JSON="$MERGE_RESULT"
    fi

    cd "$REPO" 2>/dev/null
    git -C "$REPO" worktree remove --force "$WT" 2>/dev/null
    rm -rf "$WT"
fi

# ── Записываем состояние для интерфейса ──────────────────────────────────────

TMP_STATE="$STATE/.pending.$$"
printf '%s' "$COMMITS_JSON" > "$TMP_STATE.commits"
printf '%s' "$CONFLICT_JSON" > "$TMP_STATE.conflict"
CCUI_TARGET="$TARGET" CCUI_BASE="$BASE" CCUI_REMOTE="$REMOTE" \
CCUI_LABEL="$LABEL" CCUI_STAT="$STAT" CCUI_FILES="$FILES_CHANGED" \
python3 - "$PENDING_FILE" "$TMP_STATE" <<'PY'
import json, os, sys, time
pending_path, tmp = sys.argv[1], sys.argv[2]
commits = json.load(open(tmp + ".commits"))
conflict = json.load(open(tmp + ".conflict"))
state = {
    "id": os.environ["CCUI_TARGET"],
    "label": os.environ["CCUI_LABEL"],
    "remote": os.environ["CCUI_REMOTE"],
    "base": os.environ["CCUI_BASE"],
    "commits": commits,
    "filesChanged": int(os.environ.get("CCUI_FILES") or 0),
    "diffStat": os.environ.get("CCUI_STAT", "").strip(),
    "conflict": conflict,
    "checkedAt": time.strftime("%Y-%m-%dT%H:%M:%S%z"),
}
json.dump(state, open(pending_path, "w"), ensure_ascii=False, indent=1)
PY
rm -f "$TMP_STATE.commits" "$TMP_STATE.conflict"

log "обновление ${TARGET:0:12}: $(echo "$COMMITS_JSON" | python3 -c 'import sys,json; print(len(json.load(sys.stdin)))') коммитов, конфликт: $CONFLICT_JSON"
