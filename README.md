# AI Observer

Real-time observability dashboard for AI coding assistants. Visualizes Claude Code sessions, tool calls, subagent spawns, and model interactions on a D3 force-directed graph with timeline replay and particle animations.

## Quick Start

```bash
pip install fastapi uvicorn
uvicorn main:app --port 8077
```

Open http://localhost:8077

## Architecture

```
ai_observer/
├── main.py              # FastAPI backend (ingest + API + static)
├── flow_tracker.py      # In-memory flow records
├── static/
│   ├── index.html       # Dashboard shell
│   ├── app.js           # D3 force graph + timeline + particles
│   └── style.css        # Dark theme
├── .claude/
│   └── settings.json    # Claude Code hook configuration
└── requirements.txt
```

## Integrating with Claude Code

Copy `.claude/settings.json` to your project's `.claude/` directory (or merge with existing settings). Claude Code will automatically POST lifecycle events to the observer.

Events captured:
- **SessionStart / SessionEnd** — session lifecycle
- **UserPromptSubmit** — user prompts
- **PostToolUse / PostToolUseFailure** — tool calls (Bash, Read, Write, Edit, etc.)
- **SubagentStart / SubagentStop** — subagent spawns (Explore, Plan, etc.)
- **Stop** — response completion

## Generic Ingest API

Any system can POST events to `POST /api/hooks/ingest`:

```bash
curl -X POST http://localhost:8077/api/hooks/ingest \
  -H 'Content-Type: application/json' \
  -d '{
    "source_system": "codex",
    "event_type": "tool_call",
    "agent_id": "main",
    "agent_name": "Codex",
    "tool_name": "execute",
    "summary": "Ran: npm test"
  }'
```

### Event Types

| event_type | description |
|---|---|
| `session_start` | AI session begins |
| `prompt` | User submits a prompt |
| `tool_call` | AI calls a tool |
| `llm_call` | AI makes an LLM API call |
| `subagent_start` | AI spawns a subagent |
| `subagent_stop` | Subagent completes |
| `session_stop` | Session ends |
| `error` | Error occurred |

## API Endpoints

| Endpoint | Method | Description |
|---|---|---|
| `/api/hooks/ingest` | POST | Generic event ingestion |
| `/api/hooks/claude-code` | POST | Claude Code native hook format |
| `/api/graph` | GET | Node + edge data for D3 |
| `/api/timeline` | GET | Chronological flow list |
| `/api/stats` | GET | Aggregate statistics |
| `/api/flows` | GET | Raw flow records |
| `/api/clear` | POST | Clear all data |

## Visualization

- **Amber octagons** — external AI agents (Claude Code, subagents)
- **Pink diamonds** — LLM models
- **Gray rectangles** — tools (Bash, Read, Write, etc.)
- **Cyan shields** — human users
- **Animated particles** — flow along edges proportional to traffic
- **Timeline sidebar** — chronological event list with replay

## License

MIT
