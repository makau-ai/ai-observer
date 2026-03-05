"""
AI Observer — Standalone AI Observability Dashboard.

Visualizes external AI system activity (Claude Code, Codex, Gemini, etc.)
on a D3 force-directed graph with timeline replay and particle animations.

Run: uvicorn main:app --port 8077
"""

from __future__ import annotations

from collections import defaultdict
from pathlib import Path
from typing import Any

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles

from flow_tracker import FlowTracker

app = FastAPI(title="AI Observer", version="1.0.0")
tracker = FlowTracker()

STATIC_DIR = Path(__file__).parent / "static"
if STATIC_DIR.exists():
    app.mount("/static", StaticFiles(directory=str(STATIC_DIR)), name="static")


@app.get("/", response_class=HTMLResponse)
async def index():
    html_path = STATIC_DIR / "index.html"
    if html_path.exists():
        return HTMLResponse(html_path.read_text())
    return HTMLResponse("<h1>AI Observer</h1><p>static/index.html not found</p>")


# ── Ingest endpoint ──────────────────────────────────────────────────

@app.post("/api/hooks/ingest")
async def ingest_hook(request: Request):
    """Ingest events from external AI systems into the flow tracker."""
    body = await request.json()

    source_system = body.get("source_system", "unknown")
    event_type = body.get("event_type", "unknown")
    agent_id = body.get("agent_id", "main")
    agent_name = body.get("agent_name", source_system.replace("-", " ").title())
    parent_id = body.get("parent_agent_id")

    def ext_node(aid: str, aname: str | None = None) -> str:
        label = aname or aid
        return f"EXT:{source_system}:{label}"

    EVENT_MAP: dict[str, tuple[str, str, str, str]] = {
        "session_start": (
            "\U0001f464 User", ext_node(agent_id, agent_name),
            "user_request", f"{agent_name} session started",
        ),
        "prompt": (
            "\U0001f464 User", ext_node(agent_id, agent_name),
            "user_request", body.get("summary", "User prompt"),
        ),
        "tool_call": (
            ext_node(agent_id, agent_name),
            f"\U0001f527 {body.get('tool_name', 'Unknown')}",
            "tool_call", body.get("summary", f"Tool: {body.get('tool_name', '?')}"),
        ),
        "llm_call": (
            ext_node(agent_id, agent_name),
            f"\U0001f9e0 {body.get('model', 'unknown')}",
            "llm_call", body.get("summary", f"LLM: {body.get('model', '?')}"),
        ),
        "subagent_start": (
            ext_node(parent_id or "main"),
            ext_node(agent_id, agent_name),
            "task_delegation", f"Spawned: {agent_name or agent_id}",
        ),
        "subagent_stop": (
            ext_node(agent_id, agent_name),
            ext_node(parent_id or "main"),
            "task_delegation", body.get("summary", f"Completed: {agent_id}"),
        ),
        "session_stop": (
            ext_node(agent_id, agent_name), "\U0001f464 User",
            "session_end", body.get("summary", f"{agent_name} session ended"),
        ),
        "error": (
            ext_node(agent_id, agent_name), "\U0001f464 User",
            "error", body.get("summary", "Error occurred"),
        ),
    }

    mapping = EVENT_MAP.get(event_type)
    if not mapping:
        return {"status": "ignored", "reason": f"Unknown event_type: {event_type}"}

    src, tgt, conv_type, summary = mapping

    tracker.record(
        source=src,
        target=tgt,
        conversation_type=conv_type,
        summary=summary,
        tokens=body.get("input_tokens", 0) + body.get("output_tokens", 0),
        cost_usd=body.get("cost_usd", 0.0),
        model=body.get("model", ""),
        provider=source_system,
    )

    return {"status": "recorded", "source": src, "target": tgt, "type": conv_type}


# ── Claude Code native hook endpoint ─────────────────────────────────

@app.post("/api/hooks/claude-code")
async def claude_code_hook(request: Request):
    """
    Accepts Claude Code's native hook event format (HTTP hook type).

    Claude Code HTTP hooks POST the event data directly as JSON with fields
    like hook_event_name, tool_name, agent_id, agent_type, session_id, etc.
    This endpoint translates that into our flow tracker format.
    """
    body = await request.json()

    event_name = body.get("hook_event_name", "")
    session_id = body.get("session_id", "")
    tool_name = body.get("tool_name", "")
    agent_id = body.get("agent_id", "")
    agent_type = body.get("agent_type", "")

    def cc_node(aid: str = "main", atype: str = "") -> str:
        label = atype or aid or "Claude Code"
        return f"EXT:claude-code:{label}"

    # Map Claude Code hook events to flow records
    src, tgt, conv_type, summary = "", "", "", ""

    if event_name == "SessionStart":
        src, tgt = "\U0001f464 User", cc_node()
        conv_type, summary = "user_request", "Claude Code session started"

    elif event_name == "UserPromptSubmit":
        prompt_preview = (body.get("prompt", "") or "")[:120]
        src, tgt = "\U0001f464 User", cc_node()
        conv_type = "user_request"
        summary = f"Prompt: {prompt_preview}" if prompt_preview else "User prompt"

    elif event_name == "PostToolUse":
        src, tgt = cc_node(agent_id, agent_type) if agent_id else cc_node(), f"\U0001f527 {tool_name or 'Unknown'}"
        conv_type = "tool_call"
        summary = f"Tool: {tool_name}"

    elif event_name == "PostToolUseFailure":
        src, tgt = cc_node(agent_id, agent_type) if agent_id else cc_node(), f"\U0001f527 {tool_name or 'Unknown'}"
        conv_type = "error"
        error_msg = (body.get("error", "") or "")[:100]
        summary = f"Tool failed: {tool_name} — {error_msg}" if error_msg else f"Tool failed: {tool_name}"

    elif event_name == "SubagentStart":
        parent = cc_node()
        child = cc_node(agent_id, agent_type)
        src, tgt = parent, child
        conv_type = "task_delegation"
        summary = f"Spawned {agent_type or 'subagent'}: {agent_id}"

    elif event_name == "SubagentStop":
        child = cc_node(agent_id, agent_type)
        parent = cc_node()
        src, tgt = child, parent
        conv_type = "task_delegation"
        summary = f"Completed {agent_type or 'subagent'}: {agent_id}"

    elif event_name == "Stop":
        src, tgt = cc_node(), "\U0001f464 User"
        conv_type = "session_end"
        summary = "Claude Code response complete"

    elif event_name == "SessionEnd":
        src, tgt = cc_node(), "\U0001f464 User"
        conv_type = "session_end"
        summary = f"Session ended: {body.get('reason', 'unknown')}"

    else:
        return {"status": "ignored", "event": event_name}

    if src and tgt:
        tracker.record(
            source=src,
            target=tgt,
            conversation_type=conv_type,
            summary=summary,
            provider="claude-code",
        )

    return {"status": "recorded", "event": event_name, "source": src, "target": tgt}


# ── Read endpoints ───────────────────────────────────────────────────

def _get_entity_type(node_id: str) -> str:
    if node_id.startswith("EXT:"):
        return "external_ai"
    if node_id.startswith("\U0001f9e0") or node_id.startswith("model:"):
        return "model"
    if node_id.startswith("\U0001f527") or node_id.startswith("tool:"):
        return "tool"
    if node_id.startswith("\U0001f464") or node_id.startswith("user:"):
        return "user"
    return "external_ai"


@app.get("/api/graph")
async def get_graph():
    """Node + edge data for D3 force graph."""
    data = tracker.get_interaction_matrix()
    nodes_raw = data["nodes"]
    matrix = data["matrix"]

    # Build node list
    nodes = []
    for node_id, counts in nodes_raw.items():
        nodes.append({
            "id": node_id,
            "type": _get_entity_type(node_id),
            "messages_sent": counts["sent"],
            "messages_received": counts["received"],
        })

    # Build edge list with flow type enrichment
    edges = []
    recent = tracker.recent_flows(limit=200)
    flow_index: dict[str, list[dict]] = defaultdict(list)
    for f in recent:
        key = f"{f.source}->{f.target}"
        flow_index[key].append(f.to_dict())

    for src, targets in matrix.items():
        for tgt, count in targets.items():
            key = f"{src}->{tgt}"
            flows_for_edge = flow_index.get(key, [])
            types = list({f["conversation_type"] for f in flows_for_edge})
            recent_summary = flows_for_edge[0]["summary"] if flows_for_edge else ""
            edges.append({
                "source": src,
                "target": tgt,
                "count": count,
                "types": types,
                "recent_summary": recent_summary,
            })

    return {
        "nodes": nodes,
        "edges": edges,
        "total_events": data["total"],
    }


@app.get("/api/timeline")
async def get_timeline():
    """Chronological flow list for timeline replay."""
    timeline = tracker.get_timeline()
    return {"timeline": [f.to_dict() for f in timeline]}


@app.get("/api/stats")
async def get_stats():
    """Aggregate statistics."""
    return tracker.get_stats()


@app.get("/api/flows")
async def get_flows():
    """All flow records (raw)."""
    with tracker._lock:
        return {"flows": [f.to_dict() for f in tracker._flows.values()]}


@app.post("/api/clear")
async def clear_flows():
    """Clear all flow data."""
    tracker.clear()
    return {"status": "cleared"}
