#!/bin/bash
# AI Observer — Remove Claude Code hooks from global settings

SETTINGS_FILE="$HOME/.claude/settings.json"

if [ ! -f "$SETTINGS_FILE" ]; then
    echo "No settings file found at $SETTINGS_FILE"
    exit 0
fi

python3 -c "
import json
settings = json.load(open('$SETTINGS_FILE'))
if 'hooks' in settings:
    # Remove only hooks that point to AI Observer
    for event in list(settings['hooks'].keys()):
        settings['hooks'][event] = [
            entry for entry in settings['hooks'][event]
            if not any(
                h.get('url', '').startswith('http://localhost:8077')
                for h in entry.get('hooks', [])
            )
        ]
        if not settings['hooks'][event]:
            del settings['hooks'][event]
    if not settings['hooks']:
        del settings['hooks']
json.dump(settings, open('$SETTINGS_FILE', 'w'), indent=2)
print('AI Observer hooks removed from $SETTINGS_FILE')
"
