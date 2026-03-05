#!/bin/bash
# AI Observer — Install Claude Code hooks globally
# This installs HTTP hooks at ~/.claude/settings.json so ALL Claude Code
# projects automatically report to AI Observer (when the server is running).

set -e

SETTINGS_FILE="$HOME/.claude/settings.json"
OBSERVER_URL="${AI_OBSERVER_URL:-http://localhost:8077}"
HOOK_URL="$OBSERVER_URL/api/hooks/claude-code"

HOOKS_JSON=$(cat <<ENDJSON
{
  "hooks": {
    "SessionStart": [{"hooks": [{"type": "http", "url": "$HOOK_URL", "timeout": 5}]}],
    "UserPromptSubmit": [{"hooks": [{"type": "http", "url": "$HOOK_URL", "timeout": 5}]}],
    "PostToolUse": [{"hooks": [{"type": "http", "url": "$HOOK_URL", "timeout": 5}]}],
    "PostToolUseFailure": [{"hooks": [{"type": "http", "url": "$HOOK_URL", "timeout": 5}]}],
    "SubagentStart": [{"hooks": [{"type": "http", "url": "$HOOK_URL", "timeout": 5}]}],
    "SubagentStop": [{"hooks": [{"type": "http", "url": "$HOOK_URL", "timeout": 5}]}],
    "Stop": [{"hooks": [{"type": "http", "url": "$HOOK_URL", "timeout": 5}]}],
    "SessionEnd": [{"hooks": [{"type": "http", "url": "$HOOK_URL", "timeout": 5}]}]
  }
}
ENDJSON
)

mkdir -p "$HOME/.claude"

if [ -f "$SETTINGS_FILE" ]; then
    # Merge hooks into existing settings using Python
    python3 -c "
import json, sys
existing = json.load(open('$SETTINGS_FILE'))
new_hooks = json.loads('''$HOOKS_JSON''')
existing.setdefault('hooks', {}).update(new_hooks['hooks'])
json.dump(existing, open('$SETTINGS_FILE', 'w'), indent=2)
print('Merged AI Observer hooks into existing $SETTINGS_FILE')
"
else
    echo "$HOOKS_JSON" > "$SETTINGS_FILE"
    echo "Created $SETTINGS_FILE with AI Observer hooks"
fi

echo ""
echo "AI Observer hooks installed globally."
echo "All Claude Code sessions will report to $OBSERVER_URL"
echo ""
echo "Start the server:  cd $(dirname "$0") && uvicorn main:app --port 8077"
echo "Open dashboard:    $OBSERVER_URL"
echo "Uninstall:         $(dirname "$0")/uninstall.sh"
