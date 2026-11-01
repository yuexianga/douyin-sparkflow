#!/usr/bin/env bash
set -euo pipefail

cd /app
mkdir -p /app/state/browser-profiles /app/state/login-profile /app/logs /run/login-api
mkdir -p /host-spool-cron
touch /host-spool-cron/root

export DISPLAY=:99
export PLAYWRIGHT_BROWSERS_PATH=/ms-playwright
export LOGIN_DESKTOP_MODE=novnc
export SPARKFLOW_LOGIN_DESKTOP_MODE=novnc
export LOGIN_DESKTOP_API_PORT=18090
export LOGIN_DESKTOP_WEB_PORT=6080
export LOGIN_PROFILE_DIR=/app/state/login-profile
export LOGIN_DESKTOP_PROXY_MODE=direct
export SPARKFLOW_BROWSER_PROFILE_ROOT=/app/state/browser-profiles
export SPARKFLOW_LOGIN_DESKTOP_API_URL=http://127.0.0.1:18090
export SPARKFLOW_LOGIN_DESKTOP_NOVNC_URL=http://127.0.0.1:6080
export SPARKFLOW_LOGIN_DESKTOP_NOVNC_WS_URL=ws://127.0.0.1:6080/websockify
export SPARKFLOW_LOGIN_DESKTOP_API_TOKEN_FILE=/run/login-api/token
export SPARKFLOW_SESSION_COOKIE_SECURE=1

bash /app/scripts/start_login_desktop.sh &
desktop_pid=$!
python /app/scripts/cron_runner.py /host-spool-cron/root &
cron_pid=$!
python /app/main.py --web --host 0.0.0.0 --port 8787 &
web_pid=$!

shutdown() {
	local exit_status=$?
	trap - EXIT TERM INT

	kill -TERM "$web_pid" "$cron_pid" 2>/dev/null || true
	local deadline=$((SECONDS + 780))
	while [ -e /app/logs/task.run.lock ] && [ "$SECONDS" -lt "$deadline" ]; do
		sleep 2
	done
	kill -TERM "$desktop_pid" 2>/dev/null || true
	wait "$web_pid" 2>/dev/null || true
	wait "$cron_pid" 2>/dev/null || true
	wait "$desktop_pid" 2>/dev/null || true

	if [ -n "${SPARKFLOW_CF_CHECKPOINT_URL:-}" ] && [ -n "${SPARKFLOW_CF_CHECKPOINT_TOKEN:-}" ]; then
		curl --fail --silent --show-error --retry 3 --retry-all-errors \
			--retry-delay 2 --connect-timeout 5 --max-time 30 \
			-H "Authorization: Bearer ${SPARKFLOW_CF_CHECKPOINT_TOKEN}" \
			-X POST "${SPARKFLOW_CF_CHECKPOINT_URL}" \
			|| echo "Cloudflare filesystem checkpoint failed; latest changes may not be saved" >&2
	fi

	return "$exit_status"
}

trap shutdown EXIT
trap 'exit 143' TERM
trap 'exit 130' INT

set +e
wait -n "$desktop_pid" "$cron_pid" "$web_pid"
status=$?
exit "$status"
