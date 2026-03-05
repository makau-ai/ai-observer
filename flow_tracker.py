"""
Flow Tracker — records agent/tool/model interactions as flow records.

Simplified from autonomous_engineering_lab/orchestration/agent_flow.py.
Tracks source→target interactions with conversation type, tokens, cost, timing.
Provides interaction matrix for D3 graph and timeline for replay.
"""

from __future__ import annotations

import uuid
import time
import threading
from collections import defaultdict
from dataclasses import dataclass, field
from datetime import datetime, timezone
from typing import Any


@dataclass
class FlowRecord:
    """Single source→target interaction flow."""
    flow_id: str
    source: str
    target: str
    conversation_type: str

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

    @property
    def avg_confidence(self) -> float:
        return 1.0  # simplified — no confidence tracking in v1

    def to_dict(self) -> dict[str, Any]:
        return {
            "flow_id": self.flow_id,
            "source": self.source,
            "target": self.target,
            "conversation_type": self.conversation_type,
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
    In-memory flow tracker. Records interactions and provides
    graph data, timeline, and statistics.
    """

    def __init__(self) -> None:
        self._flows: dict[str, FlowRecord] = {}
        self._active_flows: dict[tuple, str] = {}  # (src, tgt, type) → flow_id
        self._lock = threading.Lock()

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
    ) -> FlowRecord:
        """Record an interaction, creating or updating a flow."""
        key = (source, target, conversation_type)
        now = time.time()

        with self._lock:
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

    def get_interaction_matrix(self) -> dict[str, Any]:
        """
        Build NxN interaction matrix + node list with sent/received counts.

        Returns:
            {
                "nodes": {"node_id": {"sent": N, "received": M}},
                "matrix": {"src": {"tgt": count}},
                "total": int
            }
        """
        nodes: dict[str, dict[str, int]] = defaultdict(lambda: {"sent": 0, "received": 0})
        matrix: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
        total = 0

        with self._lock:
            for flow in self._flows.values():
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

    def get_timeline(self) -> list[FlowRecord]:
        """Return flows sorted by start_time (chronological)."""
        with self._lock:
            return sorted(self._flows.values(), key=lambda f: f.start_time)

    def recent_flows(self, limit: int = 50) -> list[FlowRecord]:
        """Return most recent flows sorted by end_time (newest first)."""
        with self._lock:
            flows = sorted(self._flows.values(), key=lambda f: f.end_time, reverse=True)
            return flows[:limit]

    def get_stats(self) -> dict[str, Any]:
        """Aggregate statistics."""
        with self._lock:
            total_events = sum(f.message_count for f in self._flows.values())
            total_tokens = sum(f.tokens_used for f in self._flows.values())
            total_cost = sum(f.cost_usd for f in self._flows.values())
            total_flows = len(self._flows)

            by_type: dict[str, int] = defaultdict(int)
            by_provider: dict[str, int] = defaultdict(int)
            for f in self._flows.values():
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

    def clear(self) -> None:
        """Clear all flow data."""
        with self._lock:
            self._flows.clear()
            self._active_flows.clear()
