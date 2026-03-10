#!/bin/sh
# Claude Code statusline script.
# Receives JSON on stdin after each assistant message.
# Writes the full JSON to a per-window file for the hub to read,
# and outputs a formatted one-liner to stdout for Claude's own display.

INPUT=$(cat)

# Write status file if running inside a devbox work session
if [ -n "$DEVBOX_WORKSESSION" ]; then
  printf '%s' "$INPUT" > "/tmp/devbox-status-${DEVBOX_WORKSESSION}.json" 2>/dev/null
fi

# Output a formatted one-liner for Claude Code's status display
MODEL=$(printf '%s' "$INPUT" | jq -r '.model.display_name // empty' 2>/dev/null)
COST=$(printf '%s' "$INPUT" | jq -r '.cost.total_cost_usd // empty' 2>/dev/null)
CTX=$(printf '%s' "$INPUT" | jq -r '.context_window.used_percentage // 0' 2>/dev/null)

# ── Quota: fetch from API with 5-minute cache ──────────────────
CACHE_FILE="/tmp/devbox-usage-cache.json"
CACHE_TTL=300  # seconds

fetch_usage() {
  CREDS_FILE="$HOME/.claude/.credentials.json"
  [ -f "$CREDS_FILE" ] || return
  TOKEN=$(jq -r '.claudeAiOauth.accessToken // empty' "$CREDS_FILE" 2>/dev/null)
  [ -n "$TOKEN" ] || return
  curl -s --max-time 5 \
    -X GET "https://api.anthropic.com/api/oauth/usage" \
    -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" \
    -H "anthropic-beta: oauth-2025-04-20" \
    -H "Accept: application/json" \
    2>/dev/null > "$CACHE_FILE.tmp" \
    && jq -e '.five_hour' "$CACHE_FILE.tmp" >/dev/null 2>&1 \
    && mv "$CACHE_FILE.tmp" "$CACHE_FILE" \
    || rm -f "$CACHE_FILE.tmp"
}

USAGE=""
if [ -f "$CACHE_FILE" ]; then
  CACHE_AGE=$(( $(date +%s) - $(date -r "$CACHE_FILE" +%s 2>/dev/null || stat -c %Y "$CACHE_FILE" 2>/dev/null || echo 0) ))
  if [ "$CACHE_AGE" -ge "$CACHE_TTL" ]; then
    fetch_usage
  fi
else
  fetch_usage
fi

QUOTA_5H=""
QUOTA_7D=""
TIME_PCT_5H=""
TIME_PCT_7D=""
RESET_LOCAL_5H=""
RESET_LOCAL_7D=""
if [ -f "$CACHE_FILE" ]; then
  FIVE_HR=$(jq -r '.five_hour.utilization // empty' "$CACHE_FILE" 2>/dev/null)
  SEVEN_DAY=$(jq -r '.seven_day.utilization // empty' "$CACHE_FILE" 2>/dev/null)
  [ -n "$FIVE_HR" ] && QUOTA_5H=$(printf '%.0f' "$FIVE_HR")
  [ -n "$SEVEN_DAY" ] && QUOTA_7D=$(printf '%.0f' "$SEVEN_DAY")

  # Compute elapsed percentage and reset time from resets_at
  NOW=$(date +%s)
  RESET_5H=$(jq -r '.five_hour.resets_at // empty' "$CACHE_FILE" 2>/dev/null)
  RESET_7D=$(jq -r '.seven_day.resets_at // empty' "$CACHE_FILE" 2>/dev/null)
  if [ -n "$RESET_5H" ]; then
    RESET_5H_TS=$(date -d "$RESET_5H" +%s 2>/dev/null)
    if [ -n "$RESET_5H_TS" ]; then
      REMAINING=$(( RESET_5H_TS - NOW ))
      [ "$REMAINING" -lt 0 ] && REMAINING=0
      ELAPSED=$(( 18000 - REMAINING ))
      TIME_PCT_5H=$(( ELAPSED * 100 / 18000 ))
      REM_H=$(( REMAINING / 3600 ))
      REM_M=$(( (REMAINING % 3600) / 60 ))
      RESET_LOCAL_5H=$(printf '%dh%02dm' "$REM_H" "$REM_M")
    fi
  fi
  if [ -n "$RESET_7D" ]; then
    RESET_7D_TS=$(date -d "$RESET_7D" +%s 2>/dev/null)
    if [ -n "$RESET_7D_TS" ]; then
      REMAINING=$(( RESET_7D_TS - NOW ))
      [ "$REMAINING" -lt 0 ] && REMAINING=0
      ELAPSED=$(( 604800 - REMAINING ))
      TIME_PCT_7D=$(( ELAPSED * 100 / 604800 ))
      REM_D=$(( REMAINING / 86400 ))
      REM_H=$(( (REMAINING % 86400) / 3600 ))
      RESET_LOCAL_7D=$(printf '%dd%dh' "$REM_D" "$REM_H")
    fi
  fi
fi

# ── Colors ──────────────────────────────────────────────────────
DIM='\033[2m'
BOLD='\033[1m'
GREEN='\033[38;2;100;180;80m'
RESET='\033[0m'

# Muted gradient from green to red. Uses 24-bit true color.
# Channels range from 80–190 to avoid harsh neon tones.
# Usage: $(gradient VALUE MAX)
gradient() {
  val=$1 max=$2
  [ "$val" -gt "$max" ] 2>/dev/null && val=$max
  [ "$val" -lt 0 ] 2>/dev/null && val=0
  scaled=$(( val * 100 / max ))
  if [ "$scaled" -le 50 ]; then
    r=$(( 80 + scaled * 110 / 50 ))
    g=190
  else
    r=190
    g=$(( 80 + (100 - scaled) * 110 / 50 ))
  fi
  printf '\033[38;2;%d;%d;60m' "$r" "$g"
}

# Mini progress bar: filled portion colored by usage, unfilled dim.
# Usage: $(progress_bar TIME_PCT USAGE_PCT WIDTH)
progress_bar() {
  usage_pct=$1 width=$2
  filled=$(( usage_pct * width / 100 ))
  [ "$filled" -gt "$width" ] && filled=$width
  [ "$filled" -lt 0 ] && filled=0
  [ "$usage_pct" -gt 0 ] 2>/dev/null && [ "$filled" -lt 1 ] && filled=1
  empty=$(( width - filled ))
  usage_color=$(gradient "$usage_pct" 100)
  bar="${usage_color}"
  i=0; while [ "$i" -lt "$filled" ]; do bar="${bar}█"; i=$((i+1)); done
  bar="${bar}${DIM}"
  i=0; while [ "$i" -lt "$empty" ]; do bar="${bar}░"; i=$((i+1)); done
  bar="${bar}${RESET}"
  printf '%b' "$bar"
}

# ── Assemble output ────────────────────────────────────────────
SEP="  ${DIM}│${RESET}  "

# Model
OUT=""
[ -n "$MODEL" ] && OUT="${BOLD}${MODEL}${RESET}"

# Session cost
if [ -n "$COST" ]; then
  COST=$(printf '%.2f' "$COST")
  OUT="${OUT}${SEP}${DIM}session${RESET} ${GREEN}\$${COST}${RESET}"
fi

# Context window
CTX_INT=${CTX%.*}
CTX_COLOR=$(gradient "$CTX_INT" 40)
OUT="${OUT}${SEP}${DIM}context${RESET} ${CTX_COLOR}${CTX_INT}%${RESET}"

# Quota usage
if [ -n "$QUOTA_5H" ]; then
  Q5_COLOR=$(gradient "$QUOTA_5H" 100)
  Q7_COLOR=$(gradient "$QUOTA_7D" 100)
  BAR_W=10
  BAR5=$(progress_bar "$QUOTA_5H" "$BAR_W")
  BAR7=$(progress_bar "$QUOTA_7D" "$BAR_W")
  RESET_5H_LABEL=""
  RESET_7D_LABEL=""
  [ -n "$RESET_LOCAL_5H" ] && RESET_5H_LABEL=" ${DIM}↻${RESET_LOCAL_5H}${RESET}"
  [ -n "$RESET_LOCAL_7D" ] && RESET_7D_LABEL=" ${DIM}↻${RESET_LOCAL_7D}${RESET}"
  OUT="${OUT}${SEP}${DIM}usage${RESET}  ${DIM}[${RESET}${DIM}5h${RESET} ${BAR5} ${Q5_COLOR}${QUOTA_5H}%${RESET}${RESET_5H_LABEL}${DIM}]${RESET}  ${DIM}[${RESET}${DIM}7d${RESET} ${BAR7} ${Q7_COLOR}${QUOTA_7D}%${RESET}${RESET_7D_LABEL}${DIM}]${RESET}"
fi

printf '%b\n' "$OUT"

# Ring terminal bell so the terminal/VS Code tab highlights when Claude is waiting.
# The statusline subprocess has no controlling terminal, so /dev/tty won't work.
# Write directly to the container's PTY instead.
if [ -w /dev/pts/0 ]; then
  printf '\a' > /dev/pts/0
elif [ -w /dev/tty ]; then
  printf '\a' > /dev/tty
fi
