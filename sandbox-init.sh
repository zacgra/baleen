#!/bin/sh
# Recreate directories wiped by the tmpfs overlay on $HOME
mkdir -p ~/.claude ~/.local/bin ~/.local/share/claude/versions ~/.config ~/.bun/bin

# Restore the symlink structure the native installer expects so Claude Code
# doesn't warn about a missing binary at ~/.local/bin/claude.
if [ -x /usr/local/bin/claude ] && [ ! -e ~/.local/bin/claude ]; then
  ln -s /usr/local/bin/claude ~/.local/bin/claude
fi

# Restore bun symlink so it's available on PATH after tmpfs overlay.
if [ -x /usr/local/bin/bun ] && [ ! -e ~/.bun/bin/bun ]; then
  ln -s /usr/local/bin/bun ~/.bun/bin/bun
fi

# Restore .claude.json from the persisted volume.
# Claude Code backs up this file into ~/.claude/backups/ which lives on the
# persistent volume, so we can always recover from the latest backup.
if [ ! -f ~/.claude.json ]; then
  if [ -s ~/.claude/.claude.json.persist ]; then
    cp ~/.claude/.claude.json.persist ~/.claude.json
  else
    backup=$(ls -t ~/.claude/backups/.claude.json.backup.* 2>/dev/null | head -1)
    if [ -n "$backup" ]; then
      cp "$backup" ~/.claude.json
    fi
  fi
fi

# Persist .claude.json on exit (including SIGTERM from docker rm -f)
save_config() {
  if [ -f "$HOME/.claude.json" ]; then
    cp "$HOME/.claude.json" "$HOME/.claude/.claude.json.persist"
  fi
}
trap save_config EXIT

# Write statusLine config to user-level settings (project-level doesn't support it)
if [ -f /sandbox/statusline.sh ]; then
  USER_SETTINGS="$HOME/.claude/settings.json"
  if [ -f "$USER_SETTINGS" ]; then
    # Merge statusLine into existing settings
    jq '. + {"statusLine":{"type":"command","command":"/sandbox/statusline.sh"}}' \
      "$USER_SETTINGS" > "$USER_SETTINGS.tmp" && mv "$USER_SETTINGS.tmp" "$USER_SETTINGS"
  else
    printf '{"statusLine":{"type":"command","command":"/sandbox/statusline.sh"}}\n' > "$USER_SETTINGS"
  fi
fi

# Configure gh/git auth if a PAT is provided via GH_TOKEN
if [ -n "$GH_TOKEN" ] && command -v gh >/dev/null 2>&1; then
  gh auth setup-git
fi

# Launch Claude Code — Ctrl+C or /exit drops back to bash
claude
bash
