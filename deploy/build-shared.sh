#!/usr/bin/env bash
#
# Собирает общий (multi-tenant) инстанс и перезапускает его.
#
# Сборка идёт В СВОЁМ worktree и БЕЗ общего замка. Замок берётся только на
# подмену готовых файлов и перезапуск — это секунды вместо десяти-пятнадцати
# минут. Раньше замок держался всю сборку целиком, и два чата, ведущих проект,
# блокировали друг друга наглухо: один стоял в очереди, не имея возможности
# ничего сообщить, а со стороны это выглядело как зависание.
#
# Использование: bash deploy/build-shared.sh <коммит> [--no-restart]
#   Запускать из своего worktree. Скрипт сам проверит, что он на этом коммите.

set -uo pipefail

COMMIT="${1:?укажите коммит}"
NO_RESTART="${2:-}"
SELF="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SHARED="/home/claude/claudecodeui-shared"
SOURCE_MODULES="/home/claude/claudecodeui/node_modules"
DB="/home/claude/.cloudcli-shared/auth.db"
BACKUP_DIR="/home/claude/.cloudcli-shared/backups"
ATTEMPTS=12

say() { echo "[$(date +%H:%M:%S)] $*"; }

# ── Шаг 1. Сборка у себя, без общего замка ───────────────────────────────────

cd "$SELF" || exit 1
HEAD_NOW="$(git rev-parse HEAD)"
if [ "${HEAD_NOW:0:${#COMMIT}}" != "$COMMIT" ]; then
    say "ОШИБКА: $SELF стоит на $HEAD_NOW, а собрать просят $COMMIT"
    exit 1
fi
say "Сборка в своём каталоге: $(git log --oneline -1)"

# Жёсткие ссылки вместо npm install: семь секунд, места не занимают и, в отличие
# от установки в worktree, не теряют молча devDependencies.
cp -al "$SOURCE_MODULES/." node_modules/ 2>/dev/null
if [ ! -x node_modules/.bin/vite ]; then
    say "ОШИБКА: vite не найден после cp -al"
    exit 1
fi

# Node подбирает размер кучи по СВОБОДНОЙ памяти на момент запуска. На
# загруженном сервере он брал 259 МБ, компилятор уходил в бесконечную сборку
# мусора и падал с «heap out of memory». Это и была та самая «сборка регулярно
# падает по памяти» — не нехватка ОЗУ, а слишком скромный лимит по умолчанию.
export NODE_OPTIONS="--max-old-space-size=1536"
export OPEN_REGISTRATION=true

built=0
for attempt in $(seq 1 "$ATTEMPTS"); do
    say "Сборка, попытка $attempt из $ATTEMPTS"
    if nice -n 19 ionice -c 3 npm run build; then
        built=1
        say "Сборка удалась"
        break
    fi
    say "Попытка $attempt не удалась, пауза 45 с"
    sleep 45
done
[ "$built" -eq 1 ] || { say "ОШИБКА: не собралось за $ATTEMPTS попыток"; exit 1; }

# Проверяем СОДЕРЖИМЫМ, а не временем файла: dist-server умеет сохранять старые
# mtime, поэтому «свежесть» по дате врёт.
missing=""
grep -rq "account_scan_state" "$SELF/dist-server" 2>/dev/null || missing="$missing разделение-аккаунтов"
grep -rq "loginToken" "$SELF/dist/assets" 2>/dev/null || missing="$missing иконка-на-экране-Домой"
[ -z "$missing" ] || { say "ОШИБКА: в собранных файлах нет правок:$missing"; exit 1; }
say "Проверка содержимого пройдена"

if [ "$NO_RESTART" = "--no-restart" ]; then
    say "Подмена и перезапуск пропущены по флагу"
    exit 0
fi

# ── Шаг 2. Подмена и перезапуск — под общим замком, считанные секунды ─────────

mkdir -p "$BACKUP_DIR"
BACKUP="$BACKUP_DIR/auth.db.bak-$(date +%Y%m%d-%H%M%S)"

say "Жду общий замок…"
LOCK_WAIT_START=$SECONDS
exec 9>/tmp/ccui-deploy.lock
if ! flock -w 3600 9; then
    say "ОШИБКА: замок занят дольше часа"
    exit 1
fi
say "Замок взят (ждал $((SECONDS - LOCK_WAIT_START)) с)"
LOCK_HELD_START=$SECONDS

# ── Не убить чужую работу перезапуском ───────────────────────────────────────
#
# Агент — прямой дочерний процесс веб-сервера, а сервис живёт с
# KillMode=control-group: перезапуск убивает всю группу разом, вместе со всеми
# работающими агентами. Проверено деревом процессов 11.09.26.
#
# При этом сам сервер не падает никогда (NRestarts=0, в лимит памяти ни разу не
# упирались). Значит выкатка — ЕДИНСТВЕННАЯ причина, по которой у человека
# посреди работы обрывается агент. Егор про это и говорил: «процесс не
# останавливается ни в коем случае, только если я не нажму кнопку остановки».
#
# Поэтому перед перезапуском ждём, пока работающие агенты закончат сами.
# Ждём долго — час: человек запускает длинные задачи и уходит. Не дождались —
# файлы всё равно подменяем (свежий вид сайта человек получит сразу), но
# перезапуск откладываем: серверная часть подхватится следующей выкаткой.
wait_for_idle_agents() {
    local deadline=$((SECONDS + 3600))
    local announced=0

    while :; do
        local busy
        busy=$(pgrep -fc "claude --output-format stream-json" 2>/dev/null || echo 0)
        [ "$busy" -eq 0 ] && return 0

        if [ "$announced" -eq 0 ]; then
            say "Работают агенты ($busy) — жду, чтобы не оборвать их перезапуском"
            announced=1
        fi

        if [ "$SECONDS" -ge "$deadline" ]; then
            say "Агенты не закончили за час — файлы подменю, перезапуск отложу"
            return 1
        fi
        sleep 15
    done
}

AGENTS_IDLE=0
wait_for_idle_agents && AGENTS_IDLE=1

swap() {
    cd "$SHARED" || return 1
    git checkout -q "$COMMIT" || return 1

    # Предыдущая сборка не удаляется, а отодвигается в *.prev — это мгновенный
    # откат, если новая окажется нерабочей.
    for d in dist dist-server; do
        rm -rf "$d.prev"
        [ -d "$d" ] && mv "$d" "$d.prev"
        cp -a "$SELF/$d" "$d" || return 1
    done

    cp -a "$DB" "$BACKUP"

    if [ "$AGENTS_IDLE" -eq 1 ]; then
        sudo -n systemctl restart claudecodeui-shared
    else
        say "Перезапуск пропущен: агенты ещё работают, обрывать их нельзя"
        say "Новый вид сайта уже доступен; серверная часть встанет со следующей выкаткой"
    fi
}

if swap; then
    say "Подменено и перезапущено. Замок держался $((SECONDS - LOCK_HELD_START)) с"
    say "Копия базы: $BACKUP"
    say "Откат при необходимости: mv dist.prev dist && mv dist-server.prev dist-server && sudo -n systemctl restart claudecodeui-shared"
else
    say "ОШИБКА на подмене — возвращаю предыдущую сборку"
    cd "$SHARED" && for d in dist dist-server; do
        [ -d "$d.prev" ] && rm -rf "$d" && mv "$d.prev" "$d"
    done
    sudo -n systemctl restart claudecodeui-shared
    exit 1
fi
