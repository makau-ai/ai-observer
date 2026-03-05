/* ═══════════════════════════════════════════════════════════════════
   AI Observer — D3 Force Graph + Event Timeline + Replay
   Per-project / per-session filtering + individual event tracking
   ═══════════════════════════════════════════════════════════════════ */

const POLL_INTERVAL = 2000;
const MAX_EVENTS = 5000;

/* ── Entity Styles ────────────────────────────────────────────────── */

const ENTITY_STYLES = {
    external_ai: { fill: '#f59e0b', glow: '#fbbf24', shape: 'octagon', icon: '\uD83D\uDDA5\uFE0F', label: 'External AI' },
    model:       { fill: '#ec4899', glow: '#f472b6', shape: 'diamond', icon: '\uD83E\uDDE0', label: 'LLM Model' },
    tool:        { fill: '#64748b', glow: '#94a3b8', shape: 'rect',    icon: '\uD83D\uDD27', label: 'Tool' },
    user:        { fill: '#06b6d4', glow: '#22d3ee', shape: 'shield',  icon: '\uD83D\uDC64', label: 'Human' },
};

const INTERACTION_ICONS = {
    tool_call:       { icon: '\uD83D\uDD27', color: '#64748b' },
    user_request:    { icon: '\uD83D\uDC64', color: '#06b6d4' },
    llm_call:        { icon: '\uD83E\uDDE0', color: '#ec4899' },
    task_delegation: { icon: '\uD83D\uDCCB', color: '#3b82f6' },
    session_end:     { icon: '\uD83D\uDCCA', color: '#f97316' },
    error:           { icon: '\u26A0\uFE0F', color: '#ef4444' },
    default:         { icon: '\u26A1',       color: '#94a3b8' },
};

function getEntityType(nodeId) {
    if (nodeId.startsWith('EXT:')) return 'external_ai';
    if (nodeId.startsWith('\uD83E\uDDE0') || nodeId.startsWith('model:')) return 'model';
    if (nodeId.startsWith('\uD83D\uDD27') || nodeId.startsWith('tool:')) return 'tool';
    if (nodeId.startsWith('\uD83D\uDC64') || nodeId.startsWith('user:')) return 'user';
    return 'external_ai';
}

function getInteractionStyle(type) {
    return INTERACTION_ICONS[type] || INTERACTION_ICONS.default;
}

function getDisplayName(nodeId) {
    if (nodeId.startsWith('EXT:')) {
        const parts = nodeId.split(':');
        return parts.length >= 3 ? parts.slice(2).join(':') : parts[1];
    }
    if (nodeId.startsWith('\uD83E\uDDE0 ')) return nodeId.slice(2);
    if (nodeId.startsWith('\uD83D\uDD27 ')) return nodeId.slice(2);
    if (nodeId.startsWith('\uD83D\uDC64 ')) return nodeId.slice(2);
    return nodeId;
}

/* ── Filter State ─────────────────────────────────────────────────── */

let _filterProject = '';
let _filterSession = '';

function filterParams() {
    const params = new URLSearchParams();
    if (_filterProject) params.set('project', _filterProject);
    if (_filterSession) params.set('session', _filterSession);
    const qs = params.toString();
    return qs ? '?' + qs : '';
}

function eventFilterParams(extra = {}) {
    const params = new URLSearchParams();
    if (_filterProject) params.set('project', _filterProject);
    if (_filterSession) params.set('session', _filterSession);
    for (const [k, v] of Object.entries(extra)) {
        if (v !== undefined && v !== null && v !== 0 && v !== '') params.set(k, v);
    }
    const qs = params.toString();
    return qs ? '?' + qs : '';
}

function onProjectChange() {
    _filterProject = document.getElementById('filter-project').value;
    _filterSession = '';
    document.getElementById('filter-session').value = '';
    _fingerprint = '';
    _lastEventSeq = 0;
    _events = [];
    loadSessions();
    loadAll();
}

function onSessionChange() {
    _filterSession = document.getElementById('filter-session').value;
    _fingerprint = '';
    _lastEventSeq = 0;
    _events = [];
    loadAll();
}

/* ── State ────────────────────────────────────────────────────────── */

let _simulation = null;
let _graphData = null;
let _fingerprint = '';
let _events = [];
let _lastEventSeq = 0;
let _particleInterval = null;

// Replay state
let _replayActive = false;
let _replayInterval = null;
let _replayIndex = 0;
let _replaySpeed = 1000;  // ms per step
let _replayMode = 'step'; // 'step' = fixed interval, 'temporal' = proportional to real time

/* ── Graph Rendering ──────────────────────────────────────────────── */

function renderGraph(data) {
    const svg = d3.select('#graph-svg');
    const width = svg.node().clientWidth;
    const height = svg.node().clientHeight;

    svg.selectAll('*').remove();

    const defs = svg.append('defs');
    const glow = defs.append('filter').attr('id', 'glow').attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
    glow.append('feGaussianBlur').attr('stdDeviation', '4').attr('result', 'blur');
    glow.append('feMerge').selectAll('feMergeNode').data(['blur', 'SourceGraphic']).enter()
        .append('feMergeNode').attr('in', d => d);

    const pglow = defs.append('filter').attr('id', 'particle-glow').attr('x', '-100%').attr('y', '-100%').attr('width', '300%').attr('height', '300%');
    pglow.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'blur');
    pglow.append('feMerge').selectAll('feMergeNode').data(['blur', 'SourceGraphic']).enter()
        .append('feMergeNode').attr('in', d => d);

    const g = svg.append('g');
    svg.call(d3.zoom().scaleExtent([0.2, 5]).on('zoom', (event) => {
        g.attr('transform', event.transform);
    }));

    const nodes = data.nodes;
    const edges = data.edges;

    if (nodes.length === 0) {
        svg.append('text')
            .attr('x', width / 2).attr('y', height / 2)
            .attr('text-anchor', 'middle')
            .attr('fill', 'rgba(255,255,255,0.2)')
            .attr('font-size', '14px')
            .text('Waiting for events... Start a Claude Code session.');
        return;
    }

    const edgeLines = g.append('g').attr('class', 'edges')
        .selectAll('line').data(edges).enter().append('line')
        .attr('stroke', d => {
            const srcType = getEntityType(d.source);
            return ENTITY_STYLES[srcType]?.glow || '#334155';
        })
        .attr('stroke-opacity', d => Math.min(0.15 + d.count * 0.05, 0.6))
        .attr('stroke-width', d => Math.min(1 + d.count * 0.3, 4));

    const particleLayer = g.append('g').attr('class', 'particles');

    const nodeGs = g.append('g').attr('class', 'nodes')
        .selectAll('g').data(nodes, d => d.id).enter().append('g')
        .attr('cursor', 'pointer')
        .call(d3.drag()
            .on('start', (event, d) => { if (!event.active) _simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
            .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
            .on('end', (event, d) => { if (!event.active) _simulation.alphaTarget(0); d.fx = null; d.fy = null; })
        );

    nodeGs.each(function (d) {
        const node = d3.select(this);
        const es = ENTITY_STYLES[d.type] || ENTITY_STYLES.external_ai;
        const r = 12 + Math.min(8, (d.messages_sent + d.messages_received) * 0.5);

        node.append('circle').attr('r', r + 6)
            .attr('fill', 'none').attr('stroke', es.glow).attr('stroke-opacity', 0.12)
            .attr('stroke-width', 2).attr('filter', 'url(#glow)');

        const shapeG = node.append('g');
        if (es.shape === 'octagon') drawOctagon(shapeG, r, es.fill, es.glow);
        else if (es.shape === 'diamond') drawDiamond(shapeG, r, es.fill, es.glow);
        else if (es.shape === 'rect') drawRoundRect(shapeG, r, es.fill, es.glow);
        else if (es.shape === 'shield') drawShield(shapeG, r, es.fill, es.glow);

        node.append('text')
            .attr('text-anchor', 'middle').attr('dy', '0.35em')
            .attr('font-size', r * 0.9 + 'px')
            .text(es.icon);

        node.append('text')
            .attr('text-anchor', 'middle').attr('dy', r + 14)
            .attr('font-size', '9px')
            .attr('fill', es.glow).attr('font-weight', 500)
            .text(getDisplayName(d.id));

        node.append('text')
            .attr('text-anchor', 'middle').attr('dy', r + 24)
            .attr('font-size', '7px')
            .attr('fill', es.glow).attr('fill-opacity', 0.5)
            .text(es.label.toUpperCase());
    });

    nodeGs.on('mouseover', (event, d) => {
        const es = ENTITY_STYLES[d.type] || ENTITY_STYLES.external_ai;
        const tip = document.getElementById('tooltip');
        tip.innerHTML = `
            <div class="tooltip-title">${getDisplayName(d.id)}</div>
            <div class="tooltip-row">Type: ${es.label}</div>
            <div class="tooltip-row">Sent: ${d.messages_sent} | Received: ${d.messages_received}</div>
        `;
        tip.classList.remove('hidden');
        tip.style.left = (event.clientX + 12) + 'px';
        tip.style.top = (event.clientY - 10) + 'px';
    }).on('mousemove', (event) => {
        const tip = document.getElementById('tooltip');
        tip.style.left = (event.clientX + 12) + 'px';
        tip.style.top = (event.clientY - 10) + 'px';
    }).on('mouseout', () => {
        document.getElementById('tooltip').classList.add('hidden');
    });

    _simulation = d3.forceSimulation(nodes)
        .force('link', d3.forceLink(edges).id(d => d.id).distance(120).strength(0.3))
        .force('charge', d3.forceManyBody().strength(-300))
        .force('center', d3.forceCenter(width / 2, height / 2))
        .force('collision', d3.forceCollide().radius(35))
        .force('x', d3.forceX(width / 2).strength(0.04))
        .force('y', d3.forceY(height / 2).strength(0.04))
        .on('tick', () => {
            edgeLines
                .attr('x1', d => d.source.x).attr('y1', d => d.source.y)
                .attr('x2', d => d.target.x).attr('y2', d => d.target.y);
            nodeGs.attr('transform', d => `translate(${d.x},${d.y})`);
        });

    if (_particleInterval) clearInterval(_particleInterval);
    const maxCount = Math.max(1, ...edges.map(e => e.count));

    _particleInterval = setInterval(() => {
        if (_replayActive) return; // don't auto-animate during replay
        edges.forEach(edge => {
            if (Math.random() > 0.12 * ((edge.count || 1) / maxCount + 0.1)) return;
            const src = typeof edge.source === 'object' ? edge.source : nodes.find(n => n.id === edge.source);
            const tgt = typeof edge.target === 'object' ? edge.target : nodes.find(n => n.id === edge.target);
            if (!src || !tgt || !src.x || !tgt.x) return;
            const srcType = getEntityType(typeof edge.source === 'object' ? edge.source.id : edge.source);
            const color = (ENTITY_STYLES[srcType] || ENTITY_STYLES.external_ai).glow;
            particleLayer.append('circle')
                .attr('r', 2.5).attr('fill', color).attr('filter', 'url(#particle-glow)')
                .attr('cx', src.x).attr('cy', src.y)
                .transition().duration(500 + Math.random() * 500).ease(d3.easeLinear)
                .attr('cx', tgt.x).attr('cy', tgt.y)
                .attr('r', 0.8).attr('opacity', 0)
                .remove();
        });
    }, 250);

    renderLegend();
}

/* ── Shape Generators ─────────────────────────────────────────────── */

function drawOctagon(g, r, fill, stroke) {
    const pts = d3.range(8).map(i => {
        const a = (Math.PI / 4) * i - Math.PI / 8;
        return [r * Math.cos(a), r * Math.sin(a)];
    });
    g.append('polygon').attr('points', pts.map(p => p.join(',')).join(' '))
        .attr('fill', fill).attr('fill-opacity', 0.3)
        .attr('stroke', stroke).attr('stroke-width', 1.8).attr('stroke-opacity', 0.8);
}

function drawDiamond(g, r, fill, stroke) {
    const pts = [[0, -r], [r * 0.7, 0], [0, r], [-r * 0.7, 0]];
    g.append('polygon').attr('points', pts.map(p => p.join(',')).join(' '))
        .attr('fill', fill).attr('fill-opacity', 0.3)
        .attr('stroke', stroke).attr('stroke-width', 1.8).attr('stroke-opacity', 0.8);
}

function drawRoundRect(g, r, fill, stroke) {
    g.append('rect').attr('x', -r * 0.75).attr('y', -r * 0.55).attr('width', r * 1.5).attr('height', r * 1.1)
        .attr('rx', 4).attr('ry', 4)
        .attr('fill', fill).attr('fill-opacity', 0.25)
        .attr('stroke', stroke).attr('stroke-width', 1.8).attr('stroke-opacity', 0.7);
}

function drawShield(g, r, fill, stroke) {
    const pts = [[-r * 0.65, -r * 0.6], [0, -r * 0.8], [r * 0.65, -r * 0.6], [r * 0.65, r * 0.2], [0, r * 0.8], [-r * 0.65, r * 0.2]];
    g.append('polygon').attr('points', pts.map(p => p.join(',')).join(' '))
        .attr('fill', fill).attr('fill-opacity', 0.3)
        .attr('stroke', stroke).attr('stroke-width', 1.8).attr('stroke-opacity', 0.8);
}

/* ── Legend ────────────────────────────────────────────────────────── */

function renderLegend() {
    const legend = document.getElementById('legend');
    legend.innerHTML = Object.entries(ENTITY_STYLES).map(([key, es]) =>
        `<div class="legend-item">
            <div class="legend-dot" style="background:${es.fill}"></div>
            <span>${es.icon} ${es.label}</span>
        </div>`
    ).join('');
}

/* ── Timeline Rendering (individual events) ──────────────────────── */

function renderTimeline(events) {
    const container = document.getElementById('timeline-list');
    if (!events || events.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">\u23F3</div>No events yet.<br>Start a Claude Code session.</div>';
        updateReplayControls();
        return;
    }

    container.innerHTML = events.map((evt, idx) => {
        const style = getInteractionStyle(evt.conversation_type);
        const time = evt.timestamp
            ? new Date(evt.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
            : '';

        const src = getDisplayName(evt.source);
        const tgt = getDisplayName(evt.target);

        // Classify entry
        const isPrompt = evt.conversation_type === 'user_request' && evt.summary.startsWith('Prompt:');
        const isSessionStart = evt.summary.includes('session started') || evt.summary.includes('Session started');
        const isError = evt.conversation_type === 'error';

        let cssClass = 'timeline-entry';
        if (isPrompt) cssClass += ' is-prompt';
        else if (isSessionStart) cssClass += ' is-session-start';
        else if (isError) cssClass += ' is-error';

        // Project badge (when showing all projects)
        const projectBadge = (!_filterProject && evt.project)
            ? `<span class="tl-project-badge">${evt.project}</span>`
            : '';

        // Summary text
        const summaryText = isPrompt
            ? evt.summary.slice(8)
            : (evt.summary || evt.conversation_type);

        // Sequence number for reference
        const seqBadge = `<span class="tl-seq">#${evt.seq}</span>`;

        // Time delta from previous event
        let deltaText = '';
        if (idx > 0 && events[idx - 1].timestamp_unix && evt.timestamp_unix) {
            const deltaMs = (evt.timestamp_unix - events[idx - 1].timestamp_unix) * 1000;
            if (deltaMs > 1000) {
                deltaText = `<span class="tl-delta">+${(deltaMs / 1000).toFixed(1)}s</span>`;
            }
        }

        // Detail row (expandable)
        const detail = `<div class="tl-detail">
            <div class="tl-detail-row"><span class="tl-detail-label">Event ID</span><span class="tl-detail-value">${evt.event_id}</span></div>
            <div class="tl-detail-row"><span class="tl-detail-label">Type</span><span class="tl-detail-value">${evt.conversation_type}</span></div>
            <div class="tl-detail-row"><span class="tl-detail-label">Source</span><span class="tl-detail-value">${evt.source}</span></div>
            <div class="tl-detail-row"><span class="tl-detail-label">Target</span><span class="tl-detail-value">${evt.target}</span></div>
            ${evt.project ? `<div class="tl-detail-row"><span class="tl-detail-label">Project</span><span class="tl-detail-value">${evt.project}</span></div>` : ''}
            ${evt.session_id ? `<div class="tl-detail-row"><span class="tl-detail-label">Session</span><span class="tl-detail-value">${evt.session_id.slice(0, 16)}...</span></div>` : ''}
            ${evt.tokens > 0 ? `<div class="tl-detail-row"><span class="tl-detail-label">Tokens</span><span class="tl-detail-value">${evt.tokens.toLocaleString()}</span></div>` : ''}
            ${evt.cost_usd > 0 ? `<div class="tl-detail-row"><span class="tl-detail-label">Cost</span><span class="tl-detail-value">$${evt.cost_usd.toFixed(6)}</span></div>` : ''}
        </div>`;

        return `<div class="${cssClass}" data-index="${idx}" id="tl-entry-${idx}" onclick="toggleTimelineDetail(${idx})">
            <div class="tl-icon">${style.icon}</div>
            <div class="tl-content">
                <div class="tl-agents">${seqBadge} ${src} \u2192 ${tgt}${projectBadge}</div>
                <div class="tl-summary">${summaryText}</div>
                <span class="tl-type-badge" style="background:${style.color}30;color:${style.color}">${evt.conversation_type}</span>
                ${detail}
            </div>
            <div class="tl-meta">
                <div>${time}</div>
                ${deltaText}
            </div>
        </div>`;
    }).join('');

    updateReplayControls();

    // Auto-scroll to bottom if not in replay mode
    if (!_replayActive) {
        container.scrollTop = container.scrollHeight;
    }
}

function toggleTimelineDetail(idx) {
    const entry = document.getElementById(`tl-entry-${idx}`);
    if (entry) entry.classList.toggle('expanded');
}

/* ── Timeline Replay ─────────────────────────────────────────────── */

function updateReplayControls() {
    const total = _events.length;
    const pos = _replayActive ? _replayIndex : total;
    document.getElementById('replay-position').textContent = `${pos}/${total}`;
    document.getElementById('timeline-progress').style.width =
        total > 0 ? (pos / total * 100) + '%' : '0%';
}

function replayToggle() {
    if (_replayActive) replayPause();
    else replayStart();
}

function replayStart() {
    if (_events.length === 0) return;
    _replayActive = true;
    document.getElementById('timeline-play').textContent = '\u23F8';
    document.getElementById('timeline-play').title = 'Pause';
    if (_replayIndex >= _events.length) _replayIndex = 0;

    stepReplay();
}

function stepReplay() {
    if (!_replayActive) return;
    if (_replayIndex >= _events.length) {
        replayPause();
        return;
    }

    const evt = _events[_replayIndex];
    highlightTimelineEntry(_replayIndex);
    fireParticle(evt);
    _replayIndex++;
    updateReplayControls();

    // Schedule next step
    let delay = _replaySpeed;
    if (_replayMode === 'temporal' && _replayIndex < _events.length) {
        const next = _events[_replayIndex];
        const gap = (next.timestamp_unix - evt.timestamp_unix) * 1000;
        // Scale the real gap — cap between 100ms and 3000ms
        delay = Math.max(100, Math.min(3000, gap * (1000 / _replaySpeed)));
    }

    _replayInterval = setTimeout(stepReplay, delay);
}

function replayPause() {
    _replayActive = false;
    document.getElementById('timeline-play').textContent = '\u25B6';
    document.getElementById('timeline-play').title = 'Play';
    if (_replayInterval) { clearTimeout(_replayInterval); _replayInterval = null; }
}

function replayReset() {
    replayPause();
    _replayIndex = 0;
    document.querySelectorAll('.timeline-entry').forEach(el => el.classList.remove('active'));
    updateReplayControls();
}

function replayStepForward() {
    if (_replayIndex >= _events.length) return;
    const evt = _events[_replayIndex];
    highlightTimelineEntry(_replayIndex);
    fireParticle(evt);
    _replayIndex++;
    updateReplayControls();
}

function replayStepBack() {
    if (_replayIndex <= 0) return;
    _replayIndex--;
    highlightTimelineEntry(_replayIndex);
    updateReplayControls();
}

function setReplaySpeed(ms) {
    _replaySpeed = parseInt(ms);
    // If currently playing, restart with new speed
    if (_replayActive) {
        if (_replayInterval) clearTimeout(_replayInterval);
        stepReplay();
    }
}

function toggleReplayMode() {
    _replayMode = _replayMode === 'step' ? 'temporal' : 'step';
    const btn = document.getElementById('replay-mode');
    btn.textContent = _replayMode === 'step' ? 'Fixed' : 'Temporal';
    btn.title = _replayMode === 'step'
        ? 'Fixed interval between events'
        : 'Proportional to real time gaps';
}

function highlightTimelineEntry(idx) {
    document.querySelectorAll('.timeline-entry').forEach(el => el.classList.remove('active'));
    const entry = document.getElementById(`tl-entry-${idx}`);
    if (entry) {
        entry.classList.add('active');
        entry.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    }
}

function onProgressBarClick(e) {
    if (_events.length === 0) return;
    const bar = document.getElementById('timeline-progress-bar');
    const rect = bar.getBoundingClientRect();
    const pct = (e.clientX - rect.left) / rect.width;
    _replayIndex = Math.floor(pct * _events.length);
    highlightTimelineEntry(_replayIndex);
    updateReplayControls();
}

/* ── Particle Animation ───────────────────────────────────────────── */

function fireParticle(evt) {
    if (!_simulation) return;
    const nodes = _simulation.nodes();
    const src = nodes.find(n => n.id === evt.source);
    const tgt = nodes.find(n => n.id === evt.target);
    if (!src || !tgt || !src.x || !tgt.x) return;

    const particleLayer = d3.select('#graph-svg').select('.particles');
    if (particleLayer.empty()) return;

    const color = (ENTITY_STYLES[getEntityType(evt.source)] || ENTITY_STYLES.external_ai).glow;

    // Main particle
    particleLayer.append('circle')
        .attr('r', 5).attr('fill', color).attr('fill-opacity', 0.9)
        .attr('filter', 'url(#particle-glow)')
        .attr('cx', src.x).attr('cy', src.y)
        .transition().duration(800).ease(d3.easeCubicInOut)
        .attr('cx', tgt.x).attr('cy', tgt.y)
        .attr('r', 2).attr('fill-opacity', 0)
        .remove();

    // Glow trail
    particleLayer.append('circle')
        .attr('r', 8).attr('fill', color).attr('fill-opacity', 0.3)
        .attr('cx', src.x).attr('cy', src.y)
        .transition().duration(600).ease(d3.easeCubicInOut)
        .attr('cx', tgt.x).attr('cy', tgt.y)
        .attr('r', 3).attr('fill-opacity', 0)
        .remove();
}

/* ── Stats Panel ──────────────────────────────────────────────────── */

function renderStats(stats) {
    const container = document.getElementById('stats-content');
    if (!stats) { container.innerHTML = ''; return; }

    const byType = stats.events_by_type || {};
    const maxTypeCount = Math.max(1, ...Object.values(byType));

    let html = `
        <div class="stat-row"><span class="stat-label">Total Events</span><span class="stat-value">${stats.total_events || 0}</span></div>
        <div class="stat-row"><span class="stat-label">Total Flows</span><span class="stat-value">${stats.total_flows || 0}</span></div>
        <div class="stat-row"><span class="stat-label">Total Tokens</span><span class="stat-value">${(stats.total_tokens || 0).toLocaleString()}</span></div>
        <div class="stat-row"><span class="stat-label">Total Cost</span><span class="stat-value">$${(stats.total_cost_usd || 0).toFixed(4)}</span></div>
    `;

    if (Object.keys(byType).length > 0) {
        html += '<div style="margin-top:6px;font-size:9px;color:rgba(255,255,255,0.4);text-transform:uppercase">By Type</div>';
        for (const [type, count] of Object.entries(byType).sort((a, b) => b[1] - a[1])) {
            const style = getInteractionStyle(type);
            const pct = (count / maxTypeCount) * 100;
            html += `<div class="stat-bar-row">
                <span style="width:80px;color:${style.color}">${style.icon} ${type}</span>
                <div class="stat-bar"><div class="stat-bar-fill" style="width:${pct}%;background:${style.color}"></div></div>
                <span class="stat-value" style="width:30px;text-align:right">${count}</span>
            </div>`;
        }
    }

    container.innerHTML = html;
}

function updateCounters(stats) {
    document.getElementById('event-counter').textContent = `${stats.total_events || 0} events`;
    document.getElementById('token-counter').textContent = `${(stats.total_tokens || 0).toLocaleString()} tokens`;
    document.getElementById('cost-counter').textContent = `$${(stats.total_cost_usd || 0).toFixed(2)}`;
}

/* ── Data Fetching ────────────────────────────────────────────────── */

async function fetchJSON(url) {
    const res = await fetch(url);
    return res.json();
}

async function loadGraph() {
    try {
        const data = await fetchJSON('/api/graph' + filterParams());
        const fp = JSON.stringify(data.nodes.map(n => n.id).sort()) +
                   JSON.stringify(data.edges.map(e => e.source + e.target + e.count).sort());
        if (fp !== _fingerprint) {
            _fingerprint = fp;
            _graphData = data;
            renderGraph(data);
        }
    } catch (e) {
        console.warn('Graph load failed:', e);
    }
}

async function loadEvents() {
    try {
        const resp = await fetchJSON('/api/events' + eventFilterParams({ since_seq: _lastEventSeq }));
        const newEvents = resp.events || [];
        if (newEvents.length > 0) {
            _events = _events.concat(newEvents);
            // Cap to prevent memory issues
            if (_events.length > MAX_EVENTS) {
                _events = _events.slice(-MAX_EVENTS);
            }
            _lastEventSeq = Math.max(..._events.map(e => e.seq));
            if (!_replayActive) {
                renderTimeline(_events);
            }
        }
    } catch (e) {
        console.warn('Events load failed:', e);
    }
}

async function loadStats() {
    try {
        const stats = await fetchJSON('/api/stats' + filterParams());
        renderStats(stats);
        updateCounters(stats);
    } catch (e) {
        console.warn('Stats load failed:', e);
    }
}

async function loadProjects() {
    try {
        const resp = await fetchJSON('/api/projects');
        const projects = resp.projects || [];
        const sel = document.getElementById('filter-project');
        const current = sel.value;
        sel.innerHTML = '<option value="">All Projects</option>' +
            projects.map(p =>
                `<option value="${p.name}" ${p.name === current ? 'selected' : ''}>${p.name} (${p.events})</option>`
            ).join('');
    } catch (e) {
        console.warn('Projects load failed:', e);
    }
}

async function loadSessions() {
    try {
        const params = _filterProject ? `?project=${encodeURIComponent(_filterProject)}` : '';
        const resp = await fetchJSON('/api/sessions' + params);
        const sessions = resp.sessions || [];
        const sel = document.getElementById('filter-session');
        const current = sel.value;
        sel.innerHTML = '<option value="">All Sessions</option>' +
            sessions.map(s => {
                const label = s.last_prompt
                    ? s.last_prompt.slice(0, 40) + (s.last_prompt.length > 40 ? '...' : '')
                    : s.session_id.slice(0, 12) + '...';
                return `<option value="${s.session_id}" ${s.session_id === current ? 'selected' : ''}>${label} (${s.events})</option>`;
            }).join('');
    } catch (e) {
        console.warn('Sessions load failed:', e);
    }
}

async function loadAll() {
    await Promise.all([loadGraph(), loadEvents(), loadStats()]);
}

async function clearData() {
    const params = _filterProject ? `?project=${encodeURIComponent(_filterProject)}` : '';
    await fetch('/api/clear' + params, { method: 'POST' });
    _fingerprint = '';
    _events = [];
    _lastEventSeq = 0;
    _replayIndex = 0;
    replayPause();
    await Promise.all([loadProjects(), loadSessions(), loadAll()]);
}

/* ── Init ─────────────────────────────────────────────────────────── */

async function init() {
    // Wire up progress bar click
    document.getElementById('timeline-progress-bar').addEventListener('click', onProgressBarClick);

    await Promise.all([loadProjects(), loadSessions()]);
    await loadAll();
}

init();
setInterval(loadAll, POLL_INTERVAL);
setInterval(() => { loadProjects(); loadSessions(); }, 10000);
