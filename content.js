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
    let slotSoundEnabled = false;
    const SLOT_STORAGE_KEY = 'freepikSlotSoundEnabled';

    // Image Board State
    const BOARD_STORAGE_KEY = 'freepikImageBoardData';
    let boardRoot = null;
    let boardShadowRoot = null;
    let isBoardOpen = false;
    let draggedImageUrl = null;
    let draggedBoardItemOffset = null; // Track exact grab point for internal item dragging
    let canvasZoom = 1.0; // Track current zoom level

    let imageBoardData = [];

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
            // Fetch wallet + limits in parallel with first history page
            const [firstRes, walletRes, limitsRes] = await Promise.all([
                fetch(`${API_BASE}?page=1&per_page=${PER_PAGE}`),
                fetch('/pikaso/api/wallet').catch(() => null),
                fetch('/pikaso/api/limits').catch(() => null),
            ]);

            if (!firstRes.ok) throw new Error(`API returned ${firstRes.status}`);
            const firstData = await firstRes.json();

            // Parse wallet data
            let walletData = null;
            if (walletRes && walletRes.ok) {
                try { walletData = await walletRes.json(); } catch (e) { }
            }

            // Parse limits data — build cost lookup map
            let limitsMap = {};
            if (limitsRes && limitsRes.ok) {
                try {
                    const limitsData = await limitsRes.json();
                    if (limitsData.limits) {
                        Object.values(limitsData.limits).forEach(l => {
                            limitsMap[l.key] = { cost: l.cost || 0, unlimited: !!l.unlimitedGenerations, title: l.title || l.key };
                        });
                    }
                } catch (e) { }
            }

            const apiTotal = firstData.meta.pagination.total;
            const lastPage = firstData.meta.pagination.last_page;

            const allItems = [];
            processPage(firstData.data, allItems);

            // Show dashboard immediately with first page of data
            let summary = aggregateData(allItems, apiTotal, walletData, limitsMap);
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
                    summary = aggregateData(allItems, apiTotal, walletData, limitsMap);
                    renderDashboard(summary);
                }
                showProgress(true, p, lastPage);

                // Small delay to avoid rate limiting
                await delay(100);
            }

            // Final render with complete data
            summary = aggregateData(allItems, apiTotal, walletData, limitsMap);
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
                unlimited: item.creation?.metadata?.unlimited ?? null,
            });
        });
    }

    // ─── Aggregate data ───────────────────────────────
    function aggregateData(items, apiTotal, walletData, limitsMap) {
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
            // Credit tracking
            wallet: walletData ? {
                credits: walletData.credits || 0,
                totalCredits: walletData.totalCredits || 0,
                creditsSpend: walletData.creditsSpend || 0,
            } : null,
            limits_map: limitsMap || {},
            unlimited_count: 0,
            paid_count: 0,
            unknown_plan_count: 0,
            estimated_credits_by_model: {},
            total_estimated_credits: 0,
        };

        // Build a rough model-to-limits-key mapping
        const modelCostLookup = buildModelCostLookup(limitsMap);

        items.forEach(item => {
            inc(summary.by_type, item.type);
            inc(summary.by_tool, item.tool_name);
            inc(summary.by_project, item.folder_name);
            inc(summary.by_model, item.model || 'unknown');
            if (item.provider) inc(summary.by_provider, item.provider);

            // Credit split
            if (item.unlimited === true) {
                summary.unlimited_count++;
            } else if (item.unlimited === false) {
                summary.paid_count++;
            } else {
                summary.unknown_plan_count++;
            }

            // Estimate credit cost per model
            const modelKey = item.model || 'unknown';
            const cost = modelCostLookup[modelKey] || 0;
            if (cost > 0) {
                summary.estimated_credits_by_model[modelKey] = (summary.estimated_credits_by_model[modelKey] || 0) + cost;
                summary.total_estimated_credits += cost;
            }

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

    // ─── Model-to-cost lookup builder ─────────────────
    function buildModelCostLookup(limitsMap) {
        // Maps model identifiers from history items to their credit costs
        // The limits API uses keys like 'text-to-image-fast', but history uses model names like 'imagen-nano-banana-2'
        const lookup = {};
        const knownCosts = {
            // Images
            'imagen-nano-banana-2': 50, 'imagen-nano-banana-2-flash': 5, 'imagen-nano-banana': 50,
            'nano-banana-pro': 50, 'seedream-4': 50, 'seedream-4-4k': 100, 'seedream-4-5': 50,
            'flux-2': 10, 'flux-2-max': 50, 'flux-2-klein': 5,
            'gpt-1-5-medium': 50, 'gpt-1-5-high': 100,
            'imagen4-fast': 5, 'imagen4-ultra': 100,
            'ultra': 100, 'grok': 50, 'qwen': 50, 'auto': 50,
            'unknown-image': 50,
            // Videos
            'kling': 200, 'seedance': 200, 'minimax': 200,
            'ltx2': 100, 'wan': 200, 'runway-gen4': 500,
        };

        // Use known costs, override with actual API data where possible
        Object.assign(lookup, knownCosts);

        // Try to match limits entries to model names
        if (limitsMap) {
            Object.entries(limitsMap).forEach(([key, info]) => {
                // Some heuristic matching
                if (key.includes('flux-dev')) lookup['flux-2'] = info.cost;
                if (key.includes('flux-fast')) lookup['flux-2-klein'] = info.cost;
                if (key.includes('kling-std')) lookup['kling'] = info.cost;
                if (key.includes('runway')) lookup['runway-gen4'] = info.cost;
            });
        }

        return lookup;
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
          <div class="slot-toggle" title="Slot machine sound on Generate">
            <span class="slot-icon">🎰</span>
            <label class="toggle-switch">
              <input type="checkbox" id="fpk-slot-toggle">
              <span class="toggle-slider"></span>
            </label>
          </div>
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

        <!-- Wallet / Credit Balance -->
        <div class="chart-card wallet-card" id="fpk-wallet-section">
          <div class="chart-title">💰 Credit Balance</div>
          <div class="wallet-stats">
            <div class="wallet-main">
              <span class="wallet-remaining" id="fpk-credits-remaining">—</span>
              <span class="wallet-separator">/</span>
              <span class="wallet-total" id="fpk-credits-total">—</span>
            </div>
            <div class="wallet-label">credits remaining</div>
            <div class="credit-bar-track">
              <div class="credit-bar-fill" id="fpk-credit-bar"></div>
            </div>
            <div class="wallet-spent-row">
              <span class="wallet-spent-label">Spent:</span>
              <span class="wallet-spent-value" id="fpk-credits-spent">—</span>
            </div>
          </div>
        </div>

        <!-- Unlimited vs Paid Split -->
        <div class="credit-split-row">
          <div class="hero-card unlimited-card">
            <div class="hero-value" id="fpk-unlimited-count">0</div>
            <div class="hero-label">Unlimited</div>
            <div class="plan-badge unlimited-badge">∞ Plan</div>
          </div>
          <div class="hero-card paid-card">
            <div class="hero-value" id="fpk-paid-count">0</div>
            <div class="hero-label">Paid</div>
            <div class="plan-badge paid-badge">💳 Credits</div>
          </div>
        </div>

        <!-- Credits by Model -->
        <div class="chart-card">
          <div class="chart-title">📊 Estimated Credits by Model</div>
          <div id="fpk-credits-model-list" class="model-list"></div>
        </div>

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
            renderWalletCard(data);
            renderCreditSplit(data);
            renderCreditsModelList(data);
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

    // ─── Wallet Card ──────────────────────────────────
    function renderWalletCard(data) {
        const section = shadowRoot.querySelector('#fpk-wallet-section');
        if (!data.wallet) {
            section.style.display = 'none';
            return;
        }
        section.style.display = '';
        const w = data.wallet;
        const remainEl = shadowRoot.querySelector('#fpk-credits-remaining');
        const totalEl = shadowRoot.querySelector('#fpk-credits-total');
        const spentEl = shadowRoot.querySelector('#fpk-credits-spent');
        const barEl = shadowRoot.querySelector('#fpk-credit-bar');

        animateCount(remainEl, w.credits);
        totalEl.textContent = w.totalCredits.toLocaleString();
        spentEl.textContent = w.creditsSpend.toLocaleString();

        const usedPct = w.totalCredits > 0 ? ((w.creditsSpend / w.totalCredits) * 100) : 0;
        barEl.style.width = `${usedPct}%`;

        // Color the bar based on usage
        if (usedPct > 80) {
            barEl.style.background = 'linear-gradient(90deg, #f59e0b, #f43f5e)';
        } else if (usedPct > 50) {
            barEl.style.background = 'linear-gradient(90deg, #a855f7, #f59e0b)';
        } else {
            barEl.style.background = 'linear-gradient(90deg, #10b981, #06b6d4)';
        }
    }

    // ─── Credit Split (Unlimited vs Paid) ─────────────
    function renderCreditSplit(data) {
        animateCount(shadowRoot.querySelector('#fpk-unlimited-count'), data.unlimited_count);
        animateCount(shadowRoot.querySelector('#fpk-paid-count'), data.paid_count);
    }

    // ─── Credits by Model List ────────────────────────
    function renderCreditsModelList(data) {
        const container = shadowRoot.querySelector('#fpk-credits-model-list');
        const entries = Object.entries(data.estimated_credits_by_model || {}).sort((a, b) => b[1] - a[1]);

        if (entries.length === 0) {
            container.innerHTML = '<div style="color:#4b5563;font-size:0.75rem;text-align:center;padding:12px">No credit data available yet</div>';
            return;
        }

        const maxVal = entries[0]?.[1] || 1;
        container.innerHTML = entries.map(([name, credits], i) => {
            const color = getColor(i);
            const bw = ((credits / maxVal) * 100).toFixed(1);
            const displayName = name.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase()).replace(/Unknown Image/g, 'Other / Unknown');
            return `<div class="model-item">
                <span class="model-dot" style="background:${color}"></span>
                <span class="model-name">${displayName}</span>
                <div class="model-bar-track"><div class="model-bar" style="width:${bw}%;background:${color}"></div></div>
                <span class="model-count">${credits.toLocaleString()} <span class="model-pct">credits</span></span>
            </div>`;
        }).join('');
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

    // ─── Slot Machine Sound ───────────────────────
    function initSlotMachineSound() {
        const soundUrl = chrome.runtime.getURL('sounds/slot.mp3');

        // Load saved toggle state
        chrome.storage.local.get([SLOT_STORAGE_KEY], (result) => {
            slotSoundEnabled = result[SLOT_STORAGE_KEY] || false;
            const toggle = shadowRoot?.querySelector('#fpk-slot-toggle');
            if (toggle) toggle.checked = slotSoundEnabled;
        });

        // Listen for generate button clicks (capture phase)
        document.addEventListener('click', function (e) {
            if (!slotSoundEnabled) return;

            const dataCyTarget = e.target.closest('[data-cy="generate-button"]');
            const dataTourTarget = e.target.closest('[data-tour="generate-button"]');
            const buttonTarget = e.target.closest('button');
            const isGenerateText = buttonTarget && buttonTarget.innerText.toLowerCase().includes('generate');

            if (dataCyTarget || dataTourTarget || isGenerateText) {
                const audio = new Audio(soundUrl);
                audio.volume = 0.5;
                audio.play().catch(() => { });
            }
        }, true);
    }

    function bindSlotToggle() {
        const toggle = shadowRoot?.querySelector('#fpk-slot-toggle');
        if (toggle) {
            toggle.addEventListener('change', (e) => {
                slotSoundEnabled = e.target.checked;
                chrome.storage.local.set({ [SLOT_STORAGE_KEY]: slotSoundEnabled });
            });
        }
    }

    // ─── Image Board Feature ──────────────────────────
    function initImageBoard() {
        const trigger = document.createElement('div');
        trigger.id = 'fpk-board-trigger';
        trigger.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"></path><polyline points="13 2 13 9 20 9"></polyline><path d="M9 15h6"></path><path d="M9 11h6"></path></svg>`;
        Object.assign(trigger.style, {
            position: 'fixed',
            right: '0',
            top: '40%',
            transform: 'translateY(-50%)',
            zIndex: '2147483646',
            width: '40px',
            height: '40px',
            background: 'linear-gradient(135deg, #10b981, #06b6d4)',
            borderRadius: '8px 0 0 8px',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            cursor: 'pointer',
            color: '#fff',
            boxShadow: '0 4px 20px rgba(16, 185, 129, 0.4)',
            transition: 'all 0.3s ease',
        });

        trigger.addEventListener('mouseenter', () => openBoard());
        trigger.addEventListener('dragover', (e) => {
            e.preventDefault();
            openBoard();
        });
        document.body.appendChild(trigger);

        boardRoot = document.createElement('div');
        boardRoot.id = 'fpk-image-board-container';
        Object.assign(boardRoot.style, {
            position: 'fixed',
            top: '0',
            right: '0',
            width: '440px', // Default width
            height: '100vh',
            zIndex: '2147483647',
            transform: 'translateX(100%)',
            transition: 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
            overflow: 'hidden',
        });

        // Restore saved width if any
        chrome.storage.local.get(['fpkBoardWidth'], (res) => {
            if (res.fpkBoardWidth) boardRoot.style.width = res.fpkBoardWidth + 'px';
        });

        boardShadowRoot = boardRoot.attachShadow({ mode: 'open' });

        const style = document.createElement('style');
        style.textContent = `
            .board-panel { width: 100%; height: 100vh; background: #0a0a10; border-left: 1px solid rgba(255, 255, 255, 0.06); display: flex; flex-direction: column; font-family: 'Inter', -apple-system, sans-serif; color: #f1f1f6; box-shadow: -8px 0 40px rgba(0, 0, 0, 0.5); }
            .board-header { padding: 16px; border-bottom: 1px solid rgba(255,255,255,0.06); background: rgba(13,13,20,0.95); display: flex; justify-content: space-between; align-items: center; }
            .board-title { font-size: 1rem; font-weight: 700; background: linear-gradient(135deg, #10b981, #06b6d4); -webkit-background-clip: text; -webkit-text-fill-color: transparent; }
            .board-close { background: none; border: none; color: #9ca3af; cursor: pointer; padding: 4px; display: flex; align-items: center; justify-content: center; }
            .board-close:hover { color: #fff; }
            .drawer-resizer { position: absolute; left: 0; top: 0; bottom: 0; width: 6px; cursor: ew-resize; z-index: 99999; }
            .drawer-resizer:hover { background: rgba(16, 185, 129, 0.2); }
            .board-content { flex: 1; overflow: auto; background: rgba(10,10,16,0.95); position: relative; }
            .board-content::-webkit-scrollbar { width: 8px; height: 8px; }
            .board-content::-webkit-scrollbar-track { background: transparent; }
            .board-content::-webkit-scrollbar-thumb { background: rgba(16, 185, 129, 0.3); border-radius: 10px; }
            .drop-zone { position: absolute; top: 16px; left: 16px; right: 16px; z-index: 10000; pointer-events: none; border: 2px dashed rgba(16, 185, 129, 0.3); border-radius: 8px; padding: 30px 20px; text-align: center; color: #9ca3af; transition: opacity 0.2s; opacity: 0; background: rgba(10,10,16,0.9); }
            .drop-zone.drag-over { opacity: 1; border-color: #10b981; color: #10b981; }
            .board-canvas { position: absolute; width: 10000px; height: 10000px; background-image: radial-gradient(rgba(255,255,255,0.15) 1px, transparent 1px); background-size: 30px 30px; cursor: grab; }
            .board-canvas.panning { cursor: grabbing; }
            .board-item { position: absolute; border-radius: 8px; overflow: hidden; background: #1a1a24; border: 1px solid rgba(255,255,255,0.03); box-shadow: 0 4px 12px rgba(0,0,0,0.3); transition: box-shadow 0.2s; user-select: none; }
            .board-item.dragging { box-shadow: 0 12px 24px rgba(0,0,0,0.5); z-index: 9999 !important; border-color: rgba(16, 185, 129, 0.5); }
            .board-item img { width: 100%; height: 100%; object-fit: contain; pointer-events: none; display: block; }
            .board-item .delete-btn { position: absolute; top: 6px; right: 6px; background: rgba(0,0,0,0.6); border: none; color: white; border-radius: 50%; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; cursor: pointer; opacity: 0; transition: opacity 0.2s; padding: 0; z-index: 10; }
            .board-item:hover .delete-btn { opacity: 1; }
            .board-item .delete-btn:hover { background: #ef4444; }
            .resize-handle { position: absolute; bottom: 0; right: 0; width: 20px; height: 20px; cursor: nwse-resize; z-index: 10; opacity: 0; transition: opacity 0.2s; }
            .resize-handle::after { content: ''; position: absolute; right: 4px; bottom: 4px; width: 8px; height: 8px; border-right: 2px solid rgba(255,255,255,0.5); border-bottom: 2px solid rgba(255,255,255,0.5); }
            .board-item:hover .resize-handle { opacity: 1; }
            .zoom-controls { position: absolute; bottom: 16px; left: 50%; transform: translateX(-50%); display: flex; gap: 8px; background: rgba(20,20,30,0.9); padding: 6px; border-radius: 20px; box-shadow: 0 4px 12px rgba(0,0,0,0.5); z-index: 10001; border: 1px solid rgba(255,255,255,0.1); }
            .zoom-btn { background: none; border: none; color: #fff; width: 28px; height: 28px; border-radius: 50%; display: flex; align-items: center; justify-content: center; cursor: pointer; transition: background 0.2s; }
            .zoom-btn:hover { background: rgba(255,255,255,0.1); }
            .zoom-level { color: #fff; font-size: 0.8rem; display: flex; align-items: center; justify-content: center; min-width: 44px; user-select: none; }
            .edge-glow { position: absolute; z-index: 10000; pointer-events: none; opacity: 0; transition: opacity 0.2s; }
            .edge-glow.left { top: 0; bottom: 0; left: 0; width: 60px; background: linear-gradient(to right, rgba(16,185,129,0.15), transparent); }
            .edge-glow.right { top: 0; bottom: 0; right: 0; width: 60px; background: linear-gradient(to left, rgba(16,185,129,0.15), transparent); }
            .edge-glow.top { top: 0; left: 0; right: 0; height: 60px; background: linear-gradient(to bottom, rgba(16,185,129,0.15), transparent); }
            .edge-glow.bottom { bottom: 0; left: 0; right: 0; height: 60px; background: linear-gradient(to top, rgba(16,185,129,0.15), transparent); }
            .edge-glow.active { opacity: 1; }
        `;
        boardShadowRoot.appendChild(style);

        const panel = document.createElement('div');
        panel.className = 'board-panel';
        panel.innerHTML = `
            <div class="drawer-resizer"></div>
            <div class="board-header">
                <div class="board-title">🖼️  Image Board</div>
                <button class="board-close">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
            </div>
            <div class="board-content">
                <div class="board-canvas" id="board-canvas"></div>
                <div class="drop-zone" id="board-drop-zone">
                    Drop images to add to canvas
                </div>
                <div class="edge-glow top"></div>
                <div class="edge-glow right"></div>
                <div class="edge-glow bottom"></div>
                <div class="edge-glow left"></div>
                <div class="zoom-controls">
                    <button class="zoom-btn zoom-out">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                    </button>
                    <div class="zoom-level">100%</div>
                    <button class="zoom-btn zoom-in">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line></svg>
                    </button>
                    <button class="zoom-btn zoom-reset" title="Reset Zoom">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 12a9 9 0 1 0 9-9 9.75 9.75 0 0 0-6.74 2.74L3 8"></path><path d="M3 3v5h5"></path></svg>
                    </button>
                </div>
            </div>
        `;
        boardShadowRoot.appendChild(panel);
        document.body.appendChild(boardRoot);

        chrome.storage.local.get([BOARD_STORAGE_KEY], (res) => {
            imageBoardData = res[BOARD_STORAGE_KEY] || [];
            renderBoardImages();
        });

        boardShadowRoot.querySelector('.board-close').addEventListener('click', closeBoard);

        // Drawer Resizer Logic
        const resizer = boardShadowRoot.querySelector('.drawer-resizer');
        let isResizingDrawer = false;

        resizer.addEventListener('mousedown', (e) => {
            isResizingDrawer = true;
            // Temporarily disable transition during drag for fluid resizing
            boardRoot.style.transition = 'none';
        });

        document.addEventListener('mousemove', (e) => {
            if (!isResizingDrawer) return;
            const newWidth = window.innerWidth - e.clientX;
            // constraints
            if (newWidth > 320 && newWidth < window.innerWidth * 0.9) {
                boardRoot.style.width = newWidth + 'px';
            }
        });

        document.addEventListener('mouseup', () => {
            if (isResizingDrawer) {
                isResizingDrawer = false;
                // Restore transition
                boardRoot.style.transition = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)';
                // Save new width
                chrome.storage.local.set({ fpkBoardWidth: parseInt(boardRoot.style.width, 10) });
            }
        });

        boardRoot.addEventListener('mouseleave', () => {
            if (!draggedImageUrl && !isResizingDrawer) closeBoard();
        });

        let leaveTimeout;
        document.addEventListener('mousemove', (e) => {
            if (isBoardOpen && !draggedImageUrl) {
                if (e.clientX < window.innerWidth - 460) {
                    if (!leaveTimeout) leaveTimeout = setTimeout(() => closeBoard(), 300);
                } else {
                    clearTimeout(leaveTimeout);
                    leaveTimeout = null;
                }
            }
        });

        const dropZone = boardShadowRoot.querySelector('#board-drop-zone');
        const contentArea = boardShadowRoot.querySelector('.board-content');
        const panCanvas = boardShadowRoot.querySelector('#board-canvas');

        // Zoom Logic
        const zoomLevelEl = boardShadowRoot.querySelector('.zoom-level');
        const updateZoom = (newZoom) => {
            canvasZoom = Math.min(Math.max(newZoom, 0.2), 3.0); // Limit 20% to 300%
            zoomLevelEl.textContent = Math.round(canvasZoom * 100) + '%';
            panCanvas.style.zoom = canvasZoom;
        };

        boardShadowRoot.querySelector('.zoom-in').addEventListener('click', () => updateZoom(canvasZoom + 0.1));
        boardShadowRoot.querySelector('.zoom-out').addEventListener('click', () => updateZoom(canvasZoom - 0.1));
        boardShadowRoot.querySelector('.zoom-reset').addEventListener('click', () => updateZoom(1.0));

        contentArea.addEventListener('wheel', (e) => {
            if (e.ctrlKey || e.metaKey) {
                e.preventDefault();
                const delta = e.deltaY > 0 ? -0.1 : 0.1;
                updateZoom(canvasZoom + delta);
            }
        });

        // Panning Logic
        let isPanning = false;
        let startPanX, startPanY, startScrollLeft, startScrollTop;

        panCanvas.addEventListener('mousedown', (e) => {
            // Only pan on middle click OR if clicking directly on the canvas background
            if (e.target.id === 'board-canvas' || e.button === 1) {
                isPanning = true;
                startPanX = e.clientX;
                startPanY = e.clientY;
                startScrollLeft = contentArea.scrollLeft;
                startScrollTop = contentArea.scrollTop;
                panCanvas.classList.add('panning');
                e.preventDefault(); // Prevent text selection
            }
        });

        window.addEventListener('mousemove', (e) => {
            if (isPanning) {
                const dx = e.clientX - startPanX;
                const dy = e.clientY - startPanY;
                contentArea.scrollLeft = startScrollLeft - dx;
                contentArea.scrollTop = startScrollTop - dy;
            }
        });

        window.addEventListener('mouseup', () => {
            if (isPanning) {
                isPanning = false;
                panCanvas.classList.remove('panning');
            }
        });

        // Edge Auto-Scrolling Logic
        let autoScrollScrollDirX = 0;
        let autoScrollScrollDirY = 0;
        let autoScrollAnimationFrame = null;

        const glowTop = boardShadowRoot.querySelector('.edge-glow.top');
        const glowBottom = boardShadowRoot.querySelector('.edge-glow.bottom');
        const glowLeft = boardShadowRoot.querySelector('.edge-glow.left');
        const glowRight = boardShadowRoot.querySelector('.edge-glow.right');

        function updateEdgeScrolling(clientX, clientY) {
            const rect = contentArea.getBoundingClientRect();
            const threshold = 60; // distance from edge to trigger scroll

            // Only trigger if mouse is inside the board panel X bounds
            if (clientX < rect.left || clientX > rect.right) {
                stopEdgeScrolling();
                return;
            }

            let scX = 0, scY = 0;

            // Y checks
            if (clientY < rect.top + threshold && clientY >= rect.top) { scY = -1; glowTop.classList.add('active'); }
            else { glowTop.classList.remove('active'); }

            if (clientY > rect.bottom - threshold && clientY <= rect.bottom) { scY = 1; glowBottom.classList.add('active'); }
            else { glowBottom.classList.remove('active'); }

            // X checks
            if (clientX < rect.left + threshold && clientX >= rect.left) { scX = -1; glowLeft.classList.add('active'); }
            else { glowLeft.classList.remove('active'); }

            if (clientX > rect.right - threshold && clientX <= rect.right) { scX = 1; glowRight.classList.add('active'); }
            else { glowRight.classList.remove('active'); }

            if (scX !== 0 || scY !== 0) {
                autoScrollScrollDirX = scX;
                autoScrollScrollDirY = scY;
                if (!autoScrollAnimationFrame) requestAnimationFrame(performEdgeScroll);
            } else {
                autoScrollScrollDirX = 0;
                autoScrollScrollDirY = 0;
            }
        }

        function performEdgeScroll() {
            if (autoScrollScrollDirX === 0 && autoScrollScrollDirY === 0) {
                autoScrollAnimationFrame = null;
                return;
            }
            contentArea.scrollBy({ left: autoScrollScrollDirX * 15, top: autoScrollScrollDirY * 15 });
            autoScrollAnimationFrame = requestAnimationFrame(performEdgeScroll);
        }

        function stopEdgeScrolling() {
            autoScrollScrollDirX = 0;
            autoScrollScrollDirY = 0;
            glowTop.classList.remove('active');
            glowBottom.classList.remove('active');
            glowLeft.classList.remove('active');
            glowRight.classList.remove('active');
        }

        boardRoot.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.stopPropagation();
            dropZone.classList.add('drag-over');
            updateEdgeScrolling(e.clientX, e.clientY);
        });

        const hideDropZone = () => {
            dropZone.classList.remove('drag-over');
            stopEdgeScrolling();
        };
        boardRoot.addEventListener('dragleave', hideDropZone);
        boardRoot.addEventListener('dragend', hideDropZone);

        boardRoot.addEventListener('drop', (e) => {
            e.preventDefault();
            e.stopPropagation();
            hideDropZone();

            // Calculate drop position relative to the canvas
            const canvas = boardShadowRoot.querySelector('#board-canvas');
            const rect = canvas.getBoundingClientRect();

            // The drop coordinates inside the infinite canvas
            // e.clientX is relative to viewport. rect.left is the canvas's current viewport X.
            // Under `zoom`, rect values are pre-scaled, but CSS pixels internally are unscaled.
            // Dividing the viewport delta by canvasZoom converts it to native canvas coordinates.
            let dropX = (e.clientX - rect.left) / canvasZoom;
            let dropY = (e.clientY - rect.top) / canvasZoom;

            if (draggedBoardItemOffset) {
                // Preserved precise grab coordinate, also divide offset by zoom
                dropX -= (draggedBoardItemOffset.x / canvasZoom);
                dropY -= (draggedBoardItemOffset.y / canvasZoom);
                draggedBoardItemOffset = null;
            } else {
                // Offset by half the default image width (180/2 = 90)
                dropX -= 90;
                dropY -= 90;
            }

            // Constrain to canvas bounds
            if (dropX < 0) dropX = 0;
            if (dropY < 0) dropY = 0;

            if (draggedImageUrl) {
                saveImageToBoard(draggedImageUrl, dropX, dropY);
                draggedImageUrl = null;
            } else {
                const url = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain');
                if (url && (url.startsWith('http') || url.startsWith('data:image'))) {
                    saveImageToBoard(url, dropX, dropY);
                }
            }
        });

        document.addEventListener('dragstart', (e) => {
            const img = e.target;
            if (img.tagName === 'IMG' && img.src) {
                const feedItem = img.closest('div[data-cy="image-creation-feed-item"]');
                if (feedItem || img.classList.contains('object-cover')) {
                    // Force the high-res variation by replacing preview query params
                    let highResUrl = img.src.replace('preview=true', 'preview=false');
                    draggedImageUrl = highResUrl;
                    try { e.dataTransfer.setData('text/plain', highResUrl); } catch (err) { }
                }
            }
        });

        document.addEventListener('dragend', () => {
            draggedImageUrl = null;
            setTimeout(() => { if (isBoardOpen) closeBoard(); }, 500);
        });
    }

    function openBoard() {
        if (!isBoardOpen) {
            isBoardOpen = true;
            if (boardRoot) boardRoot.style.transform = 'translateX(0)';

            // Scroll to center content
            setTimeout(() => {
                const content = boardShadowRoot.querySelector('.board-content');
                if (content && imageBoardData.length > 0) {
                    // Find bounds to perfectly center on existing items
                    let minX = 10000, minY = 10000;
                    imageBoardData.forEach(d => {
                        if (d.x < minX) minX = d.x;
                        if (d.y < minY) minY = d.y;
                    });

                    // Center the viewport over the top-left-most item (with padding)
                    // If no scrolling has happened yet (0), jump to items
                    if (content.scrollLeft === 0 && content.scrollTop === 0) {
                        content.scrollLeft = Math.max(0, minX - 100);
                        content.scrollTop = Math.max(0, minY - 100);
                    }
                } else if (content && content.scrollLeft === 0) {
                    // Center of canvas if completely empty
                    content.scrollLeft = 4800;
                    content.scrollTop = 4800;
                }
            }, 300); // Wait for open transition to finish before measuring fully
        }
    }

    function closeBoard() {
        if (isBoardOpen) {
            isBoardOpen = false;
            if (boardRoot) boardRoot.style.transform = 'translateX(100%)';
        }
    }

    function saveImageToBoard(url, x = 20, y = 20) {
        // Find max zIndex to bring to front
        let maxZ = 0;
        imageBoardData.forEach(item => {
            const z = (typeof item === 'object' && item.zIndex) ? item.zIndex : 0;
            if (z > maxZ) maxZ = z;
        });

        // Handle legacy data / duplicates
        const existingIdx = imageBoardData.findIndex(item => {
            if (typeof item === 'string') return item === url;
            return item.url === url;
        });

        if (existingIdx === -1) {
            imageBoardData.push({
                url: url,
                x: x,
                y: y, // dropY already accounts for scrollTop via getBoundingClientRect delta
                width: 180, // Default width
                zIndex: maxZ + 1
            });
            chrome.storage.local.set({ [BOARD_STORAGE_KEY]: imageBoardData });
            renderBoardImages();
        } else {
            // If it already exists, just bring it to front and maybe move it
            const item = imageBoardData[existingIdx];
            if (typeof item === 'object') {
                item.x = x;
                item.y = y;
                item.zIndex = maxZ + 1;
                chrome.storage.local.set({ [BOARD_STORAGE_KEY]: imageBoardData });
                renderBoardImages();
            }
        }
    }

    function removeImageFromBoard(index) {
        imageBoardData.splice(index, 1);
        chrome.storage.local.set({ [BOARD_STORAGE_KEY]: imageBoardData });
        renderBoardImages();
    }

    function renderBoardImages() {
        if (!boardShadowRoot) return;
        const canvas = boardShadowRoot.querySelector('#board-canvas');
        if (!canvas) return;
        canvas.innerHTML = '';

        // Migrate legacy simple string URLs to objects if needed
        let needsMigration = false;
        imageBoardData = imageBoardData.map((item, i) => {
            if (typeof item === 'string') {
                needsMigration = true;
                return { url: item, x: 5000 + (i % 2) * 200 + 10, y: 5000 + Math.floor(i / 2) * 200 + 10, width: 180, zIndex: i };
            }
            return item;
        });

        // Ensure all existing items are shifted into the infinite space (not stuck at 0,0)
        let minX = 10000, minY = 10000;
        imageBoardData.forEach(item => {
            if (item.x < minX) minX = item.x;
            if (item.y < minY) minY = item.y;
        });

        // If items are trapped at top left (x < 1000), shift them to the center of 10000x10000 canvas
        if (imageBoardData.length > 0 && (minX < 1000 || minY < 1000)) {
            needsMigration = true;
            const shiftX = Math.max(0, 5000 - minX);
            const shiftY = Math.max(0, 5000 - minY);
            imageBoardData.forEach(item => {
                item.x += shiftX;
                item.y += shiftY;
            });
        }

        if (needsMigration) {
            chrome.storage.local.set({ [BOARD_STORAGE_KEY]: imageBoardData });
        }

        imageBoardData.forEach((item, i) => {
            const el = document.createElement('div');
            el.className = 'board-item';

            // Set position and size
            el.style.left = `${item.x}px`;
            el.style.top = `${item.y}px`;
            el.style.width = `${item.width}px`;
            el.style.zIndex = item.zIndex || i;

            el.innerHTML = `
                <img src="${item.url}" loading="lazy" />
                <button class="delete-btn" title="Remove" data-index="${i}">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M18 6L6 18M6 6l12 12"/></svg>
                </button>
                <div class="resize-handle"></div>
            `;

            el.querySelector('.delete-btn').addEventListener('click', (e) => {
                e.stopPropagation();
                removeImageFromBoard(i);
            });

            const img = el.querySelector('img');

            el.addEventListener('mousedown', (e) => {
                // If clicking delete btn or resize handle, ignore
                if (e.target.closest('.delete-btn') || e.target.closest('.resize-handle')) return;

                // Allow left click only for dragging
                if (e.button !== 0) return;

                // Bring to front
                let maxZ = 0;
                imageBoardData.forEach(d => { if (d.zIndex > maxZ) maxZ = d.zIndex || 0; });
                item.zIndex = maxZ + 1;
                el.style.zIndex = item.zIndex;
            });

            // Custom Resize Logic
            const resizeHandle = el.querySelector('.resize-handle');
            resizeHandle.addEventListener('mousedown', (e) => {
                e.stopPropagation();
                e.preventDefault();

                if (e.button !== 0) return;

                let isResizing = true;
                let startX = e.clientX;
                let startWidth = item.width;

                // Using maxZ to bring to front while resizing too
                let maxZ = 0;
                imageBoardData.forEach(d => { if (d.zIndex > maxZ) maxZ = d.zIndex || 0; });
                item.zIndex = maxZ + 1;
                el.style.zIndex = item.zIndex;

                el.classList.add('dragging'); // Gives visual feedback

                const onResizeMove = (moveEvent) => {
                    if (!isResizing) return;
                    const dx = moveEvent.clientX - startX;
                    let newWidth = startWidth + dx;

                    // Min width constraint
                    if (newWidth < 60) newWidth = 60;
                    // Note: We don't limit max width, user can resize as large as they want

                    el.style.width = `${newWidth}px`;
                };

                const onResizeUp = (upEvent) => {
                    if (isResizing) {
                        isResizing = false;
                        el.classList.remove('dragging');

                        item.width = parseInt(el.style.width, 10);
                        chrome.storage.local.set({ [BOARD_STORAGE_KEY]: imageBoardData });
                    }

                    document.removeEventListener('mousemove', onResizeMove);
                    document.removeEventListener('mouseup', onResizeUp);
                };

                document.addEventListener('mousemove', onResizeMove);
                document.addEventListener('mouseup', onResizeUp);
            });

            // Add native dragstart for dragging out of the board back to host page OR internal dragging
            el.addEventListener('dragstart', (e) => {
                // If they are resizing, don't trigger native drag
                if (e.target.closest('.resize-handle')) return e.preventDefault();

                // Store precise offset of where user clicked on the image to eliminate jitter on drop
                const elRect = el.getBoundingClientRect();
                draggedBoardItemOffset = {
                    x: e.clientX - elRect.left,
                    y: e.clientY - elRect.top
                };

                // WORKAROUND: Chrome Native Drag Ghost Offset Bug
                // Chrome's drag rendering calculates ghost offsets incorrectly when
                // elements are inside `overflow: scroll` or `zoom` containers.
                // We manually enforce the ghost image origin mapping using unscaled CSS pixels.
                try {
                    const ghostX = draggedBoardItemOffset.x / canvasZoom;
                    const ghostY = draggedBoardItemOffset.y / canvasZoom;
                    e.dataTransfer.setDragImage(el, ghostX, ghostY);
                } catch (err) { }

                e.dataTransfer.effectAllowed = 'copyMove';

                // Extract Freepik Image ID and Identifier from URL if possible
                let imageId = 0;
                let identifier = "customUrl";
                try {
                    const match = item.url.match(/\/production\/(\d+)\//);
                    if (match && match[1]) {
                        imageId = parseInt(match[1], 10);
                        identifier = match[1];
                    }
                } catch (err) { }

                try {
                    e.dataTransfer.setData('text/plain', item.url);
                    e.dataTransfer.setData('text/uri-list', item.url);
                    e.dataTransfer.setData('text/html', `<img src="${item.url}" />`);

                    if (imageId) {
                        const pikasoData = {
                            id: imageId,
                            identifier: identifier,
                            url: item.url,
                            name: "pikaso-image",
                            tool: "text-to-image",
                            type: "image"
                        };
                        e.dataTransfer.setData('application/pikaso-image-data', JSON.stringify(pikasoData));

                        const jsonData = {
                            type: "mixed",
                            files: [imageId],
                            folders: [],
                            fileType: "file"
                        };
                        e.dataTransfer.setData('application/json', JSON.stringify(jsonData));
                        e.dataTransfer.setData('application/pikaso-internal', "true");
                    }
                } catch (err) { }
            });

            // Note: To enable dragging native elements internally and out, 
            // we must enable draggable on the container itself.
            el.draggable = true;

            canvas.appendChild(el);
        });
    }

    function init() {
        createToggleButton();
        createDashboardContainer();
        initSlotMachineSound();
        bindSlotToggle();
        initImageBoard();
    }

})();
