"""
Flow Tracker — records agent/tool/model interactions as flow records.

Tracks source->target interactions with conversation type, tokens, cost, timing.
All records are tagged with project (folder name) and session_id for filtering.
"""

from __future__ import annotations

import uuid
import time
import threading
from collections import defaultdict
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any


@dataclass
class Event:
    """Single individual event (never merged)."""
    event_id: str
    seq: int                   # global sequence number
    source: str
    target: str
    conversation_type: str
    summary: str
    timestamp: float
    project: str = ""
    session_id: str = ""
    tokens: int = 0
    cost_usd: float = 0.0
    provider: str = ""
    model: str = ""

    def to_dict(self) -> dict[str, Any]:
        return {
            "event_id": self.event_id,
            "seq": self.seq,
            "source": self.source,
            "target": self.target,
            "conversation_type": self.conversation_type,
            "summary": self.summary,
            "timestamp": datetime.fromtimestamp(self.timestamp, tz=timezone.utc).isoformat() if self.timestamp else "",
            "timestamp_unix": self.timestamp,
            "project": self.project,
            "session_id": self.session_id,
            "tokens": self.tokens,
            "cost_usd": round(self.cost_usd, 6),
            "provider": self.provider,
            "model": self.model,
        }


@dataclass
class FlowRecord:
    """Aggregated source->target interaction flow."""
    flow_id: str
    source: str
    target: str
    conversation_type: str

    project: str = ""          # folder name (e.g. "cowork_vis", "ai_observer")
    session_id: str = ""       # Claude Code session id

    message_count: int = 0
    tokens_used: int = 0
    cost_usd: float = 0.0
    provider: str = ""
    model: str = ""

    start_time: float = 0.0
    end_time: float = 0.0
    summary: str = ""
    outcome: str = "open"

    @property
    def duration_ms(self) -> float:
        if self.end_time and self.start_time:
            return (self.end_time - self.start_time) * 1000
        return 0.0

    def to_dict(self) -> dict[str, Any]:
        return {
            "flow_id": self.flow_id,
            "source": self.source,
            "target": self.target,
            "conversation_type": self.conversation_type,
            "project": self.project,
            "session_id": self.session_id,
            "message_count": self.message_count,
            "tokens_used": self.tokens_used,
            "cost_usd": round(self.cost_usd, 6),
            "provider": self.provider,
            "model": self.model,
            "start_time": datetime.fromtimestamp(self.start_time, tz=timezone.utc).isoformat() if self.start_time else "",
            "end_time": datetime.fromtimestamp(self.end_time, tz=timezone.utc).isoformat() if self.end_time else "",
            "duration_ms": round(self.duration_ms, 1),
            "summary": self.summary,
            "outcome": self.outcome,
        }


class FlowTracker:
    """
    In-memory flow tracker with project/session scoping.
    All query methods accept optional project= and session_id= filters.
    """

    def __init__(self) -> None:
        self._flows: dict[str, FlowRecord] = {}
        self._active_flows: dict[tuple, str] = {}  # (src, tgt, type, project, session) -> flow_id
        self._events: list[Event] = []              # every individual event, never merged
        self._event_seq: int = 0                    # monotonic sequence counter
        self._lock = threading.Lock()

    def _filter(self, project: str = "", session_id: str = "") -> list[FlowRecord]:
        """Return flows matching the given filters (empty string = no filter)."""
        result = list(self._flows.values())
        if project:
            result = [f for f in result if f.project == project]
        if session_id:
            result = [f for f in result if f.session_id == session_id]
        return result

    def record(
        self,
        source: str,
        target: str,
        conversation_type: str,
        summary: str = "",
        tokens: int = 0,
        cost_usd: float = 0.0,
        provider: str = "",
        model: str = "",
        project: str = "",
        session_id: str = "",
    ) -> FlowRecord:
        """Record an interaction, creating or updating a flow."""
        key = (source, target, conversation_type, project, session_id)
        now = time.time()

        with self._lock:
            # Always store individual event (never merged)
            self._event_seq += 1
            event = Event(
                event_id=f"EVT-{uuid.uuid4().hex[:8]}",
                seq=self._event_seq,
                source=source,
                target=target,
                conversation_type=conversation_type,
                summary=summary,
                timestamp=now,
                project=project,
                session_id=session_id,
                tokens=tokens,
                cost_usd=cost_usd,
                provider=provider,
                model=model,
            )
            self._events.append(event)

            # Also maintain aggregated flows for graph
            if key in self._active_flows:
                flow = self._flows[self._active_flows[key]]
                flow.message_count += 1
                flow.tokens_used += tokens
                flow.cost_usd += cost_usd
                flow.end_time = now
                if summary:
                    flow.summary = summary
                if provider:
                    flow.provider = provider
                if model:
                    flow.model = model
            else:
                flow = FlowRecord(
                    flow_id=f"FLOW-{uuid.uuid4().hex[:8]}",
                    source=source,
                    target=target,
                    conversation_type=conversation_type,
                    project=project,
                    session_id=session_id,
                    message_count=1,
                    tokens_used=tokens,
                    cost_usd=cost_usd,
                    provider=provider,
                    model=model,
                    start_time=now,
                    end_time=now,
                    summary=summary,
                    outcome="open",
                )
                self._flows[flow.flow_id] = flow
                self._active_flows[key] = flow.flow_id

        return flow

    def _filter_events(self, project: str = "", session_id: str = "", since_seq: int = 0) -> list[Event]:
        """Return events matching filters, optionally only those after a sequence number."""
        result = self._events
        if since_seq > 0:
            result = [e for e in result if e.seq > since_seq]
        if project:
            result = [e for e in result if e.project == project]
        if session_id:
            result = [e for e in result if e.session_id == session_id]
        return result

    def get_events(self, project: str = "", session_id: str = "", since_seq: int = 0, limit: int = 0) -> list[Event]:
        """Return individual events (never merged), sorted by timestamp."""
        with self._lock:
            events = self._filter_events(project, session_id, since_seq)
            events.sort(key=lambda e: e.timestamp)
            if limit > 0:
                events = events[:limit]
            return events

    def get_event_count(self, project: str = "", session_id: str = "") -> int:
        """Return total number of individual events."""
        with self._lock:
            return len(self._filter_events(project, session_id))

    def get_interaction_matrix(self, project: str = "", session_id: str = "") -> dict[str, Any]:
        """Build NxN interaction matrix + node list."""
        nodes: dict[str, dict[str, int]] = defaultdict(lambda: {"sent": 0, "received": 0})
        matrix: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        total = 0

        with self._lock:
            for flow in self._filter(project, session_id):
                count = flow.message_count
                matrix[flow.source][flow.target] += count
                nodes[flow.source]["sent"] += count
                nodes[flow.target]["received"] += count
                total += count

        return {
            "nodes": dict(nodes),
            "matrix": {src: dict(targets) for src, targets in matrix.items()},
            "total": total,
        }

    def get_timeline(self, project: str = "", session_id: str = "") -> list[FlowRecord]:
        """Return flows sorted by start_time (chronological)."""
        with self._lock:
            return sorted(self._filter(project, session_id), key=lambda f: f.start_time)

    def recent_flows(self, limit: int = 50, project: str = "", session_id: str = "") -> list[FlowRecord]:
        """Return most recent flows sorted by end_time (newest first)."""
        with self._lock:
            flows = sorted(self._filter(project, session_id), key=lambda f: f.end_time, reverse=True)
            return flows[:limit]

    def get_stats(self, project: str = "", session_id: str = "") -> dict[str, Any]:
        """Aggregate statistics."""
        with self._lock:
            flows = self._filter(project, session_id)
            total_events = sum(f.message_count for f in flows)
            total_tokens = sum(f.tokens_used for f in flows)
            total_cost = sum(f.cost_usd for f in flows)
            total_flows = len(flows)

            by_type: dict[str, int] = defaultdict(int)
            by_provider: dict[str, int] = defaultdict(int)
            for f in flows:
                by_type[f.conversation_type] += f.message_count
                if f.provider:
                    by_provider[f.provider] += f.message_count

            return {
                "total_events": total_events,
                "total_flows": total_flows,
                "total_tokens": total_tokens,
                "total_cost_usd": round(total_cost, 4),
                "events_by_type": dict(by_type),
                "events_by_provider": dict(by_provider),
            }

    def get_projects(self) -> list[dict[str, Any]]:
        """Return list of known projects with event counts."""
        with self._lock:
            projects: dict[str, dict[str, Any]] = {}
            for f in self._flows.values():
                p = f.project or "(unknown)"
                if p not in projects:
                    projects[p] = {"name": p, "events": 0, "sessions": set(), "last_activity": 0.0}
                projects[p]["events"] += f.message_count
                if f.session_id:
                    projects[p]["sessions"].add(f.session_id)
                projects[p]["last_activity"] = max(projects[p]["last_activity"], f.end_time)

            result = []
            for p in sorted(projects.values(), key=lambda x: x["last_activity"], reverse=True):
                result.append({
                    "name": p["name"],
                    "events": p["events"],
                    "session_count": len(p["sessions"]),
                    "last_activity": datetime.fromtimestamp(p["last_activity"], tz=timezone.utc).isoformat() if p["last_activity"] else "",
                })
            return result

    def get_sessions(self, project: str = "") -> list[dict[str, Any]]:
        """Return list of sessions, optionally filtered by project."""
        with self._lock:
            sessions: dict[str, dict[str, Any]] = {}
            for f in self._flows.values():
                if project and f.project != project:
                    continue
                sid = f.session_id or "(unknown)"
                if sid not in sessions:
                    sessions[sid] = {
                        "session_id": sid,
                        "project": f.project,
                        "events": 0,
                        "start_time": f.start_time,
                        "end_time": f.end_time,
                        "prompts": [],
                    }
                sessions[sid]["events"] += f.message_count
                sessions[sid]["start_time"] = min(sessions[sid]["start_time"], f.start_time)
                sessions[sid]["end_time"] = max(sessions[sid]["end_time"], f.end_time)
                if f.conversation_type == "user_request" and f.summary.startswith("Prompt:"):
                    sessions[sid]["prompts"].append(f.summary[7:].strip())

            result = []
            for s in sorted(sessions.values(), key=lambda x: x["end_time"], reverse=True):
                result.append({
                    "session_id": s["session_id"],
                    "project": s["project"],
                    "events": s["events"],
                    "start_time": datetime.fromtimestamp(s["start_time"], tz=timezone.utc).isoformat() if s["start_time"] else "",
                    "end_time": datetime.fromtimestamp(s["end_time"], tz=timezone.utc).isoformat() if s["end_time"] else "",
                    "prompt_count": len(s["prompts"]),
                    "last_prompt": s["prompts"][-1][:100] if s["prompts"] else "",
                })
            return result

    def clear(self, project: str = "") -> None:
        """Clear flow data. If project given, only clear that project's data."""
        with self._lock:
            if project:
                to_remove = [fid for fid, f in self._flows.items() if f.project == project]
                for fid in to_remove:
                    del self._flows[fid]
                self._active_flows = {k: v for k, v in self._active_flows.items() if v not in to_remove}
                self._events = [e for e in self._events if e.project != project]
            else:
                self._flows.clear()
                self._active_flows.clear()
                self._events.clear()
                self._event_seq = 0
