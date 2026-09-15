#!/usr/bin/env bash
#
# Установка Claude UI на свой сервер (Ubuntu / Debian). Запускать от root:
#
#   sudo bash deploy/selfhost/install.sh --user claude [--create-user] \
#        [--domain ui.example.ru] [--email me@example.com] [--port 3003] \
#        [--groq-key gsk_...] [--owner-name asya]
#
# Что делает (повторный запуск безопасен — сделанное пропускается):
#   1. Проверяет сервер: память, диск, не заняты ли порты 80/443 чужой программой.
#   2. Ставит системные пакеты (nginx, certbot, сборочные инструменты).
#   3. Ставит пользователю Node 22 (nvm) и Claude Code, если их нет.
#   4. Скачивает репозиторий, собирает и проверяет первую версию (update.sh --first).
#   5. Пишет настройки app.env, службу systemd и ночной таймер обновлений.
#   6. Настраивает адрес сайта с HTTPS. Без --domain берёт бесплатный адрес
#      <ip-через-дефисы>.sslip.io — покупать домен не нужно.
#   7. Создаёт владельца (первого пользователя) и печатает его ссылку входа.
#
# Итог — ~/claudecodeui-app/install-summary.txt (читает только пользователь службы).

set -euo pipefail

REPO_URL="${CCUI_REPO_URL:-https://github.com/Seikatsuma/claudecodeui.git}"
BRANCH="${CCUI_BRANCH:-main}"
SERVICE="claudecodeui"
NVM_VERSION="v0.40.7"

RUN_USER=""
CREATE_USER=0
DOMAIN=""
EMAIL=""
PORT=""
GROQ_KEY=""
OWNER_NAME="owner"

die() { echo "ОШИБКА: $*" >&2; exit 1; }
say() { echo "==> $*"; }

while [ $# -gt 0 ]; do
    case "$1" in
        --user)        RUN_USER="${2:-}"; shift 2 ;;
        --create-user) CREATE_USER=1; shift ;;
        --domain)      DOMAIN="${2:-}"; shift 2 ;;
        --email)       EMAIL="${2:-}"; shift 2 ;;
        --port)        PORT="${2:-}"; shift 2 ;;
        --groq-key)    GROQ_KEY="${2:-}"; shift 2 ;;
        --owner-name)  OWNER_NAME="${2:-}"; shift 2 ;;
        *) die "неизвестный параметр $1" ;;
    esac
done

# ── 1. Проверки ──────────────────────────────────────────────────────────────

[ "$(id -u)" -eq 0 ] || die "запускать от root: sudo bash $0 --user <имя>"
command -v apt-get > /dev/null || die "поддерживаются Ubuntu и Debian (нужен apt-get)"
[ -n "$RUN_USER" ] || die "укажите --user <имя> — от этого пользователя будет работать интерфейс (не root)"
# Claude Code отказывается работать в режиме без подтверждений от root.
[ "$RUN_USER" != "root" ] || die "нужен обычный пользователь, не root. Например: --user claude --create-user"
[[ "$OWNER_NAME" =~ ^[A-Za-z0-9_-]{3,32}$ ]] || die "--owner-name: латиница, цифры, _ и -, от 3 до 32 знаков"
[ -z "$GROQ_KEY" ] || [[ "$GROQ_KEY" =~ ^gsk_[A-Za-z0-9]+$ ]] || die "--groq-key должен начинаться с gsk_"

if ! id "$RUN_USER" > /dev/null 2>&1; then
    [ "$CREATE_USER" -eq 1 ] || die "пользователя $RUN_USER нет; добавьте --create-user"
    say "Создаю пользователя $RUN_USER"
    useradd -m -s /bin/bash "$RUN_USER"
fi
HOME_DIR="$(getent passwd "$RUN_USER" | cut -d: -f6)"
APP="$HOME_DIR/claudecodeui-app"
ENV_FILE="$APP/app.env"
SUMMARY="$APP/install-summary.txt"

as_user() { runuser -u "$RUN_USER" -- env HOME="$HOME_DIR" USER="$RUN_USER" bash -c "$1"; }

mem_mb=$(( $(awk '/MemTotal/ {print $2}' /proc/meminfo) / 1024 ))
# Тариф «4 ГБ» система видит как ~3,8 ГБ. Меньше — сборка (куча 1,5 ГБ) вместе
# с работающим Claude упирается в память и падает посреди ночного обновления.
[ "$mem_mb" -ge 3400 ] || die "памяти ${mem_mb} МБ — нужен сервер от 4 ГБ: сборке нужно около 2 ГБ и Claude Code ещё столько же"
free_gb=$(( $(df -Pk "$HOME_DIR" | awk 'NR==2 {print $4}') / 1024 / 1024 ))
[ "$free_gb" -ge 5 ] || die "на диске свободно ${free_gb} ГБ, нужно хотя бы 5"

for p in 80 443; do
    holder="$(ss -ltnpH "sport = :$p" 2> /dev/null | grep -oE 'users:\(\("[^"]+' | head -1 | sed 's/users:(("//' || true)"
    if [ -n "$holder" ] && [ "$holder" != "nginx" ]; then
        die "порт $p занят программой «$holder». Установщик настраивает сайт через nginx и чужую программу не трогает"
    fi
done

# ── 2. Пакеты ────────────────────────────────────────────────────────────────

say "Системные пакеты"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq
apt-get install -y -qq git curl ca-certificates nginx certbot build-essential python3 sqlite3 sudo > /dev/null
systemctl enable --now nginx > /dev/null 2>&1 || true

# ── Адрес и порт ─────────────────────────────────────────────────────────────

envval() { [ -f "$ENV_FILE" ] && grep -E "^$1=" "$ENV_FILE" | tail -1 | cut -d= -f2- || true; }

PUBLIC_IP="$(curl -4 -fsS --max-time 10 https://api.ipify.org || curl -4 -fsS --max-time 10 https://ifconfig.me || true)"
[ -n "$PUBLIC_IP" ] || die "не удалось узнать внешний IP сервера"
[ -n "$DOMAIN" ] || DOMAIN="$(envval CCUI_DOMAIN)"
[ -n "$DOMAIN" ] || DOMAIN="${PUBLIC_IP//./-}.sslip.io"
resolved="$(getent ahostsv4 "$DOMAIN" | awk '{print $1}' | sort -u | tr '\n' ' ' || true)"
echo " $resolved " | grep -q " $PUBLIC_IP " \
    || die "адрес $DOMAIN указывает на «${resolved:-никуда}», а у сервера IP $PUBLIC_IP. Если запись в DNS только что создана — подождите 10–30 минут и запустите снова"

[ -n "$PORT" ] || PORT="$(envval SERVER_PORT)"
if [ -z "$PORT" ]; then
    PORT=3003
    while ss -ltnH "sport = :$PORT" 2> /dev/null | grep -q .; do PORT=$((PORT + 1)); done
fi

# ── 3. Node и Claude Code ────────────────────────────────────────────────────

say "Node.js 22"
NODE_DIR="$(ls -d "$HOME_DIR"/.nvm/versions/node/v2[2-9]*/bin 2> /dev/null | sort -V | tail -1 || true)"
if [ -z "$NODE_DIR" ]; then
    as_user "curl -fsSL https://raw.githubusercontent.com/nvm-sh/nvm/$NVM_VERSION/install.sh | bash" > /dev/null
    as_user 'export NVM_DIR="$HOME/.nvm"; . "$NVM_DIR/nvm.sh"; nvm install 22' > /dev/null
    NODE_DIR="$(ls -d "$HOME_DIR"/.nvm/versions/node/v22*/bin 2> /dev/null | sort -V | tail -1 || true)"
fi
[ -n "$NODE_DIR" ] && [ -x "$NODE_DIR/node" ] || die "Node.js не установился"

say "Claude Code"
if [ ! -x "$HOME_DIR/.local/bin/claude" ] && ! as_user 'command -v claude' > /dev/null 2>&1; then
    as_user 'curl -fsSL https://claude.ai/install.sh | bash' > /dev/null
fi

# ── 4. Код, настройки, первая версия ─────────────────────────────────────────

say "Код с GitHub"
as_user "mkdir -p '$APP' '$HOME_DIR/.cloudcli-shared'"
if [ ! -d "$APP/repo/.git" ]; then
    as_user "git clone -q --branch '$BRANCH' '$REPO_URL' '$APP/repo'"
else
    as_user "git -C '$APP/repo' fetch -q origin '$BRANCH'"
fi

if [ ! -f "$ENV_FILE" ]; then
    cat > "$ENV_FILE" << EOF
# Настройки Claude UI. После правки: sudo systemctl restart $SERVICE
NODE_ENV=production
HOST=127.0.0.1
SERVER_PORT=$PORT
# Вход по личным ссылкам и приглашениям. Первый пользователь (id 1) — владелец:
# его чаты работают через вход в Claude этого сервера (~/.claude).
OPEN_REGISTRATION=true
PLATFORM_OWNER_WEB_USER_IDS=1
DATABASE_PATH=$HOME_DIR/.cloudcli-shared/auth.db
NODE_OPTIONS=--max-old-space-size=1024
CCUI_NODE_DIR=$NODE_DIR
CCUI_DOMAIN=$DOMAIN
# Голосовой ввод — бесплатный Groq, ключ: https://console.groq.com/keys
# Пока ключа нет, строки закомментированы и микрофон не распознаёт речь.
#VOICE_API_BASE_URL=https://api.groq.com/openai/v1
#VOICE_API_KEY=
#VOICE_STT_MODEL=whisper-large-v3
EOF
fi

set_env() {
    if grep -qE "^#?$1=" "$ENV_FILE"; then
        sed -i -E "s|^#?$1=.*|$1=$2|" "$ENV_FILE"
    else
        echo "$1=$2" >> "$ENV_FILE"
    fi
}
set_env SERVER_PORT "$PORT"
set_env CCUI_NODE_DIR "$NODE_DIR"
set_env CCUI_DOMAIN "$DOMAIN"
if [ -n "$GROQ_KEY" ]; then
    set_env VOICE_API_BASE_URL "https://api.groq.com/openai/v1"
    set_env VOICE_API_KEY "$GROQ_KEY"
    set_env VOICE_STT_MODEL "whisper-large-v3"
fi
chown "$RUN_USER:" "$ENV_FILE"
chmod 600 "$ENV_FILE"

# Владелец работает через тот же вход в Claude, что и терминал этого
# пользователя: папка владельца — ссылка на ~/.claude, а не копия. Ключи входа
# никогда не копировать между папками: при продлении старый ключ перестаёт
# действовать, и одна из копий молча теряет вход.
if [ ! -e "$HOME_DIR/.claude-webuser-1" ]; then
    as_user "mkdir -p '$HOME_DIR/.claude' && ln -s '$HOME_DIR/.claude' '$HOME_DIR/.claude-webuser-1'"
elif [ ! -L "$HOME_DIR/.claude-webuser-1" ]; then
    say "ВНИМАНИЕ: $HOME_DIR/.claude-webuser-1 — отдельная папка, не ссылка на ~/.claude: владелец входит в Claude отдельно"
fi

say "Сборка и проверка первой версии — 5–15 минут"
as_user "CCUI_APP_DIR='$APP' bash '$APP/repo/deploy/selfhost/update.sh' --first" \
    || die "первая версия не собралась: $(tail -1 "$APP/update-status.txt" 2> /dev/null)"

# ── 5. Служба и ночные обновления ────────────────────────────────────────────

say "Служба $SERVICE"
mem_high=$(( mem_mb * 65 / 100 ))
mem_max=$(( mem_mb * 80 / 100 ))

cat > "/etc/systemd/system/$SERVICE.service" << EOF
[Unit]
Description=Claude UI (claudecodeui)
After=network.target
StartLimitIntervalSec=300
StartLimitBurst=5

[Service]
Type=simple
User=$RUN_USER
WorkingDirectory=$APP/current
EnvironmentFile=$ENV_FILE
Environment=PATH=$NODE_DIR:$HOME_DIR/.local/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
ExecStart=$NODE_DIR/node dist-server/server/index.js
Restart=on-failure
RestartSec=10
# Перезапуск (например, обновление) снимает только сам сервер: запущенные чаты
# доживают и доделывают ответ, интерфейс подхватывает их после старта.
KillMode=process
MemoryHigh=${mem_high}M
MemoryMax=${mem_max}M

[Install]
WantedBy=multi-user.target
EOF

cat > "/etc/systemd/system/$SERVICE-update.service" << EOF
[Unit]
Description=Claude UI — обновление с GitHub с проверкой
After=network-online.target

[Service]
Type=oneshot
User=$RUN_USER
Environment=CCUI_APP_DIR=$APP
ExecStart=/bin/bash $APP/current/deploy/selfhost/update.sh
Nice=19
IOSchedulingClass=idle
TimeoutStartSec=3600
EOF

cat > "/etc/systemd/system/$SERVICE-update.timer" << EOF
[Unit]
Description=Claude UI — попытки обновления ночью

[Timer]
OnCalendar=*-*-* 03,04,05,06:20:00
RandomizedDelaySec=600

[Install]
WantedBy=timers.target
EOF

# Обновлению нужно перезапустить службу — только эту команду и без пароля.
SUDOERS="/etc/sudoers.d/$SERVICE-update"
echo "$RUN_USER ALL=(root) NOPASSWD: /usr/bin/systemctl restart $SERVICE, /bin/systemctl restart $SERVICE" > "$SUDOERS"
chmod 440 "$SUDOERS"
visudo -cf "$SUDOERS" > /dev/null || die "не удалось разрешить перезапуск службы для обновлений ($SUDOERS)"

systemctl daemon-reload
systemctl enable "$SERVICE" > /dev/null 2>&1
systemctl enable --now "$SERVICE-update.timer" > /dev/null 2>&1
systemctl restart "$SERVICE"

for _ in $(seq 1 45); do
    sleep 2
    curl -sf "http://127.0.0.1:$PORT/api/auth/status" > /dev/null && break
done
curl -sf "http://127.0.0.1:$PORT/api/auth/status" > /dev/null \
    || die "служба не отвечает. Подробности: journalctl -u $SERVICE -n 50"

# ── 6. Адрес сайта с HTTPS ───────────────────────────────────────────────────

say "Адрес https://$DOMAIN"
NGINX_CONF="/etc/nginx/conf.d/$SERVICE.conf"
if grep -rlsE "server_name[^;]*[[:space:]]$DOMAIN[[:space:];]" /etc/nginx/conf.d /etc/nginx/sites-enabled \
    | grep -vx "$NGINX_CONF" | grep -q .; then
    die "в nginx уже есть другой сайт с адресом $DOMAIN — установщик его не трогает"
fi

if command -v ufw > /dev/null && ufw status 2> /dev/null | grep -q "Status: active"; then
    ufw allow 80/tcp > /dev/null
    ufw allow 443/tcp > /dev/null
fi

mkdir -p /var/www/html
if [ ! -f "/etc/letsencrypt/live/$DOMAIN/fullchain.pem" ]; then
    cat > "$NGINX_CONF" << EOF
server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 404; }
}
EOF
    nginx -t 2> /dev/null || die "nginx не принял временную настройку: nginx -t"
    systemctl reload nginx
    if [ -n "$EMAIL" ]; then
        mail_opt=(-m "$EMAIL")
    else
        mail_opt=(--register-unsafely-without-email)
    fi
    if ! certbot certonly --webroot -w /var/www/html -d "$DOMAIN" --non-interactive --agree-tos \
        "${mail_opt[@]}" --deploy-hook "systemctl reload nginx"; then
        # У бесплатного sslip.io бывает исчерпан общий недельный лимит
        # сертификатов Let's Encrypt; у nip.io лимит свой — пробуем его.
        FALLBACK="${PUBLIC_IP//./-}.nip.io"
        if [ "$DOMAIN" = "${PUBLIC_IP//./-}.sslip.io" ] && getent ahostsv4 "$FALLBACK" | grep -q "$PUBLIC_IP"; then
            say "sslip.io не выдал сертификат — пробую $FALLBACK"
            sed -i "s|server_name $DOMAIN;|server_name $FALLBACK;|" "$NGINX_CONF"
            nginx -t 2> /dev/null && systemctl reload nginx
            DOMAIN="$FALLBACK"
            set_env CCUI_DOMAIN "$DOMAIN"
            certbot certonly --webroot -w /var/www/html -d "$DOMAIN" --non-interactive --agree-tos \
                "${mail_opt[@]}" --deploy-hook "systemctl reload nginx" \
                || die "не выпустился сертификат ни для sslip.io, ни для nip.io. Нужен свой адрес: поддомен с записью A на $PUBLIC_IP, затем --domain"
        else
            die "не выпустился сертификат HTTPS для $DOMAIN. Частая причина — порт 80 закрыт снаружи файрволом хостинга"
        fi
    fi
fi

cat > "$NGINX_CONF" << EOF
# Claude UI — создано deploy/selfhost/install.sh
map \$http_upgrade \$ccui_connection_upgrade {
    default upgrade;
    ''      close;
}

server {
    listen 80;
    server_name $DOMAIN;
    location /.well-known/acme-challenge/ { root /var/www/html; }
    location / { return 301 https://\$host\$request_uri; }
}

server {
    listen 443 ssl http2;
    server_name $DOMAIN;

    ssl_certificate     /etc/letsencrypt/live/$DOMAIN/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/$DOMAIN/privkey.pem;
    ssl_protocols TLSv1.2 TLSv1.3;

    client_max_body_size 100m;

    gzip on;
    gzip_proxied any;
    gzip_comp_level 5;
    gzip_min_length 1024;
    gzip_vary on;
    gzip_types application/javascript text/javascript application/json text/css image/svg+xml application/manifest+json;

    location / {
        proxy_pass http://127.0.0.1:$PORT;
        proxy_http_version 1.1;
        proxy_set_header Host \$host;
        proxy_set_header X-Real-IP \$remote_addr;
        proxy_set_header X-Forwarded-For \$proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto \$scheme;
        proxy_set_header Upgrade \$http_upgrade;
        proxy_set_header Connection \$ccui_connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
EOF
nginx -t 2> /dev/null || die "nginx не принял настройку сайта: nginx -t"
systemctl reload nginx

curl -sf --max-time 15 --resolve "$DOMAIN:443:127.0.0.1" "https://$DOMAIN/api/auth/status" > /dev/null \
    || die "сайт https://$DOMAIN не отвечает через nginx"

# ── 7. Владелец и ссылка входа ───────────────────────────────────────────────

if curl -sf "http://127.0.0.1:$PORT/api/auth/status" | grep -q '"needsSetup":true'; then
    say "Создаю владельца $OWNER_NAME"
    OWNER_PASS="$(head -c 32 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c 16)"
    REG="$(curl -sf -X POST "http://127.0.0.1:$PORT/api/auth/register" -H 'Content-Type: application/json' \
        -d "{\"username\":\"$OWNER_NAME\",\"password\":\"$OWNER_PASS\"}")" || die "не создался владелец"
    JWT="$(printf '%s' "$REG" | python3 -c 'import sys, json; print(json.load(sys.stdin)["token"])')"
    LOGIN_TOKEN="$(curl -sf -X POST "http://127.0.0.1:$PORT/api/auth/regenerate-login-link" \
        -H "Authorization: Bearer $JWT" | python3 -c 'import sys, json; print(json.load(sys.stdin)["loginToken"])')" \
        || die "не выпустилась ссылка входа"
    cat > "$SUMMARY" << EOF
Claude UI установлен $(date '+%d.%m.%Y %H:%M').

Адрес сайта: https://$DOMAIN
Личная ссылка входа владельца (это как пароль — никому не пересылать):
https://$DOMAIN/enter/$LOGIN_TOKEN

Запасной вход на странице сайта: имя $OWNER_NAME, пароль $OWNER_PASS

Служба: $SERVICE (порт $PORT только внутри сервера), настройки: $ENV_FILE
Обновления: ночью сами; итог — bash $APP/current/deploy/selfhost/update.sh --status
EOF
    chown "$RUN_USER:" "$SUMMARY"
    chmod 600 "$SUMMARY"
else
    say "Владелец уже был создан раньше — прежняя ссылка входа в $SUMMARY"
fi

echo
cat "$SUMMARY" 2> /dev/null || true
echo
say "Готово"
