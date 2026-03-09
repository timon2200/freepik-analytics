/* ═══════════════════════════════════════════════════
   FREEPIK ANALYTICS — Content Script
   Runs on all freepik.com pages.
   Fetches generation history via API, caches in
   chrome.storage.local, and injects dashboard panel.
   ═══════════════════════════════════════════════════ */

(function () {
    'use strict';

    // Prevent double-injection
    if (window.__freepikAnalyticsInjected) return;
    window.__freepikAnalyticsInjected = true;

    const STORAGE_KEY = 'freepikAnalyticsData';
    const CACHE_TTL = 60 * 60 * 1000; // 1 hour
    const API_BASE = '/pikaso/api/projects/files/recent';
    const PER_PAGE = 50;

    // ─── State ────────────────────────────────────────
    let isOpen = false;
    let isFetching = false;
    let dashboardRoot = null;
    let shadowRoot = null;

    // ─── Create Toggle Button ─────────────────────────
    function createToggleButton() {
        const btn = document.createElement('div');
        btn.id = 'fpk-analytics-toggle';
        btn.innerHTML = `
      <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/>
        <path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/>
        <path d="M18 12a2 2 0 0 0 0 4h4v-4Z"/>
      </svg>
    `;
        Object.assign(btn.style, {
            position: 'fixed',
            right: '0',
            top: '50%',
            transform: 'translateY(-50%)',
            zIndex: '2147483646',
            width: '40px',
            height: '40px',
            background: 'linear-gradient(135deg, #a855f7, #6366f1)',
            borderRadius: '8px 0 0 8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: '#fff',
            boxShadow: '0 4px 20px rgba(168, 85, 247, 0.4)',
            transition: 'all 0.3s ease',
        });

        btn.addEventListener('mouseenter', () => {
            btn.style.width = '48px';
            btn.style.boxShadow = '0 4px 30px rgba(168, 85, 247, 0.6)';
        });
        btn.addEventListener('mouseleave', () => {
            btn.style.width = '40px';
            btn.style.boxShadow = '0 4px 20px rgba(168, 85, 247, 0.4)';
        });

        btn.addEventListener('click', toggleDashboard);
        document.body.appendChild(btn);
    }


    // ─── Create Dashboard Container ───────────────────
    function createDashboardContainer() {
        dashboardRoot = document.createElement('div');
        dashboardRoot.id = 'fpk-analytics-dashboard';
        Object.assign(dashboardRoot.style, {
            position: 'fixed',
            top: '0',
            right: '-480px',
            width: '460px',
            height: '100vh',
            zIndex: '2147483647',
            transition: 'right 0.4s cubic-bezier(0.4, 0, 0.2, 1)',
            overflow: 'hidden',
        });

        shadowRoot = dashboardRoot.attachShadow({ mode: 'open' });

        // Inject dashboard CSS
        const styleLink = document.createElement('link');
        styleLink.rel = 'stylesheet';
        styleLink.href = chrome.runtime.getURL('dashboard.css');
        shadowRoot.appendChild(styleLink);

        // Dashboard inner HTML
        const container = document.createElement('div');
        container.className = 'panel';
        container.innerHTML = getDashboardHTML();
        shadowRoot.appendChild(container);

        document.body.appendChild(dashboardRoot);

        // Close button
        shadowRoot.querySelector('#fpk-close').addEventListener('click', toggleDashboard);
        // Refresh button
        shadowRoot.querySelector('#fpk-refresh').addEventListener('click', () => {
            fetchAllData(true);
        });
    }

    // ─── Toggle Dashboard ─────────────────────────────
    function toggleDashboard() {
        isOpen = !isOpen;
        dashboardRoot.style.right = isOpen ? '0' : '-480px';

        if (isOpen) {
            loadAndRender();
        }
    }

    // ─── Load & Render ────────────────────────────────
    async function loadAndRender() {
        const cached = await getCachedData();
        if (cached && (Date.now() - new Date(cached.scraped_at).getTime()) < CACHE_TTL) {
            renderDashboard(cached);
        } else {
            fetchAllData(false);
        }
    }

    // ─── Chrome Storage Helpers ───────────────────────
    function getCachedData() {
        return new Promise((resolve) => {
            chrome.storage.local.get([STORAGE_KEY], (result) => {
                resolve(result[STORAGE_KEY] || null);
            });
        });
    }

    function setCachedData(data) {
        return new Promise((resolve) => {
            chrome.storage.local.set({ [STORAGE_KEY]: data }, resolve);
        });
    }

    // ─── API Fetcher: Paginate all data (progressive) ──
    async function fetchAllData(forceRefresh) {
        if (isFetching) return;
        isFetching = true;

        showProgress(true, 0, 1);

        try {
            // First page to get total
            const firstRes = await fetch(`${API_BASE}?page=1&per_page=${PER_PAGE}`);
            if (!firstRes.ok) throw new Error(`API returned ${firstRes.status}`);
            const firstData = await firstRes.json();

            const apiTotal = firstData.meta.pagination.total;
            const lastPage = firstData.meta.pagination.last_page;

            const allItems = [];
            processPage(firstData.data, allItems);

            // Show dashboard immediately with first page of data
            let summary = aggregateData(allItems, apiTotal);
            renderDashboard(summary);
            showProgress(true, 1, lastPage);

            // Fetch remaining pages, updating live
            for (let p = 2; p <= lastPage; p++) {
                try {
                    const res = await fetch(`${API_BASE}?page=${p}&per_page=${PER_PAGE}`);
                    if (res.ok) {
                        const pageData = await res.json();
                        if (pageData?.data && Array.isArray(pageData.data)) {
                            processPage(pageData.data, allItems);
                        }
                    } else if (res.status === 429) {
                        // Rate limited — wait longer and retry
                        await delay(2000);
                        p--;
                        continue;
                    }
                } catch (e) {
                    console.warn(`Freepik Analytics: Error on page ${p}`, e);
                }

                // Re-aggregate and re-render every 3 pages for smooth updates
                if (p % 3 === 0 || p === lastPage) {
                    summary = aggregateData(allItems, apiTotal);
                    renderDashboard(summary);
                }
                showProgress(true, p, lastPage);

                // Small delay to avoid rate limiting
                await delay(100);
            }

            // Final render with complete data
            summary = aggregateData(allItems, apiTotal);
            await setCachedData(summary);
            renderDashboard(summary);
            showProgress(false);
        } catch (err) {
            console.error('Freepik Analytics: Fetch failed', err);
            updateStatus('Failed to fetch data. Are you logged in?');
            showProgress(false);
        } finally {
            isFetching = false;
        }
    }

    // ─── Process a page of items ──────────────────────
    function processPage(items, allItems) {
        items.forEach(item => {
            const meta = item.creation?.metadata || {};
            let model = '', provider = '';

            if (item.tool_file_type === 'video') {
                model = meta.model || meta.api || 'unknown-video';
                provider = meta.api || '';
            } else {
                model = meta.mode || meta.service || meta.model || 'unknown-image';
                provider = meta.provider || '';
            }

            allItems.push({
                id: item.id,
                type: item.tool_file_type || 'unknown',
                tool_name: item.tool_name || 'unknown',
                folder_name: item.folder_name || 'Unknown',
                created_at: item.created_at || '',
                model,
                provider,
                status: item.creation?.status || 'unknown',
            });
        });
    }

    // ─── Aggregate data ───────────────────────────────
    function aggregateData(items, apiTotal) {
        const summary = {
            total: items.length,
            api_total: apiTotal,
            scraped_at: new Date().toISOString(),
            by_type: {},
            by_tool: {},
            by_project: {},
            by_model: {},
            by_provider: {},
            by_date: {},
            by_hour: {},
            by_date_hour: {},
            by_month: {},
        };

        items.forEach(item => {
            inc(summary.by_type, item.type);
            inc(summary.by_tool, item.tool_name);
            inc(summary.by_project, item.folder_name);
            inc(summary.by_model, item.model || 'unknown');
            if (item.provider) inc(summary.by_provider, item.provider);

            if (item.created_at) {
                const date = item.created_at.substring(0, 10);
                const month = item.created_at.substring(0, 7);
                inc(summary.by_date, date);
                inc(summary.by_month, month);

                // Hour extraction
                const hourMatch = item.created_at.match(/T(\d{2}):/);
                if (hourMatch) {
                    const hour = parseInt(hourMatch[1], 10);
                    inc(summary.by_hour, hour.toString());
                    inc(summary.by_date_hour, `${date}T${hourMatch[1]}`);
                }
            }
        });

        return summary;
    }

    function inc(obj, key) {
        obj[key] = (obj[key] || 0) + 1;
    }

    function delay(ms) {
        return new Promise(r => setTimeout(r, ms));
    }

    // ─── Show/hide progress bar ─────────────────────
    function showProgress(show, current, total) {
        let bar = shadowRoot?.querySelector('#fpk-progress');
        const content = shadowRoot?.querySelector('#fpk-content');
        const loading = shadowRoot?.querySelector('#fpk-loading');

        // Always show content when we have data flowing
        if (content && current > 0) {
            content.style.display = 'block';
            if (loading) loading.style.display = 'none';
        }

        if (!show) {
            if (bar) bar.style.opacity = '0';
            if (loading) loading.style.display = 'none';
            if (content) content.style.display = 'block';
            return;
        }

        if (bar) {
            bar.style.opacity = '1';
            const pct = total > 0 ? ((current / total) * 100) : 0;
            bar.querySelector('.progress-fill').style.width = `${pct}%`;
            bar.querySelector('.progress-text').textContent = current > 0 ? `${current}/${total} pages` : 'Starting…';
        }
    }

    function updateStatus(text) {
        const el = shadowRoot?.querySelector('#fpk-status');
        if (el) el.textContent = text;
    }

    // ─── Dashboard HTML Template ──────────────────────
    function getDashboardHTML() {
        return `
      <div class="panel-header">
        <div class="panel-title">
          <span class="panel-logo">⚡</span>
          Freepik Analytics
        </div>
        <div class="panel-actions">
          <button id="fpk-refresh" class="icon-btn" title="Refresh data">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M21.5 2v6h-6M2.5 22v-6h6M2 11.5a10 10 0 0 1 18.8-4.3M22 12.5a10 10 0 0 1-18.8 4.2"/>
            </svg>
          </button>
          <button id="fpk-close" class="icon-btn" title="Close">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
              <path d="M18 6L6 18M6 6l12 12"/>
            </svg>
          </button>
        </div>
      </div>

      <div id="fpk-loading" class="loading-state">
        <div class="spinner"></div>
        <div id="fpk-status" class="status-text">Loading…</div>
      </div>

      <div id="fpk-progress" class="progress-bar" style="opacity: 0;">
        <div class="progress-track"><div class="progress-fill"></div></div>
        <span class="progress-text">Starting…</span>
      </div>

      <div id="fpk-content" class="panel-content" style="display: none;">
        <!-- Hero Stats -->
        <div class="hero-row">
          <div class="hero-card total">
            <div class="hero-value" id="fpk-total">0</div>
            <div class="hero-label">Total</div>
          </div>
          <div class="hero-card images">
            <div class="hero-value" id="fpk-images">0</div>
            <div class="hero-label">Images</div>
          </div>
          <div class="hero-card videos">
            <div class="hero-value" id="fpk-videos">0</div>
            <div class="hero-label">Videos</div>
          </div>
        </div>

        <div class="scraped-info" id="fpk-scraped-info"></div>

        <!-- Daily Timeline -->
        <div class="chart-card">
          <div class="chart-title">📈 Daily Activity</div>
          <div class="chart-wrap"><canvas id="fpk-daily-chart"></canvas></div>
        </div>

        <!-- Hourly Breakdown -->
        <div class="chart-card">
          <div class="chart-title">🕐 Activity by Hour</div>
          <div class="chart-wrap"><canvas id="fpk-hourly-chart"></canvas></div>
        </div>

        <!-- Type Doughnut -->
        <div class="chart-card">
          <div class="chart-title">🎯 Content Type</div>
          <div class="chart-wrap doughnut-wrap"><canvas id="fpk-type-chart"></canvas></div>
        </div>

        <!-- Project Doughnut -->
        <div class="chart-card">
          <div class="chart-title">📁 By Project</div>
          <div class="chart-wrap doughnut-wrap"><canvas id="fpk-project-chart"></canvas></div>
        </div>

        <!-- Models Breakdown -->
        <div class="chart-card">
          <div class="chart-title">🤖 AI Models <span class="badge" id="fpk-model-count"></span></div>
          <div id="fpk-model-list" class="model-list"></div>
        </div>

        <!-- Providers -->
        <div class="chart-card">
          <div class="chart-title">🏢 Providers</div>
          <div id="fpk-provider-grid" class="provider-grid"></div>
        </div>

        <!-- Tools -->
        <div class="chart-card">
          <div class="chart-title">🛠️ Tools</div>
          <div id="fpk-tool-grid" class="tool-grid"></div>
        </div>
      </div>
    `;
    }

    // ─── Render Dashboard with data ───────────────────
    function renderDashboard(data) {
        // Wait for Chart.js to be available
        waitForChartJS(() => {
            renderHeroStats(data);
            renderScrapedInfo(data);
            renderDailyChart(data.by_date);
            renderHourlyChart(data.by_hour);
            renderTypeChart(data.by_type);
            renderProjectChart(data.by_project);
            renderModelList(data.by_model, data.total);
            renderProviderGrid(data.by_provider, data.total);
            renderToolGrid(data.by_tool);
        });
    }

    function waitForChartJS(callback) {
        // Chart.js is bundled via manifest content_scripts, should already be available
        if (typeof Chart !== 'undefined') {
            callback();
        } else {
            console.warn('Freepik Analytics: Chart.js not available');
        }
    }

    // ─── Chart Color Palette ──────────────────────────
    const COLORS = ['#a855f7', '#06b6d4', '#f43f5e', '#10b981', '#f59e0b', '#3b82f6', '#6366f1', '#ec4899', '#14b8a6', '#f97316', '#84cc16', '#8b5cf6', '#d946ef', '#0ea5e9', '#ef4444', '#eab308'];
    function getColor(i) { return COLORS[i % COLORS.length]; }
    function rgba(hex, a) {
        const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
        return `rgba(${r},${g},${b},${a})`;
    }
    function sortDesc(obj) { return Object.entries(obj).sort((a, b) => b[1] - a[1]); }

    // ─── Hero Stats ───────────────────────────────────
    function renderHeroStats(data) {
        animateCount(shadowRoot.querySelector('#fpk-total'), data.total);
        animateCount(shadowRoot.querySelector('#fpk-images'), data.by_type.image || 0);
        animateCount(shadowRoot.querySelector('#fpk-videos'), data.by_type.video || 0);
    }

    function animateCount(el, target) {
        // Cancel any in-progress animation
        if (el._animFrame) cancelAnimationFrame(el._animFrame);

        const from = el._currentValue || 0;
        if (from === target) return;

        const dur = Math.min(800, Math.max(300, Math.abs(target - from) * 2));
        const start = performance.now();

        function tick(now) {
            const p = Math.min((now - start) / dur, 1);
            const eased = 1 - Math.pow(1 - p, 3);
            const current = Math.round(from + (target - from) * eased);
            el.textContent = current.toLocaleString();
            if (p < 1) {
                el._animFrame = requestAnimationFrame(tick);
            } else {
                el._currentValue = target;
                el._animFrame = null;
            }
        }
        el._animFrame = requestAnimationFrame(tick);
    }

    function renderScrapedInfo(data) {
        const el = shadowRoot.querySelector('#fpk-scraped-info');
        const d = new Date(data.scraped_at);
        el.textContent = `Last updated: ${d.toLocaleDateString()} at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`;
    }

    // ─── Chart Defaults ───────────────────────────────
    function chartDefaults() {
        return {
            responsive: true,
            maintainAspectRatio: false,
            plugins: {
                legend: { display: false },
                tooltip: {
                    backgroundColor: 'rgba(13,13,20,0.95)',
                    titleColor: '#f1f1f6',
                    bodyColor: '#c084fc',
                    borderColor: 'rgba(168,85,247,0.3)',
                    borderWidth: 1,
                    padding: 10,
                    cornerRadius: 6,
                    displayColors: false,
                }
            },
        };
    }

    // ─── Destroy existing chart ───────────────────────
    const chartInstances = {};
    function getOrCreateChart(canvasId, config) {
        if (chartInstances[canvasId]) {
            chartInstances[canvasId].destroy();
        }
        const canvas = shadowRoot.querySelector(`#${canvasId}`);
        if (!canvas) return null;
        const chart = new Chart(canvas, config);
        chartInstances[canvasId] = chart;
        return chart;
    }

    // ─── Daily Chart ──────────────────────────────────
    function renderDailyChart(byDate) {
        const sorted = Object.entries(byDate).sort((a, b) => a[0].localeCompare(b[0]));
        const labels = sorted.map(([d]) => {
            const dt = new Date(d + 'T00:00:00');
            return dt.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        });
        const values = sorted.map(([, v]) => v);
        const max = Math.max(...values);

        getOrCreateChart('fpk-daily-chart', {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    data: values,
                    backgroundColor: values.map(v => {
                        const r = v / max;
                        return r > 0.7 ? rgba('#a855f7', 0.75) : r > 0.4 ? rgba('#6366f1', 0.7) : rgba('#3b82f6', 0.65);
                    }),
                    borderRadius: 3,
                    borderSkipped: false,
                }]
            },
            options: {
                ...chartDefaults(),
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#6b7280', font: { size: 9 }, maxRotation: 50 } },
                    y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#6b7280', font: { size: 9 }, callback: v => v >= 1000 ? (v / 1000).toFixed(1) + 'k' : v } }
                },
                interaction: { intersect: false, mode: 'index' },
                plugins: {
                    ...chartDefaults().plugins,
                    tooltip: { ...chartDefaults().plugins.tooltip, callbacks: { label: ctx => `${ctx.parsed.y.toLocaleString()} generations` } }
                }
            }
        });
    }

    // ─── Hourly Chart ─────────────────────────────────
    function renderHourlyChart(byHour) {
        const labels = [];
        const values = [];
        for (let h = 0; h < 24; h++) {
            labels.push(`${h.toString().padStart(2, '0')}:00`);
            values.push(byHour[h.toString()] || 0);
        }
        const max = Math.max(...values, 1);

        getOrCreateChart('fpk-hourly-chart', {
            type: 'bar',
            data: {
                labels,
                datasets: [{
                    data: values,
                    backgroundColor: values.map(v => {
                        const r = v / max;
                        return r > 0.6 ? rgba('#06b6d4', 0.8) : r > 0.3 ? rgba('#06b6d4', 0.5) : rgba('#06b6d4', 0.25);
                    }),
                    borderRadius: 3,
                    borderSkipped: false,
                }]
            },
            options: {
                ...chartDefaults(),
                scales: {
                    x: { grid: { display: false }, ticks: { color: '#6b7280', font: { size: 8 }, maxRotation: 50 } },
                    y: { beginAtZero: true, grid: { color: 'rgba(255,255,255,0.03)' }, ticks: { color: '#6b7280', font: { size: 9 } } }
                },
                interaction: { intersect: false, mode: 'index' },
                plugins: {
                    ...chartDefaults().plugins,
                    tooltip: { ...chartDefaults().plugins.tooltip, callbacks: { label: ctx => `${ctx.parsed.y.toLocaleString()} generations` } }
                }
            }
        });
    }

    // ─── Type Doughnut ────────────────────────────────
    function renderTypeChart(byType) {
        const entries = sortDesc(byType);
        getOrCreateChart('fpk-type-chart', {
            type: 'doughnut',
            data: {
                labels: entries.map(([k]) => k.charAt(0).toUpperCase() + k.slice(1)),
                datasets: [{
                    data: entries.map(([, v]) => v),
                    backgroundColor: [rgba('#06b6d4', 0.8), rgba('#f43f5e', 0.8)],
                    borderColor: ['#06b6d4', '#f43f5e'],
                    borderWidth: 2,
                    hoverOffset: 4,
                }]
            },
            options: {
                responsive: true,
                cutout: '60%',
                plugins: {
                    legend: { position: 'bottom', labels: { color: '#9ca3af', padding: 12, font: { size: 11 }, usePointStyle: true } },
                    tooltip: { ...chartDefaults().plugins.tooltip, callbacks: { label: ctx => { const t = ctx.dataset.data.reduce((a, b) => a + b, 0); return ` ${ctx.parsed.toLocaleString()} (${((ctx.parsed / t) * 100).toFixed(1)}%)`; } } }
                }
            }
        });
    }

    // ─── Project Doughnut ─────────────────────────────
    function renderProjectChart(byProject) {
        const entries = sortDesc(byProject);
        const colors = ['#a855f7', '#10b981', '#f59e0b', '#3b82f6', '#ec4899'];
        getOrCreateChart('fpk-project-chart', {
            type: 'doughnut',
            data: {
                labels: entries.map(([k]) => k),
                datasets: [{
                    data: entries.map(([, v]) => v),
                    backgroundColor: entries.map((_, i) => rgba(colors[i % colors.length], 0.8)),
                    borderColor: entries.map((_, i) => colors[i % colors.length]),
                    borderWidth: 2,
                    hoverOffset: 4,
                }]
            },
            options: {
                responsive: true,
                cutout: '60%',
                plugins: {
                    legend: { position: 'bottom', labels: { color: '#9ca3af', padding: 12, font: { size: 11 }, usePointStyle: true } },
                    tooltip: { ...chartDefaults().plugins.tooltip, callbacks: { label: ctx => { const t = ctx.dataset.data.reduce((a, b) => a + b, 0); return ` ${ctx.parsed.toLocaleString()} (${((ctx.parsed / t) * 100).toFixed(1)}%)`; } } }
                }
            }
        });
    }

    // ─── Model List ───────────────────────────────────
    function renderModelList(byModel, total) {
        const sorted = sortDesc(byModel);
        const container = shadowRoot.querySelector('#fpk-model-list');
        shadowRoot.querySelector('#fpk-model-count').textContent = `${sorted.length}`;

        const maxVal = sorted[0]?.[1] || 1;
        container.innerHTML = sorted.map(([name, count], i) => {
            const color = getColor(i);
            const pct = ((count / total) * 100).toFixed(1);
            const bw = ((count / maxVal) * 100).toFixed(1);
            const displayName = name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/Unknown Image/g, 'Other / Unknown');
            return `<div class="model-item">
        <span class="model-dot" style="background:${color}"></span>
        <span class="model-name">${displayName}</span>
        <div class="model-bar-track"><div class="model-bar" style="width:${bw}%;background:${color}"></div></div>
        <span class="model-count">${count.toLocaleString()} <span class="model-pct">(${pct}%)</span></span>
      </div>`;
        }).join('');
    }

    // ─── Provider Grid ────────────────────────────────
    function renderProviderGrid(byProvider, total) {
        const sorted = sortDesc(byProvider);
        const container = shadowRoot.querySelector('#fpk-provider-grid');
        container.innerHTML = sorted.map(([name, count]) => {
            const pct = ((count / total) * 100).toFixed(1);
            return `<div class="provider-pill">
        <span class="prov-name">${name}</span>
        <span class="prov-count">${count.toLocaleString()}</span>
        <span class="prov-pct">${pct}%</span>
      </div>`;
        }).join('');
    }

    // ─── Tool Grid ────────────────────────────────────
    const TOOL_ICONS = { 'text-to-image': '✨', 'video-generator': '🎬', 'upload-reference': '📎', 'upload': '📤', 'spaces': '🌐', 'enhance': '🔍', 'talk': '💬' };
    function renderToolGrid(byTool) {
        const sorted = sortDesc(byTool);
        const container = shadowRoot.querySelector('#fpk-tool-grid');
        container.innerHTML = sorted.map(([name, count]) => {
            const icon = TOOL_ICONS[name] || '⚡';
            const display = name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
            return `<div class="tool-item">
        <span class="tool-icon">${icon}</span>
        <div><div class="tool-name">${display}</div><div class="tool-count">${count.toLocaleString()}</div></div>
      </div>`;
        }).join('');
    }

    // ─── Initialize ───────────────────────────────────
    if (document.readyState === 'complete' || document.readyState === 'interactive') {
        init();
    } else {
        document.addEventListener('DOMContentLoaded', init);
    }

    function init() {
        createToggleButton();
        createDashboardContainer();
    }

})();
