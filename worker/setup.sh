#!/usr/bin/env bash
# Установка автоанализа партий на VPS (Ubuntu/Debian, root).
#   curl -fsSL https://raw.githubusercontent.com/sw3ptop/chess-revizor/main/worker/setup.sh | bash
set -euo pipefail
PLAYER="${PLAYER:-sw3p7}"
DIR=/opt/chess-revizor
KEY=/root/.ssh/chess_revizor_deploy

echo "==> Ставлю git, stockfish и Node.js"
apt-get update -qq
apt-get install -y -qq git stockfish curl ca-certificates >/dev/null
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 18 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null
  apt-get install -y -qq nodejs >/dev/null
fi
SF="$(command -v stockfish || echo /usr/games/stockfish)"
echo "    stockfish: $SF, node: $(node -v)"

echo "==> Ключ для записи в репозиторий"
mkdir -p /root/.ssh && chmod 700 /root/.ssh
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N "" -f "$KEY" -C "chess-scout@$(hostname)"
grep -q "Host github-chess" /root/.ssh/config 2>/dev/null || cat >> /root/.ssh/config <<CFG

Host github-chess
  HostName github.com
  User git
  IdentityFile $KEY
  IdentitiesOnly yes
CFG
ssh-keyscan -q github.com >> /root/.ssh/known_hosts 2>/dev/null || true

if ! ssh -T github-chess 2>&1 | grep -q "successfully authenticated"; then
  echo
  echo "Добавь этот ключ в GitHub:"
  echo "  github.com/sw3ptop/chess-revizor → Settings → Deploy keys → Add deploy key"
  echo "  Title: chess-scout, поставь галочку «Allow write access»"
  echo
  cat "$KEY.pub"
  echo
  read -r -p "Добавил? Нажми Enter… " _ </dev/tty
fi

echo "==> Скачиваю сайт"
if [ -d "$DIR/.git" ]; then git -C "$DIR" pull -q --rebase origin main
else git clone -q git@github-chess:sw3ptop/chess-revizor.git "$DIR"; fi
cd "$DIR/worker" && npm install --omit=dev --silent

echo "==> Сервис и таймер (каждые 15 минут)"
cat > /etc/systemd/system/chess-scout.service <<UNIT
[Unit]
Description=Chess Revizor: анализ новых партий $PLAYER
After=network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$DIR/worker
Environment=PLAYER=$PLAYER
Environment=DEPTH=16
Environment=STOCKFISH=$SF
Environment=THREADS=1
ExecStart=$(command -v node) worker.js
Nice=10
UNIT
cat > /etc/systemd/system/chess-scout.timer <<UNIT
[Unit]
Description=Запуск chess-scout каждые 15 минут

[Timer]
OnBootSec=2min
OnUnitActiveSec=15min
Persistent=true

[Install]
WantedBy=timers.target
UNIT
systemctl daemon-reload
systemctl enable --now chess-scout.timer >/dev/null
systemctl start chess-scout.service || true
echo
echo "Готово. Лог: journalctl -u chess-scout -n 30"
journalctl -u chess-scout -n 15 --no-pager || true
