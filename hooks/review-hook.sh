#!/usr/bin/env bash
# PreToolUse hook for Claude Code — intercepts Edit/Write before they're applied.
# Writes the full proposal (including tool_input with edit content) to pending/,
# polls for the extension's response, then outputs structured JSON to allow or deny.

set -euo pipefail

REVIEW_DIR="${CLAUDE_REVIEW_DIR:-/sandbox/.claude-review}"
PENDING_DIR="$REVIEW_DIR/pending"
RESPONSE_DIR="$REVIEW_DIR/responses"

INPUT=$(cat)

TOOL_USE_ID=$(echo "$INPUT" | jq -r '.tool_use_id // empty')
if [ -z "$TOOL_USE_ID" ]; then
  TOOL_USE_ID="review-$(date +%s%N)"
fi

mkdir -p "$PENDING_DIR" "$RESPONSE_DIR"

# Write full proposal — extension needs tool_input to construct the diff preview
echo "$INPUT" > "$PENDING_DIR/$TOOL_USE_ID.json"

# Poll for response (100ms intervals, 5 minute timeout)
TIMEOUT=3000
COUNTER=0

while [ $COUNTER -lt $TIMEOUT ]; do
  RESPONSE_FILE="$RESPONSE_DIR/$TOOL_USE_ID.json"
  if [ -f "$RESPONSE_FILE" ]; then
    ACTION=$(jq -r '.action' "$RESPONSE_FILE")
    FEEDBACK=$(jq -r '.feedback // empty' "$RESPONSE_FILE")

    rm -f "$PENDING_DIR/$TOOL_USE_ID.json" "$RESPONSE_FILE"

    if [ "$ACTION" = "approve" ]; then
      # Output structured JSON to allow the tool call
      jq -n '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "allow"}}'
      exit 0
    else
      # Output structured JSON to deny with feedback
      jq -n \
        --arg reason "${FEEDBACK:-Change denied by reviewer.}" \
        '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: $reason}}'
      exit 0
    fi
  fi

  sleep 0.1
  COUNTER=$((COUNTER + 1))
done

# Timeout — deny
rm -f "$PENDING_DIR/$TOOL_USE_ID.json"
jq -n '{hookSpecificOutput: {hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "Review timed out after 5 minutes."}}'
exit 0
