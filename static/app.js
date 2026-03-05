/* ═══════════════════════════════════════════════════════════════════
   AI Observer — D3 Force Graph + Timeline + Particles
   ═══════════════════════════════════════════════════════════════════ */

const POLL_INTERVAL = 3000;

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
    // Strip prefixes for cleaner labels
    if (nodeId.startsWith('EXT:')) {
        const parts = nodeId.split(':');
        return parts.length >= 3 ? parts.slice(2).join(':') : parts[1];
    }
    if (nodeId.startsWith('\uD83E\uDDE0 ')) return nodeId.slice(2);
    if (nodeId.startsWith('\uD83D\uDD27 ')) return nodeId.slice(2);
    if (nodeId.startsWith('\uD83D\uDC64 ')) return nodeId.slice(2);
    return nodeId;
}

/* ── State ────────────────────────────────────────────────────────── */

let _simulation = null;
let _graphData = null;
let _fingerprint = '';
let _timelineData = [];
let _timelinePlaying = false;
let _timelineInterval = null;
let _timelineIndex = 0;
let _timelineSpeed = 1000;
let _particleInterval = null;

/* ── Graph Rendering ──────────────────────────────────────────────── */

function renderGraph(data) {
    const svg = d3.select('#graph-svg');
    const width = svg.node().clientWidth;
    const height = svg.node().clientHeight;

    // Clear previous
    svg.selectAll('*').remove();

    // SVG filters
    const defs = svg.append('defs');

    // Glow filter
    const glow = defs.append('filter').attr('id', 'glow').attr('x', '-50%').attr('y', '-50%').attr('width', '200%').attr('height', '200%');
    glow.append('feGaussianBlur').attr('stdDeviation', '4').attr('result', 'blur');
    glow.append('feMerge').selectAll('feMergeNode').data(['blur', 'SourceGraphic']).enter()
        .append('feMergeNode').attr('in', d => d);

    // Particle glow
    const pglow = defs.append('filter').attr('id', 'particle-glow').attr('x', '-100%').attr('y', '-100%').attr('width', '300%').attr('height', '300%');
    pglow.append('feGaussianBlur').attr('stdDeviation', '3').attr('result', 'blur');
    pglow.append('feMerge').selectAll('feMergeNode').data(['blur', 'SourceGraphic']).enter()
        .append('feMergeNode').attr('in', d => d);

    const g = svg.append('g');

    // Zoom
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
            .text('Waiting for events... Start a Claude Code session or send test events.');
        return;
    }

    // Edge lines
    const edgeLines = g.append('g').attr('class', 'edges')
        .selectAll('line').data(edges).enter().append('line')
        .attr('stroke', d => {
            const srcType = getEntityType(d.source);
            return ENTITY_STYLES[srcType]?.glow || '#334155';
        })
        .attr('stroke-opacity', d => Math.min(0.15 + d.count * 0.05, 0.6))
        .attr('stroke-width', d => Math.min(1 + d.count * 0.3, 4));

    // Particle layer
    const particleLayer = g.append('g').attr('class', 'particles');

    // Node groups
    const nodeGs = g.append('g').attr('class', 'nodes')
        .selectAll('g').data(nodes, d => d.id).enter().append('g')
        .attr('cursor', 'pointer')
        .call(d3.drag()
            .on('start', (event, d) => { if (!event.active) _simulation.alphaTarget(0.3).restart(); d.fx = d.x; d.fy = d.y; })
            .on('drag', (event, d) => { d.fx = event.x; d.fy = event.y; })
            .on('end', (event, d) => { if (!event.active) _simulation.alphaTarget(0); d.fx = null; d.fy = null; })
        );

    // Render each node
    nodeGs.each(function (d) {
        const node = d3.select(this);
        const es = ENTITY_STYLES[d.type] || ENTITY_STYLES.external_ai;
        const r = 12 + Math.min(8, (d.messages_sent + d.messages_received) * 0.5);

        // Outer glow
        node.append('circle').attr('r', r + 6)
            .attr('fill', 'none').attr('stroke', es.glow).attr('stroke-opacity', 0.12)
            .attr('stroke-width', 2).attr('filter', 'url(#glow)');

        // Shape
        const shapeG = node.append('g');
        if (es.shape === 'octagon') drawOctagon(shapeG, r, es.fill, es.glow);
        else if (es.shape === 'diamond') drawDiamond(shapeG, r, es.fill, es.glow);
        else if (es.shape === 'rect') drawRoundRect(shapeG, r, es.fill, es.glow);
        else if (es.shape === 'shield') drawShield(shapeG, r, es.fill, es.glow);

        // Icon
        node.append('text')
            .attr('text-anchor', 'middle').attr('dy', '0.35em')
            .attr('font-size', r * 0.9 + 'px')
            .text(es.icon);

        // Label
        node.append('text')
            .attr('text-anchor', 'middle').attr('dy', r + 14)
            .attr('font-size', '9px')
            .attr('fill', es.glow).attr('font-weight', 500)
            .text(getDisplayName(d.id));

        // Type badge
        node.append('text')
            .attr('text-anchor', 'middle').attr('dy', r + 24)
            .attr('font-size', '7px')
            .attr('fill', es.glow).attr('fill-opacity', 0.5)
            .text(es.label.toUpperCase());
    });

    // Hover tooltip
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

    // Force simulation
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

    // Ambient particles
    if (_particleInterval) clearInterval(_particleInterval);
    const maxCount = Math.max(1, ...edges.map(e => e.count));

    _particleInterval = setInterval(() => {
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

    // Render legend
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

/* ── Timeline ─────────────────────────────────────────────────────── */

function renderTimeline(data) {
    const container = document.getElementById('timeline-list');
    if (!data || data.length === 0) {
        container.innerHTML = '<div class="empty-state"><div class="empty-state-icon">\u23F3</div>No events yet.<br>Start a Claude Code session.</div>';
        return;
    }

    container.innerHTML = data.map((flow, idx) => {
        const style = getInteractionStyle(flow.conversation_type);
        const time = flow.start_time ? new Date(flow.start_time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' }) : '';
        const src = getDisplayName(flow.source);
        const tgt = getDisplayName(flow.target);

        return `<div class="timeline-entry" data-index="${idx}" id="tl-entry-${idx}">
            <div class="tl-icon">${style.icon}</div>
            <div class="tl-content">
                <div class="tl-agents">${src} \u2192 ${tgt}</div>
                <div class="tl-summary">${flow.summary || flow.conversation_type}</div>
                <span class="tl-type-badge" style="background:${style.color}30;color:${style.color}">${flow.conversation_type}</span>
            </div>
            <div class="tl-meta">
                <div>${time}</div>
                ${flow.tokens_used ? `<div>${flow.tokens_used} tok</div>` : ''}
                ${flow.cost_usd > 0 ? `<div>$${flow.cost_usd.toFixed(4)}</div>` : ''}
            </div>
        </div>`;
    }).join('');
}

/* ── Timeline Replay ──────────────────────────────────────────────── */

function timelineToggle() {
    if (_timelinePlaying) {
        timelinePause();
    } else {
        timelinePlay();
    }
}

function timelinePlay() {
    if (_timelineData.length === 0) return;
    _timelinePlaying = true;
    document.getElementById('timeline-play').textContent = '\u23F8 Pause';

    if (_timelineIndex >= _timelineData.length) _timelineIndex = 0;

    _timelineInterval = setInterval(() => {
        if (_timelineIndex >= _timelineData.length) {
            timelinePause();
            return;
        }

        const flow = _timelineData[_timelineIndex];
        fireTimelineParticle(flow);

        // Highlight current entry
        document.querySelectorAll('.timeline-entry').forEach(el => el.classList.remove('active'));
        const entry = document.getElementById(`tl-entry-${_timelineIndex}`);
        if (entry) {
            entry.classList.add('active');
            entry.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
        }

        _timelineIndex++;

        // Progress bar
        const pct = (_timelineIndex / _timelineData.length) * 100;
        document.getElementById('timeline-progress').style.width = pct + '%';

    }, _timelineSpeed);
}

function timelinePause() {
    _timelinePlaying = false;
    document.getElementById('timeline-play').textContent = '\u25B6 Play';
    if (_timelineInterval) { clearInterval(_timelineInterval); _timelineInterval = null; }
}

function setTimelineSpeed(ms) {
    _timelineSpeed = parseInt(ms);
    if (_timelinePlaying) {
        timelinePause();
        timelinePlay();
    }
}

function fireTimelineParticle(flow) {
    if (!_simulation) return;

    const nodes = _simulation.nodes();
    const findNode = (id) => nodes.find(n => n.id === id);

    const src = findNode(flow.source);
    const tgt = findNode(flow.target);
    if (!src || !tgt || !src.x || !tgt.x) return;

    const svg = d3.select('#graph-svg');
    const particleLayer = svg.select('.particles');
    if (particleLayer.empty()) return;

    const srcType = getEntityType(flow.source);
    const color = (ENTITY_STYLES[srcType] || ENTITY_STYLES.external_ai).glow;

    // Bright particle
    particleLayer.append('circle')
        .attr('r', 5).attr('fill', color).attr('fill-opacity', 0.9)
        .attr('filter', 'url(#particle-glow)')
        .attr('cx', src.x).attr('cy', src.y)
        .transition().duration(800).ease(d3.easeCubicInOut)
        .attr('cx', tgt.x).attr('cy', tgt.y)
        .attr('r', 2).attr('fill-opacity', 0)
        .remove();

    // Glow halo
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

/* ── Top Bar Counters ─────────────────────────────────────────────── */

function updateCounters(stats) {
    document.getElementById('event-counter').textContent = `${(stats.total_events || 0)} events`;
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
        const data = await fetchJSON('/api/graph');
        const fp = JSON.stringify(data.nodes.map(n => n.id).sort()) + JSON.stringify(data.edges.map(e => e.source + e.target).sort());
        if (fp !== _fingerprint) {
            _fingerprint = fp;
            _graphData = data;
            renderGraph(data);
        }
    } catch (e) {
        console.warn('Graph load failed:', e);
    }
}

async function loadTimeline() {
    try {
        const resp = await fetchJSON('/api/timeline');
        const timeline = resp.timeline || [];
        _timelineData = timeline.sort((a, b) => new Date(a.start_time) - new Date(b.start_time));
        if (!_timelinePlaying) {
            renderTimeline(_timelineData);
        }
    } catch (e) {
        console.warn('Timeline load failed:', e);
    }
}

async function loadStats() {
    try {
        const stats = await fetchJSON('/api/stats');
        renderStats(stats);
        updateCounters(stats);
    } catch (e) {
        console.warn('Stats load failed:', e);
    }
}

async function loadAll() {
    await Promise.all([loadGraph(), loadTimeline(), loadStats()]);
}

async function clearData() {
    await fetch('/api/clear', { method: 'POST' });
    _fingerprint = '';
    _timelineData = [];
    _timelineIndex = 0;
    timelinePause();
    await loadAll();
}

/* ── Init ─────────────────────────────────────────────────────────── */

loadAll();
setInterval(loadAll, POLL_INTERVAL);
