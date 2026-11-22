// backend/public/number-guess/app.js
(() => {
  const API_BASE = '/api/ng-admin';
  const TOKEN_KEY = 'ng_admin_token';

  const state = {
    token: localStorage.getItem(TOKEN_KEY) || '',
    admin: null,
    activeTab: 'dashboard',
    liveInterval: null,
    filters: {
      dashFrom: '',
      dashTo: '',
      histStatus: '',
      histSearch: '',
      histFrom: '',
      histTo: '',
      histPage: 1,
      txType: '',
      txUserId: '',
      txSandbox: '',
      txPage: 1,
      playerSearch: '',
    },
  };

  const TAB_META = {
    dashboard: ['Dashboard', 'Real-time operational overview & revenue metrics'],
    'live-matches': ['Live Matches', 'Real-time active rooms, Auto/Manual start control & refunds'],
    'match-history': ['Match History', 'Completed & refunded production matches with audit records'],
    matchmaking: ['Matchmaking Settings', 'Queue timeouts, min/max seats, bot fill & refund rules'],
    bots: ['Bot Management', 'Configure bot profiles, strategies, virtual wallets & limits'],
    players: ['Player Management', 'Search players, inspect dossiers, flag or apply restrictions'],
    'game-config': ['Game Configuration', 'Entry fees, round timers & dynamic platform fee tiers'],
    coins: ['Coin Management', 'Production coin flows vs isolated bot/sandbox pools'],
    transactions: ['Transactions', 'Full idempotent ledger across production, bots & sandbox'],
    sandbox: ['Sandbox Testing', 'Private manual-number simulation, ties & virtual coins'],
    logs: ['Admin Activity Logs', 'Immutable audit trail of all admin actions'],
    settings: ['Settings', 'General configuration, defaults & admin session'],
  };

  function esc(val) {
    if (val === null || val === undefined) return '';
    return String(val)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function fmtNum(n) {
    return Number(n || 0).toLocaleString();
  }

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return esc(iso);
    return d.toLocaleString();
  }

  function statusPill(status) {
    const s = String(status || '').toUpperCase();
    const map = {
      WAITING: 'pill-amber',
      FILLING_BOTS: 'pill-cyan',
      STARTING: 'pill-blue',
      ACTIVE: 'pill-green',
      COMPLETED: 'pill-green',
      CANCELLED: 'pill-red',
      REFUNDED: 'pill-red',
    };
    return `<span class="pill ${map[s] || 'pill-blue'}">${esc(s)}</span>`;
  }

  function toast(msg, type = 'ok') {
    const c = document.getElementById('toast-container');
    const el = document.createElement('div');
    el.className = `toast ${type}`;
    el.textContent = msg;
    c.appendChild(el);
    setTimeout(() => el.remove(), 3500);
  }

  async function api(path, opts = {}) {
    const headers = { 'Content-Type': 'application/json', ...(opts.headers || {}) };
    if (state.token) headers.Authorization = `Bearer ${state.token}`;

    const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
    const data = await res.json().catch(() => ({}));
    if (res.status === 401 && !path.startsWith('/auth/login')) {
      logout();
      throw new Error('Session expired. Please sign in again.');
    }
    if (!res.ok) {
      throw new Error(data.error || `Request failed (${res.status})`);
    }
    return data;
  }

  function openModal(title, html) {
    document.getElementById('modal-title').textContent = title;
    document.getElementById('modal-body').innerHTML = html;
    document.getElementById('modal-backdrop').classList.remove('hidden');
  }

  function closeModal() {
    document.getElementById('modal-backdrop').classList.add('hidden');
  }

  function logout() {
    stopLivePolling();
    state.token = '';
    state.admin = null;
    localStorage.removeItem(TOKEN_KEY);
    document.getElementById('app-shell').classList.add('hidden');
    document.getElementById('login-screen').classList.remove('hidden');
  }

  function stopLivePolling() {
    if (state.liveInterval) {
      clearInterval(state.liveInterval);
      state.liveInterval = null;
    }
    document.getElementById('live-indicator').classList.add('hidden');
  }

  async function switchTab(tab) {
    stopLivePolling();
    state.activeTab = tab;

    document.querySelectorAll('#sidebar-nav .nav-item').forEach((b) => {
      b.classList.toggle('active', b.dataset.tab === tab);
    });

    const [title, sub] = TAB_META[tab] || ['Admin', ''];
    document.getElementById('page-title').textContent = title;
    document.getElementById('page-subtitle').textContent = sub;

    await renderActiveTab();

    if (tab === 'live-matches') {
      document.getElementById('live-indicator').classList.remove('hidden');
      state.liveInterval = setInterval(() => {
        if (state.activeTab === 'live-matches') renderLiveMatches(true);
      }, 3000);
    }
  }

  async function renderActiveTab() {
    const container = document.getElementById('tab-content');
    container.innerHTML = `<div class="muted">Loading...</div>`;
    try {
      switch (state.activeTab) {
        case 'dashboard': return await renderDashboard();
        case 'live-matches': return await renderLiveMatches(false);
        case 'match-history': return await renderMatchHistory();
        case 'matchmaking': return await renderMatchmakingSettings();
        case 'bots': return await renderBots();
        case 'players': return await renderPlayers();
        case 'game-config': return await renderGameConfig();
        case 'coins': return await renderCoins();
        case 'transactions': return await renderTransactions();
        case 'sandbox': return await renderSandbox();
        case 'logs': return await renderLogs();
        case 'settings': return await renderSettings();
      }
    } catch (err) {
      container.innerHTML = `<div class="error-box">${esc(err.message)}</div>`;
    }
  }

  // =========================================================================
  // 1. Dashboard
  // =========================================================================
  async function renderDashboard() {
    const qs = new URLSearchParams();
    if (state.filters.dashFrom) qs.set('from', state.filters.dashFrom);
    if (state.filters.dashTo) qs.set('to', state.filters.dashTo);

    const { stats } = await api(`/dashboard?${qs.toString()}`);

    document.getElementById('tab-content').innerHTML = `
      <div class="card">
        <div class="toolbar">
          <label><span>From Date</span><input type="date" id="dash-from" value="${esc(state.filters.dashFrom)}" /></label>
          <label><span>To Date</span><input type="date" id="dash-to" value="${esc(state.filters.dashTo)}" /></label>
          <button class="btn btn-primary" id="dash-apply">Apply Filter</button>
          <button class="btn btn-secondary" id="dash-clear">Clear</button>
        </div>
      </div>

      <div class="grid-stats">
        <div class="stat-card"><div class="stat-label">Total Matches</div><div class="stat-value">${fmtNum(stats.totalMatches)}</div></div>
        <div class="stat-card"><div class="stat-label">Waiting Matches</div><div class="stat-value" style="color:var(--amber)">${fmtNum(stats.waitingMatches)}</div></div>
        <div class="stat-card"><div class="stat-label">Starting Matches</div><div class="stat-value" style="color:var(--cyan)">${fmtNum(stats.startingMatches)}</div></div>
        <div class="stat-card"><div class="stat-label">Active Matches</div><div class="stat-value" style="color:var(--green)">${fmtNum(stats.activeMatches)}</div></div>
        <div class="stat-card"><div class="stat-label">Completed Matches</div><div class="stat-value">${fmtNum(stats.completedMatches)}</div></div>
        <div class="stat-card"><div class="stat-label">Cancelled / Refunded</div><div class="stat-value" style="color:var(--red)">${fmtNum(stats.cancelledMatches)}</div></div>
        <div class="stat-card"><div class="stat-label">Real Participants</div><div class="stat-value">${fmtNum(stats.realParticipants)}</div></div>
        <div class="stat-card"><div class="stat-label">Bot Participants</div><div class="stat-value">${fmtNum(stats.botParticipants)}</div></div>
        <div class="stat-card"><div class="stat-label">Total Real Entry Coins</div><div class="stat-value">${fmtNum(stats.totalEntryCoins)}</div></div>
        <div class="stat-card"><div class="stat-label">Total Real Prize Coins</div><div class="stat-value">${fmtNum(stats.totalPrizeCoins)}</div></div>
        <div class="stat-card"><div class="stat-label">Net Platform Fee Revenue</div><div class="stat-value" style="color:var(--green)">${fmtNum(stats.platformFeeRevenue)}</div><div class="stat-sub">Gross pool fees: ${fmtNum(stats.theoreticalFeeCoins)}</div></div>
        <div class="stat-card"><div class="stat-label">Total Refunds</div><div class="stat-value">${fmtNum(stats.totalRefunds)}</div></div>
        <div class="stat-card"><div class="stat-label">Available Bots</div><div class="stat-value">${fmtNum(stats.availableBots)}</div></div>
      </div>
    `;

    document.getElementById('dash-apply').onclick = () => {
      state.filters.dashFrom = document.getElementById('dash-from').value;
      state.filters.dashTo = document.getElementById('dash-to').value;
      renderDashboard();
    };
    document.getElementById('dash-clear').onclick = () => {
      state.filters.dashFrom = '';
      state.filters.dashTo = '';
      renderDashboard();
    };
  }

  // =========================================================================
  // 2. Live Matches (Includes Auto / Manual Start Mode + Start Match Button)
  // =========================================================================
  async function renderLiveMatches(silent) {
    const [{ matches }, { settings }] = await Promise.all([
      api('/matches/live'),
      api('/settings'),
    ]);
    const el = document.getElementById('tab-content');
    const mode = settings.match_start_mode === 'MANUAL' ? 'MANUAL' : 'AUTO';

    const rowsHtml = matches.length
      ? matches
          .map((m) => {
            const canStart = ['WAITING', 'FILLING_BOTS'].includes(m.status);
            return `
          <tr>
            <td><code>${esc(m.id.slice(0, 8))}…</code></td>
            <td><strong>${esc(m.roomCode)}</strong></td>
            <td>${fmtNum(m.entryFee)}</td>
            <td>${m.participantCount}</td>
            <td>${m.realPlayerCount}</td>
            <td>${m.botCount}</td>
            <td>${fmtNum(m.totalPrizePool)}</td>
            <td>${fmtNum(m.platformFeeCoins)} (${m.feePercent}%)</td>
            <td>${statusPill(m.status)}</td>
            <td>${fmtDate(m.createdAt)}</td>
            <td><strong>${m.remainingSec}s</strong></td>
            <td>
              ${canStart ? `<button class="btn btn-success btn-sm" data-start-match="${esc(m.id)}">Start Match</button>` : ''}
              <button class="btn btn-secondary btn-sm" data-view-match="${esc(m.id)}">View</button>
              <button class="btn btn-danger btn-sm" data-cancel-match="${esc(m.id)}">Cancel & Refund</button>
            </td>
          </tr>`;
          })
          .join('')
      : `<tr><td colspan="12" class="muted">No active or waiting production matches right now.</td></tr>`;

    if (!silent || !el.querySelector('#live-matches-tbody')) {
      el.innerHTML = `
        <div class="card">
          <div class="card-header">
            <div>
              <div class="card-title">Live Production Matches (${matches.length})</div>
              <span class="muted">Production secret numbers are server-generated and sealed until match completion</span>
            </div>
            <div style="display:flex; align-items:center; gap:10px;">
              <span class="muted">Start Mode:</span>
              <select id="live-start-mode">
                <option value="AUTO" ${mode === 'AUTO' ? 'selected' : ''}>Automatic Start</option>
                <option value="MANUAL" ${mode === 'MANUAL' ? 'selected' : ''}>Manual Admin Start</option>
              </select>
            </div>
          </div>
          <div class="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Match ID</th><th>Room</th><th>Entry</th><th>Players</th>
                  <th>Humans</th><th>Bots</th><th>Prize Pool</th><th>Platform Fee</th>
                  <th>Status</th><th>Created</th><th>Timer</th><th>Actions</th>
                </tr>
              </thead>
              <tbody id="live-matches-tbody">${rowsHtml}</tbody>
            </table>
          </div>
        </div>
      `;

      document.getElementById('live-start-mode').onchange = async (e) => {
        try {
          await api('/settings', {
            method: 'PUT',
            body: JSON.stringify({ match_start_mode: e.target.value }),
          });
          toast(`Match start mode switched to ${e.target.value}.`);
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    } else {
      el.querySelector('#live-matches-tbody').innerHTML = rowsHtml;
    }

    el.querySelectorAll('[data-start-match]').forEach((btn) => {
      btn.onclick = async () => {
        try {
          await api(`/matches/${encodeURIComponent(btn.dataset.startMatch)}/start`, {
            method: 'POST',
          });
          toast('Match started with server RNG!');
          renderLiveMatches(false);
        } catch (err) {
          toast(err.message, 'err');
        }
      };
    });
    el.querySelectorAll('[data-view-match]').forEach((btn) => {
      btn.onclick = () => showMatchDetailsModal(btn.dataset.viewMatch);
    });
    el.querySelectorAll('[data-cancel-match]').forEach((btn) => {
      btn.onclick = () => cancelMatchPrompt(btn.dataset.cancelMatch);
    });
  }

  async function showMatchDetailsModal(matchId) {
    try {
      const { match, participants, ledger } = await api(`/matches/${encodeURIComponent(matchId)}`);
      const secretDisplay =
        match.secret_number !== null && match.secret_number !== undefined
          ? `<strong>${match.secret_number}</strong> (${esc(match.secret_mode)})`
          : `<span class="pill pill-amber">HIDDEN UNTIL COMPLETED</span>`;

      const pRows = participants
        .map(
          (p) => `
          <tr>
            <td>${p.user_id || p.bot_id || p.sandbox_account_id || '—'}</td>
            <td>${esc(p.avatar)} ${esc(p.username)}</td>
            <td>${p.participant_type === 'BOT' ? '<span class="pill pill-cyan">BOT</span>' : esc(p.participant_type)}</td>
            <td>${fmtDate(p.joined_at)}</td>
            <td>${fmtNum(p.entry_paid)}</td>
            <td>${p.guess !== null ? '<span class="pill pill-green">SUBMITTED</span>' : '<span class="pill pill-amber">PENDING</span>'}</td>
            <td><strong>${p.guess !== null ? p.guess : '—'}</strong></td>
            <td>${fmtDate(p.guess_submitted_at)}</td>
            <td>${p.diff !== null ? p.diff : '—'}</td>
            <td>${p.is_winner ? `<span class="pill pill-green">WINNER (+${fmtNum(p.payout_coins)})</span>` : p.refunded ? '<span class="pill pill-red">REFUNDED</span>' : '—'}</td>
          </tr>`
        )
        .join('');

      const lRows = ledger
        .map(
          (l) => `
          <tr>
            <td>${esc(l.tx_type)}</td>
            <td>${esc(l.participant_type)}</td>
            <td>${fmtNum(l.amount)}</td>
            <td>${esc(l.note)}</td>
            <td>${fmtDate(l.created_at)}</td>
          </tr>`
        )
        .join('');

      openModal(
        `Match ${match.room_code} (${match.status})`,
        `
        <div class="grid-stats">
          <div class="stat-card"><div class="stat-label">Match ID</div><div style="font-size:12px"><code>${esc(match.id)}</code></div></div>
          <div class="stat-card"><div class="stat-label">Secret Number</div><div class="stat-value">${secretDisplay}</div></div>
          <div class="stat-card"><div class="stat-label">Pool / Fee / Prize</div><div>${fmtNum(match.total_pool)} / ${fmtNum(match.platform_fee_coins)} (${match.fee_percent}%) / <strong>${fmtNum(match.prize_pool_coins)}</strong></div></div>
          <div class="stat-card"><div class="stat-label">Duration</div><div>${match.durationSec !== null ? match.durationSec + 's' : 'In progress'}</div></div>
        </div>
        ${match.cancel_reason ? `<div class="error-box" style="margin-bottom:12px">Cancel Reason: ${esc(match.cancel_reason)}</div>` : ''}
        <h4 style="margin:10px 0 8px">Participants</h4>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>ID</th><th>Username</th><th>Type</th><th>Joined</th><th>Entry</th><th>Status</th><th>Guess</th><th>Submitted</th><th>Diff</th><th>Result</th></tr>
            </thead>
            <tbody>${pRows}</tbody>
          </table>
        </div>
        <h4 style="margin:16px 0 8px">Audit Ledger</h4>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Type</th><th>Actor</th><th>Amount</th><th>Note</th><th>Time</th></tr></thead>
            <tbody>${lRows || '<tr><td colspan="5" class="muted">No ledger rows</td></tr>'}</tbody>
          </table>
        </div>
      `
      );
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  async function cancelMatchPrompt(matchId) {
    const reason = prompt('Enter reason for cancelling and refunding all participants:', 'Cancelled by administrator');
    if (reason === null) return;
    try {
      await api(`/matches/${encodeURIComponent(matchId)}/cancel`, {
        method: 'POST',
        body: JSON.stringify({ reason }),
      });
      toast('Match cancelled and all participants refunded.');
      renderActiveTab();
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  // =========================================================================
  // 3. Match History
  // =========================================================================
  async function renderMatchHistory() {
    const qs = new URLSearchParams({
      isSandbox: '0',
      page: state.filters.histPage,
      limit: 20,
    });
    if (state.filters.histStatus) qs.set('status', state.filters.histStatus);
    if (state.filters.histSearch) qs.set('search', state.filters.histSearch);
    if (state.filters.histFrom) qs.set('from', state.filters.histFrom);
    if (state.filters.histTo) qs.set('to', state.filters.histTo);

    const { matches, total } = await api(`/matches/history?${qs.toString()}`);

    document.getElementById('tab-content').innerHTML = `
      <div class="card">
        <div class="toolbar">
          <label><span>Search ID / Room</span><input id="hist-search" value="${esc(state.filters.histSearch)}" placeholder="NG-..." /></label>
          <label><span>Status</span>
            <select id="hist-status">
              <option value="">All</option>
              ${['COMPLETED', 'REFUNDED', 'CANCELLED', 'ACTIVE', 'WAITING'].map((s) => `<option value="${s}" ${state.filters.histStatus === s ? 'selected' : ''}>${s}</option>`).join('')}
            </select>
          </label>
          <label><span>From</span><input type="date" id="hist-from" value="${esc(state.filters.histFrom)}" /></label>
          <label><span>To</span><input type="date" id="hist-to" value="${esc(state.filters.histTo)}" /></label>
          <button class="btn btn-primary" id="hist-apply">Search</button>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Room</th><th>Entry</th><th>Players (H/B)</th><th>Secret</th>
                <th>Total Pool</th><th>Fee</th><th>Prize Pool</th><th>Status</th><th>Created</th><th>Action</th>
              </tr>
            </thead>
            <tbody>
              ${
                matches.length
                  ? matches
                      .map(
                        (m) => `
                  <tr>
                    <td><strong>${esc(m.room_code)}</strong><br><span class="muted">${esc(m.id.slice(0, 8))}</span></td>
                    <td>${fmtNum(m.entry_fee)}</td>
                    <td>${m.participantCount} (${m.realCount}H / ${m.botCount}B)</td>
                    <td><strong>${m.secret_number ?? '—'}</strong></td>
                    <td>${fmtNum(m.total_pool)}</td>
                    <td>${fmtNum(m.platform_fee_coins)} (${m.fee_percent}%)</td>
                    <td>${fmtNum(m.prize_pool_coins)}</td>
                    <td>${statusPill(m.status)}</td>
                    <td>${fmtDate(m.created_at)}</td>
                    <td><button class="btn btn-secondary btn-sm" data-view-match="${esc(m.id)}">Audit</button></td>
                  </tr>`
                      )
                      .join('')
                  : `<tr><td colspan="10" class="muted">No matches found.</td></tr>`
              }
            </tbody>
          </table>
        </div>
        <div style="margin-top:12px; display:flex; justify-content:space-between; align-items:center;">
          <span class="muted">Total records: ${fmtNum(total)}</span>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary btn-sm" id="hist-prev" ${state.filters.histPage <= 1 ? 'disabled' : ''}>Prev</button>
            <span class="muted">Page ${state.filters.histPage}</span>
            <button class="btn btn-secondary btn-sm" id="hist-next" ${matches.length < 20 ? 'disabled' : ''}>Next</button>
          </div>
        </div>
      </div>
    `;

    document.getElementById('hist-apply').onclick = () => {
      state.filters.histSearch = document.getElementById('hist-search').value.trim();
      state.filters.histStatus = document.getElementById('hist-status').value;
      state.filters.histFrom = document.getElementById('hist-from').value;
      state.filters.histTo = document.getElementById('hist-to').value;
      state.filters.histPage = 1;
      renderMatchHistory();
    };
    document.getElementById('hist-prev').onclick = () => {
      if (state.filters.histPage > 1) { state.filters.histPage--; renderMatchHistory(); }
    };
    document.getElementById('hist-next').onclick = () => {
      state.filters.histPage++; renderMatchHistory();
    };
    document.querySelectorAll('[data-view-match]').forEach((b) => {
      b.onclick = () => showMatchDetailsModal(b.dataset.viewMatch);
    });
  }

  // =========================================================================
  // 4. Matchmaking Settings
  // =========================================================================
  async function renderMatchmakingSettings() {
    const { settings } = await api('/settings');
    document.getElementById('tab-content').innerHTML = `
      <div class="card">
        <div class="card-header"><div class="card-title">Queue & Matchmaking Rules</div></div>
        <form id="mm-form">
          <div class="form-grid">
            <label><span>Match Start Mode</span>
              <select id="mm-start-mode">
                <option value="AUTO" ${settings.match_start_mode !== 'MANUAL' ? 'selected' : ''}>Automatic Start</option>
                <option value="MANUAL" ${settings.match_start_mode === 'MANUAL' ? 'selected' : ''}>Manual Admin Start</option>
              </select>
            </label>
            <label><span>Minimum Players (2-10)</span><input type="number" min="2" max="10" id="mm-min" value="${settings.min_players}" /></label>
            <label><span>Maximum Players (2-10)</span><input type="number" min="2" max="10" id="mm-max" value="${settings.max_players}" /></label>
            <label><span>Search Timeout (10-120 sec)</span><input type="number" min="10" max="120" id="mm-timeout" value="${settings.search_timeout_sec}" /></label>
            <label><span>Bot Filling Enabled</span>
              <select id="mm-bot-enable">
                <option value="true" ${settings.bot_filling_enabled ? 'selected' : ''}>Enabled</option>
                <option value="false" ${!settings.bot_filling_enabled ? 'selected' : ''}>Disabled (Cancel & Refund on Timeout)</option>
              </select>
            </label>
            <label><span>Bot Filling Delay (sec)</span><input type="number" min="1" max="110" id="mm-bot-delay" value="${settings.bot_fill_delay_sec}" /></label>
            <label><span>Bot Join Interval (sec)</span><input type="number" min="1" max="30" id="mm-bot-interval" value="${settings.bot_join_interval_sec}" /></label>
            <label><span>Allow Leave Before Match Lock</span>
              <select id="mm-leave">
                <option value="true" ${settings.allow_leave_before_lock ? 'selected' : ''}>Allowed (Refund Fee)</option>
                <option value="false" ${!settings.allow_leave_before_lock ? 'selected' : ''}>Locked Immediately</option>
              </select>
            </label>
            <label><span>Refund If Zero Guesses Submitted</span>
              <select id="mm-refund-none">
                <option value="true" ${settings.refund_on_no_guesses ? 'selected' : ''}>Refund All</option>
                <option value="false" ${!settings.refund_on_no_guesses ? 'selected' : ''}>No Refund</option>
              </select>
            </label>
          </div>
          <div style="margin-top:16px">
            <button type="submit" class="btn btn-primary">Save Matchmaking Settings</button>
          </div>
        </form>
      </div>
    `;

    document.getElementById('mm-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/settings', {
          method: 'PUT',
          body: JSON.stringify({
            match_start_mode: document.getElementById('mm-start-mode').value,
            min_players: Number(document.getElementById('mm-min').value),
            max_players: Number(document.getElementById('mm-max').value),
            search_timeout_sec: Number(document.getElementById('mm-timeout').value),
            bot_filling_enabled: document.getElementById('mm-bot-enable').value === 'true',
            bot_fill_delay_sec: Number(document.getElementById('mm-bot-delay').value),
            bot_join_interval_sec: Number(document.getElementById('mm-bot-interval').value),
            allow_leave_before_lock: document.getElementById('mm-leave').value === 'true',
            refund_on_no_guesses: document.getElementById('mm-refund-none').value === 'true',
          }),
        });
        toast('Matchmaking settings saved.');
      } catch (err) {
        toast(err.message, 'err');
      }
    };
  }

  // =========================================================================
  // 5. Bot Management
  // =========================================================================
  async function renderBots() {
    const [{ bots }, { settings }] = await Promise.all([api('/bots'), api('/settings')]);

    document.getElementById('tab-content').innerHTML = `
      <div class="two-col">
        <div class="card">
          <div class="card-header"><div class="card-title">Create New Bot</div></div>
          <form id="create-bot-form" class="form-grid">
            <label><span>Bot Username</span><input id="bot-name" placeholder="e.g. AlphaBot" required /></label>
            <label><span>Avatar Emoji</span><input id="bot-avatar" value="🤖" maxlength="4" /></label>
            <label><span>Strategy</span>
              <select id="bot-strategy">
                <option value="RANDOM">Random (1-100)</option>
                <option value="LOW">Low Range (1-35)</option>
                <option value="MIDDLE">Middle Range (34-67)</option>
                <option value="HIGH">High Range (66-100)</option>
              </select>
            </label>
            <div style="display:flex; align-items:flex-end;">
              <button type="submit" class="btn btn-primary full-width">+ Create Bot</button>
            </div>
          </form>
        </div>

        <div class="card">
          <div class="card-header"><div class="card-title">Global Bot Behavior Limits</div></div>
          <form id="bot-limits-form" class="form-grid">
            <label><span>Max Available Bots</span><input type="number" min="0" max="200" id="bl-max-avail" value="${settings.max_available_bots}" /></label>
            <label><span>Max Bots Per Match</span><input type="number" min="0" max="9" id="bl-max-match" value="${settings.max_bots_per_match}" /></label>
            <label><span>Min Submit Delay (sec)</span><input type="number" min="1" max="30" id="bl-sub-min" value="${settings.bot_submit_delay_min_sec}" /></label>
            <label><span>Max Submit Delay (sec)</span><input type="number" min="2" max="60" id="bl-sub-max" value="${settings.bot_submit_delay_max_sec}" /></label>
            <div><button type="submit" class="btn btn-secondary">Save Bot Limits</button></div>
          </form>
        </div>
      </div>

      <div class="card">
        <div class="card-header">
          <div class="card-title">Bot Profiles (${bots.length})</div>
          <span class="muted">Bots use isolated virtual balances and are always disclosed as BOT to players</span>
        </div>
        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>ID</th><th>Bot</th><th>Strategy</th><th>Status</th><th>Virtual Balance</th><th>Matches / Wins</th><th>Created</th><th>Actions</th></tr>
            </thead>
            <tbody>
              ${bots
                .map(
                  (b) => `
                <tr>
                  <td>#${b.id}</td>
                  <td>${esc(b.avatar)} <strong>${esc(b.username)}</strong></td>
                  <td><span class="pill pill-cyan">${esc(b.strategy)}</span></td>
                  <td>${b.is_enabled ? '<span class="pill pill-green">ENABLED</span>' : '<span class="pill pill-red">DISABLED</span>'}</td>
                  <td>${fmtNum(b.virtual_balance)}</td>
                  <td>${b.matches_played} / ${b.wins}</td>
                  <td>${fmtDate(b.created_at)}</td>
                  <td>
                    <button class="btn btn-secondary btn-sm" data-bot-edit="${b.id}">Edit</button>
                    <button class="btn btn-secondary btn-sm" data-bot-toggle="${b.id}" data-enabled="${b.is_enabled}">${b.is_enabled ? 'Disable' : 'Enable'}</button>
                    <button class="btn btn-secondary btn-sm" data-bot-hist="${b.id}">Stats</button>
                    <button class="btn btn-danger btn-sm" data-bot-del="${b.id}">Delete</button>
                  </td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    document.getElementById('create-bot-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/bots', {
          method: 'POST',
          body: JSON.stringify({
            username: document.getElementById('bot-name').value.trim(),
            avatar: document.getElementById('bot-avatar').value.trim() || '🤖',
            strategy: document.getElementById('bot-strategy').value,
          }),
        });
        toast('Bot created.');
        renderBots();
      } catch (err) {
        toast(err.message, 'err');
      }
    };

    document.getElementById('bot-limits-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        await api('/settings', {
          method: 'PUT',
          body: JSON.stringify({
            max_available_bots: Number(document.getElementById('bl-max-avail').value),
            max_bots_per_match: Number(document.getElementById('bl-max-match').value),
            bot_submit_delay_min_sec: Number(document.getElementById('bl-sub-min').value),
            bot_submit_delay_max_sec: Number(document.getElementById('bl-sub-max').value),
          }),
        });
        toast('Bot limits updated.');
      } catch (err) {
        toast(err.message, 'err');
      }
    };

    document.querySelectorAll('[data-bot-toggle]').forEach((btn) => {
      btn.onclick = async () => {
        const nextVal = btn.dataset.enabled === '1' ? 0 : 1;
        await api(`/bots/${btn.dataset.botToggle}`, { method: 'PUT', body: JSON.stringify({ is_enabled: nextVal }) });
        toast('Bot status updated.');
        renderBots();
      };
    });

    document.querySelectorAll('[data-bot-del]').forEach((btn) => {
      btn.onclick = async () => {
        if (!confirm('Delete this bot?')) return;
        await api(`/bots/${btn.dataset.botDel}`, { method: 'DELETE' });
        toast('Bot deleted.');
        renderBots();
      };
    });

    document.querySelectorAll('[data-bot-edit]').forEach((btn) => {
      btn.onclick = () => {
        const bot = bots.find((x) => String(x.id) === btn.dataset.botEdit);
        if (!bot) return;
        openModal(
          `Edit Bot #${bot.id}`,
          `
          <form id="edit-bot-modal-form" style="display:flex; flex-direction:column; gap:12px;">
            <label><span>Username</span><input id="eb-name" value="${esc(bot.username)}" required /></label>
            <label><span>Avatar</span><input id="eb-avatar" value="${esc(bot.avatar)}" /></label>
            <label><span>Strategy</span>
              <select id="eb-strategy">
                ${['RANDOM', 'LOW', 'MIDDLE', 'HIGH'].map((s) => `<option value="${s}" ${bot.strategy === s ? 'selected' : ''}>${s}</option>`).join('')}
              </select>
            </label>
            <button type="submit" class="btn btn-primary">Save Bot</button>
          </form>
        `
        );
        document.getElementById('edit-bot-modal-form').onsubmit = async (ev) => {
          ev.preventDefault();
          try {
            await api(`/bots/${bot.id}`, {
              method: 'PUT',
              body: JSON.stringify({
                username: document.getElementById('eb-name').value.trim(),
                avatar: document.getElementById('eb-avatar').value.trim(),
                strategy: document.getElementById('eb-strategy').value,
              }),
            });
            closeModal();
            toast('Bot updated.');
            renderBots();
          } catch (err) {
            toast(err.message, 'err');
          }
        };
      };
    });

    document.querySelectorAll('[data-bot-hist]').forEach((btn) => {
      btn.onclick = async () => {
        const { bot, history } = await api(`/bots/${btn.dataset.botHist}/history`);
        openModal(
          `${bot.avatar} ${bot.username} — Match History`,
          `
          <p class="muted" style="margin-bottom:12px">Virtual Balance: <strong>${fmtNum(bot.virtual_balance)}</strong> | Played: ${bot.matches_played} | Wins: ${bot.wins}</p>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Room</th><th>Entry</th><th>Secret</th><th>Guess</th><th>Diff</th><th>Result</th><th>Time</th></tr></thead>
              <tbody>
                ${history.map((h) => `<tr><td>${esc(h.roomCode)}</td><td>${fmtNum(h.entryFee)}</td><td>${h.secretNumber ?? '—'}</td><td>${h.guess ?? '—'}</td><td>${h.diff ?? '—'}</td><td>${h.isWinner ? `+${fmtNum(h.payoutCoins)}` : 'Loss'}</td><td>${fmtDate(h.createdAt)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No matches yet</td></tr>'}
              </tbody>
            </table>
          </div>
        `
        );
      };
    });
  }

  // =========================================================================
  // 6. Player Management
  // =========================================================================
  async function renderPlayers() {
    const q = encodeURIComponent(state.filters.playerSearch || '');
    const { players } = await api(`/players?q=${q}`);

    document.getElementById('tab-content').innerHTML = `
      <div class="card">
        <div class="toolbar">
          <label><span>Search by User ID or Username</span><input id="pl-search" value="${esc(state.filters.playerSearch)}" placeholder="User ID or username..." /></label>
          <button class="btn btn-primary" id="pl-search-btn">Search</button>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>User ID</th><th>Username</th><th>Balance</th><th>NG Matches</th><th>Wins</th><th>Status</th><th>Flags</th><th>Action</th></tr>
            </thead>
            <tbody>
              ${players
                .map(
                  (p) => `
                <tr>
                  <td>#${p.id}</td>
                  <td><strong>${esc(p.username)}</strong> <span class="muted">(${esc(p.full_name)})</span></td>
                  <td>${fmtNum(p.balance)}</td>
                  <td>${p.ngMatches}</td>
                  <td>${p.ngWins}</td>
                  <td>${p.is_banned ? '<span class="pill pill-red">BANNED</span>' : p.isRestricted ? '<span class="pill pill-amber">NG RESTRICTED</span>' : '<span class="pill pill-green">ACTIVE</span>'}</td>
                  <td>${p.activeFlags}</td>
                  <td><button class="btn btn-secondary btn-sm" data-player-id="${p.id}">Inspect Dossier</button></td>
                </tr>`
                )
                .join('')}
            </tbody>
          </table>
        </div>
      </div>
    `;

    document.getElementById('pl-search-btn').onclick = () => {
      state.filters.playerSearch = document.getElementById('pl-search').value.trim();
      renderPlayers();
    };
    document.querySelectorAll('[data-player-id]').forEach((b) => {
      b.onclick = () => openPlayerDossier(b.dataset.playerId);
    });
  }

  async function openPlayerDossier(userId) {
    try {
      const { player, summary, matches, ledger, flags } = await api(`/players/${userId}`);
      openModal(
        `Player #${player.id}: ${player.username}`,
        `
        <div class="grid-stats">
          <div class="stat-card"><div class="stat-label">Wallet Balance</div><div class="stat-value">${fmtNum(player.balance)}</div></div>
          <div class="stat-card"><div class="stat-label">Matches / Wins / Losses</div><div class="stat-value">${summary.matchesPlayed} / ${summary.wins} / ${summary.losses}</div></div>
          <div class="stat-card"><div class="stat-label">Total Entry / Won</div><div>${fmtNum(summary.totalEntryPaid)} / <strong>${fmtNum(summary.totalWonCoins)}</strong></div></div>
          <div class="stat-card"><div class="stat-label">Total Refunded</div><div class="stat-value">${fmtNum(summary.totalRefunded)}</div></div>
        </div>

        <div class="card" style="background:var(--bg)">
          <div class="card-title" style="margin-bottom:8px">Moderation & Suspicious Activity Flags</div>
          <form id="flag-form" class="toolbar">
            <label><span>Flag Type</span>
              <select id="fl-type">
                <option value="SUSPICIOUS">Suspicious Activity</option>
                <option value="COLLUSION">Multi-Account / Collusion</option>
                <option value="RESTRICTION">Matchmaking Restriction</option>
              </select>
            </label>
            <label><span>Restrict Play?</span>
              <select id="fl-restrict">
                <option value="false">Flag Only (Allow Play)</option>
                <option value="true">Restrict Number Guess Access</option>
              </select>
            </label>
            <label style="flex:1"><span>Documented Reason</span><input id="fl-reason" placeholder="Reason for audit log..." required /></label>
            <button type="submit" class="btn btn-danger">Apply Flag</button>
            <button type="button" id="fl-clear" class="btn btn-success">Clear Active Flags</button>
          </form>
          <div class="muted" style="margin-top:6px">
            Active & Past Flags: ${flags.map((f) => `${esc(f.flag_type)} (${f.is_restricted ? 'RESTRICTED' : 'FLAG'}) - "${esc(f.reason)}" [${f.is_active ? 'ACTIVE' : 'CLEARED'}]`).join(' | ') || 'None'}
          </div>
        </div>

        <h4 style="margin:12px 0 6px">Recent Matches</h4>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Room</th><th>Entry</th><th>Secret</th><th>Guess</th><th>Diff</th><th>Result</th><th>Date</th></tr></thead>
            <tbody>${matches.slice(0, 20).map((m) => `<tr><td>${esc(m.roomCode)}</td><td>${fmtNum(m.entryFee)}</td><td>${m.secretNumber ?? '—'}</td><td>${m.guess ?? '—'}</td><td>${m.diff ?? '—'}</td><td>${m.isWinner ? `+${fmtNum(m.payoutCoins)}` : m.refunded ? 'Refunded' : 'Loss'}</td><td>${fmtDate(m.createdAt)}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">No matches</td></tr>'}</tbody>
          </table>
        </div>

        <h4 style="margin:14px 0 6px">Coin Transactions</h4>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Type</th><th>Amount</th><th>Note</th><th>Date</th></tr></thead>
            <tbody>${ledger.slice(0, 25).map((l) => `<tr><td>${esc(l.tx_type)}</td><td>${fmtNum(l.amount)}</td><td>${esc(l.note)}</td><td>${fmtDate(l.created_at)}</td></tr>`).join('') || '<tr><td colspan="4" class="muted">No ledger rows</td></tr>'}</tbody>
          </table>
        </div>
      `
      );

      document.getElementById('flag-form').onsubmit = async (e) => {
        e.preventDefault();
        await api(`/players/${userId}/flag`, {
          method: 'POST',
          body: JSON.stringify({
            action: 'FLAG',
            flagType: document.getElementById('fl-type').value,
            isRestricted: document.getElementById('fl-restrict').value === 'true',
            reason: document.getElementById('fl-reason').value.trim(),
          }),
        });
        toast('Player flag saved.');
        openPlayerDossier(userId);
      };

      document.getElementById('fl-clear').onclick = async () => {
        await api(`/players/${userId}/flag`, {
          method: 'POST',
          body: JSON.stringify({ action: 'CLEAR', reason: 'Cleared by admin' }),
        });
        toast('Active flags cleared.');
        openPlayerDossier(userId);
      };
    } catch (err) {
      toast(err.message, 'err');
    }
  }

  // =========================================================================
  // 7. Game Configuration (Entry Fees & Dynamic Fee Table)
  // =========================================================================
  async function renderGameConfig() {
    const { settings } = await api('/settings');
    const tiers = settings.fee_tiers || {};

    document.getElementById('tab-content').innerHTML = `
      <div class="card">
        <div class="card-header"><div class="card-title">Core Game Rules & Dynamic Platform Fees</div></div>
        <form id="gc-form">
          <div class="form-grid">
            <label><span>Game Status</span>
              <select id="gc-enabled">
                <option value="true" ${settings.game_enabled ? 'selected' : ''}>Online / Enabled</option>
                <option value="false" ${!settings.game_enabled ? 'selected' : ''}>Maintenance / Disabled</option>
              </select>
            </label>
            <label><span>Entry Fees (comma-separated)</span><input id="gc-fees" value="${esc((settings.entry_fees || []).join(', '))}" /></label>
            <label><span>Round Duration (sec)</span><input type="number" min="10" max="120" id="gc-round" value="${settings.round_duration_sec}" /></label>
            <label><span>Lock Countdown (sec)</span><input type="number" min="0" max="15" id="gc-countdown" value="${settings.starting_countdown_sec}" /></label>
          </div>

          <h4 style="margin:18px 0 10px">Dynamic Fee & Winner Share Table (2–10 Players)</h4>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Participants</th><th>Platform Fee (%)</th><th>Winner Share (%)</th></tr></thead>
              <tbody>
                ${[2, 3, 4, 5, 6, 7, 8, 9, 10]
                  .map((n) => {
                    const fee = Number(tiers[String(n)] ?? 10);
                    return `<tr>
                      <td><strong>${n} Players</strong></td>
                      <td><input type="number" min="0" max="80" class="tier-input" data-tier="${n}" value="${fee}" style="width:90px" />%</td>
                      <td id="share-${n}">${100 - fee}%</td>
                    </tr>`;
                  })
                  .join('')}
              </tbody>
            </table>
          </div>
          <div style="margin-top:16px">
            <button type="submit" class="btn btn-primary">Save Game Configuration</button>
          </div>
        </form>
      </div>
    `;

    document.querySelectorAll('.tier-input').forEach((inp) => {
      inp.oninput = () => {
        const n = inp.dataset.tier;
        const val = Math.max(0, Math.min(80, Number(inp.value) || 0));
        document.getElementById(`share-${n}`).textContent = `${100 - val}%`;
      };
    });

    document.getElementById('gc-form').onsubmit = async (e) => {
      e.preventDefault();
      const feeTiers = {};
      document.querySelectorAll('.tier-input').forEach((inp) => {
        feeTiers[inp.dataset.tier] = Math.max(0, Math.min(80, Number(inp.value) || 0));
      });
      const entryFees = document
        .getElementById('gc-fees')
        .value.split(',')
        .map((x) => parseInt(x.trim(), 10))
        .filter((x) => x > 0);

      await api('/settings', {
        method: 'PUT',
        body: JSON.stringify({
          game_enabled: document.getElementById('gc-enabled').value === 'true',
          entry_fees: entryFees.length ? entryFees : [500, 1000, 2000],
          round_duration_sec: Number(document.getElementById('gc-round').value),
          starting_countdown_sec: Number(document.getElementById('gc-countdown').value),
          fee_tiers: feeTiers,
        }),
      });
      toast('Game configuration updated.');
    };
  }

  // =========================================================================
  // 8. Coin Management
  // =========================================================================
  async function renderCoins() {
    const { summaryByType } = await api('/transactions?isSandbox=0&limit=1');
    document.getElementById('tab-content').innerHTML = `
      <div class="card">
        <div class="card-header">
          <div class="card-title">Production Coin Ledger Summary</div>
          <span class="pill pill-green">Strictly Isolated from Bots & Sandbox</span>
        </div>
        <div class="grid-stats">
          ${summaryByType
            .map(
              (s) => `
            <div class="stat-card">
              <div class="stat-label">${esc(s.tx_type)}</div>
              <div class="stat-value">${fmtNum(s.totalAmount)}</div>
              <div class="stat-sub">${fmtNum(s.cnt)} entries</div>
            </div>`
            )
            .join('') || '<div class="muted">No production transactions yet.</div>'}
        </div>
      </div>
    `;
  }

  // =========================================================================
  // 9. Transactions Ledger
  // =========================================================================
  async function renderTransactions() {
    const qs = new URLSearchParams({ page: state.filters.txPage, limit: 40 });
    if (state.filters.txType) qs.set('type', state.filters.txType);
    if (state.filters.txUserId) qs.set('userId', state.filters.txUserId);
    if (state.filters.txSandbox !== '') qs.set('isSandbox', state.filters.txSandbox);

    const { transactions, total } = await api(`/transactions?${qs.toString()}`);

    document.getElementById('tab-content').innerHTML = `
      <div class="card">
        <div class="toolbar">
          <label><span>Type</span>
            <select id="tx-type">
              <option value="">All Types</option>
              ${['MATCH_ENTRY', 'MATCH_WIN', 'MATCH_REFUND', 'PLATFORM_FEE', 'BOT_VIRTUAL_REWARD', 'TEST_COIN_ADD', 'TEST_COIN_DEDUCT']
                .map((t) => `<option value="${t}" ${state.filters.txType === t ? 'selected' : ''}>${t}</option>`)
                .join('')}
            </select>
          </label>
          <label><span>Environment</span>
            <select id="tx-sandbox">
              <option value="">All</option>
              <option value="0" ${state.filters.txSandbox === '0' ? 'selected' : ''}>Production Only</option>
              <option value="1" ${state.filters.txSandbox === '1' ? 'selected' : ''}>Sandbox Only</option>
            </select>
          </label>
          <label><span>User ID</span><input id="tx-uid" value="${esc(state.filters.txUserId)}" placeholder="e.g. 12" style="width:100px" /></label>
          <button class="btn btn-primary" id="tx-apply">Filter</button>
        </div>

        <div class="table-wrap">
          <table>
            <thead>
              <tr><th>ID</th><th>Env</th><th>Type</th><th>Actor</th><th>Amount</th><th>Match</th><th>Note</th><th>Timestamp</th></tr>
            </thead>
            <tbody>
              ${transactions
                .map((t) => {
                  const actor = t.humanUsername || t.botUsername || t.sandboxUsername || 'SYSTEM';
                  return `<tr>
                    <td>#${t.id}</td>
                    <td>${t.is_sandbox ? '<span class="pill pill-amber">SANDBOX</span>' : '<span class="pill pill-green">PROD</span>'}</td>
                    <td><code>${esc(t.tx_type)}</code></td>
                    <td>${esc(actor)} (${esc(t.participant_type)})</td>
                    <td><strong>${fmtNum(t.amount)}</strong></td>
                    <td>${t.match_id ? `<code>${esc(t.match_id.slice(0, 8))}</code>` : '—'}</td>
                    <td>${esc(t.note)}</td>
                    <td>${fmtDate(t.created_at)}</td>
                  </tr>`;
                })
                .join('') || '<tr><td colspan="8" class="muted">No ledger entries found.</td></tr>'}
            </tbody>
          </table>
        </div>
        <div style="margin-top:12px; display:flex; justify-content:space-between;">
          <span class="muted">Total entries: ${fmtNum(total)}</span>
          <div style="display:flex; gap:8px;">
            <button class="btn btn-secondary btn-sm" id="tx-prev" ${state.filters.txPage <= 1 ? 'disabled' : ''}>Prev</button>
            <span class="muted">Page ${state.filters.txPage}</span>
            <button class="btn btn-secondary btn-sm" id="tx-next" ${transactions.length < 40 ? 'disabled' : ''}>Next</button>
          </div>
        </div>
      </div>
    `;

    document.getElementById('tx-apply').onclick = () => {
      state.filters.txType = document.getElementById('tx-type').value;
      state.filters.txSandbox = document.getElementById('tx-sandbox').value;
      state.filters.txUserId = document.getElementById('tx-uid').value.trim();
      state.filters.txPage = 1;
      renderTransactions();
    };
    document.getElementById('tx-prev').onclick = () => { if (state.filters.txPage > 1) { state.filters.txPage--; renderTransactions(); } };
    document.getElementById('tx-next').onclick = () => { state.filters.txPage++; renderTransactions(); };
  }

  // =========================================================================
  // 10. Sandbox Testing Environment
  // =========================================================================
  async function renderSandbox() {
    const [{ accounts }, { bots }, { matches }] = await Promise.all([
      api('/sandbox/accounts'),
      api('/bots'),
      api('/matches/history?isSandbox=1&limit=15'),
    ]);

    document.getElementById('tab-content').innerHTML = `
      <div class="two-col">
        <div class="card">
          <div class="card-header">
            <div class="card-title">Simulated Test Accounts (Virtual Coins)</div>
            <button class="btn btn-danger btn-sm" id="sb-reset-btn">Reset All Sandbox Data</button>
          </div>
          <div class="table-wrap">
            <table>
              <thead><tr><th>Account</th><th>Test Balance</th><th>Played / Wins</th><th>Coins</th></tr></thead>
              <tbody>
                ${accounts
                  .map(
                    (a) => `
                  <tr>
                    <td>${esc(a.avatar)} <strong>${esc(a.username)}</strong></td>
                    <td>${fmtNum(a.balance)}</td>
                    <td>${a.matches_played} / ${a.wins}</td>
                    <td>
                      <button class="btn btn-success btn-sm" data-sb-add="${a.id}">+5,000</button>
                      <button class="btn btn-danger btn-sm" data-sb-ded="${a.id}">-1,000</button>
                    </td>
                  </tr>`
                  )
                  .join('')}
              </tbody>
            </table>
          </div>
        </div>

        <div class="card">
          <div class="card-header"><div class="card-title">Create Manual Sandbox Match</div></div>
          <form id="sb-match-form" style="display:flex; flex-direction:column; gap:12px;">
            <div class="form-grid">
              <label><span>Entry Fee</span>
                <select id="sb-fee">
                  <option value="500">500</option>
                  <option value="1000">1,000</option>
                  <option value="2000">2,000</option>
                </select>
              </label>
              <label><span>Manual Secret Number (1-100)</span><input type="number" min="1" max="100" id="sb-secret" value="50" required /></label>
            </div>

            <div>
              <div class="muted" style="margin-bottom:6px">Select Simulated Players & Optional Fixed Guess (for tie tests):</div>
              ${accounts
                .map(
                  (a) => `
                <div style="display:flex; align-items:center; gap:10px; margin-bottom:6px;">
                  <input type="checkbox" class="sb-acc-chk" value="${a.id}" checked />
                  <span style="min-width:130px">${esc(a.username)}</span>
                  <input type="number" min="1" max="100" class="sb-acc-guess" data-id="${a.id}" placeholder="Guess (1-100)" style="width:130px" />
                </div>`
                )
                .join('')}
            </div>

            <div>
              <div class="muted" style="margin-bottom:6px">Optional Bot Profiles:</div>
              ${bots
                .slice(0, 4)
                .map(
                  (b) => `
                <label style="flex-direction:row; align-items:center; gap:8px; margin-bottom:4px;">
                  <input type="checkbox" class="sb-bot-chk" value="${b.id}" />
                  <span>${esc(b.avatar)} ${esc(b.username)} (${esc(b.strategy)})</span>
                </label>`
                )
                .join('')}
            </div>

            <label style="flex-direction:row; align-items:center; gap:8px;">
              <input type="checkbox" id="sb-autosettle" checked />
              <span>Auto-fill any blank guesses & settle immediately</span>
            </label>

            <button type="submit" class="btn btn-primary">Run Private Sandbox Match</button>
          </form>
        </div>
      </div>

      <div class="card">
        <div class="card-header"><div class="card-title">Recent Sandbox Simulations</div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>Room</th><th>Secret</th><th>Entry</th><th>Pool</th><th>Fee</th><th>Prize Pool</th><th>Status</th><th>Created</th><th>Action</th></tr></thead>
            <tbody>
              ${matches
                .map(
                  (m) => `
                <tr>
                  <td><strong>${esc(m.room_code)}</strong></td>
                  <td><strong>${m.secret_number}</strong></td>
                  <td>${fmtNum(m.entry_fee)}</td>
                  <td>${fmtNum(m.total_pool)}</td>
                  <td>${fmtNum(m.platform_fee_coins)} (${m.fee_percent}%)</td>
                  <td>${fmtNum(m.prize_pool_coins)}</td>
                  <td>${statusPill(m.status)}</td>
                  <td>${fmtDate(m.created_at)}</td>
                  <td>
                    <button class="btn btn-secondary btn-sm" data-view-match="${esc(m.id)}">Inspect</button>
                    ${m.status === 'ACTIVE' ? `<button class="btn btn-primary btn-sm" data-sim-finish="${esc(m.id)}">Simulate & Settle</button>` : ''}
                  </td>
                </tr>`
                )
                .join('') || '<tr><td colspan="9" class="muted">No sandbox matches yet.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;

    document.getElementById('sb-reset-btn').onclick = async () => {
      if (!confirm('Reset all sandbox matches, sandbox ledger entries, and reset test balances to 10,000?')) return;
      await api('/sandbox/reset', { method: 'POST' });
      toast('Sandbox reset complete.');
      renderSandbox();
    };

    document.querySelectorAll('[data-sb-add]').forEach((b) => {
      b.onclick = async () => {
        await api(`/sandbox/accounts/${b.dataset.sbAdd}/coins`, {
          method: 'POST',
          body: JSON.stringify({ operation: 'ADD', amount: 5000 }),
        });
        toast('Added 5,000 test coins.');
        renderSandbox();
      };
    });

    document.querySelectorAll('[data-sb-ded]').forEach((b) => {
      b.onclick = async () => {
        await api(`/sandbox/accounts/${b.dataset.sbDed}/coins`, {
          method: 'POST',
          body: JSON.stringify({ operation: 'DEDUCT', amount: 1000 }),
        });
        toast('Deducted 1,000 test coins.');
        renderSandbox();
      };
    });

    document.getElementById('sb-match-form').onsubmit = async (e) => {
      e.preventDefault();
      try {
        const sandboxAccountIds = [...document.querySelectorAll('.sb-acc-chk:checked')].map((c) => Number(c.value));
        const botIds = [...document.querySelectorAll('.sb-bot-chk:checked')].map((c) => Number(c.value));
        const guesses = {};
        document.querySelectorAll('.sb-acc-guess').forEach((inp) => {
          if (inp.value !== '') guesses[`sim_${inp.dataset.id}`] = Number(inp.value);
        });

        const autoSettle = document.getElementById('sb-autosettle').checked;
        const res = await api('/sandbox/matches', {
          method: 'POST',
          body: JSON.stringify({
            entryFee: Number(document.getElementById('sb-fee').value),
            secretNumber: Number(document.getElementById('sb-secret').value),
            sandboxAccountIds,
            botIds,
            guesses,
            autoSettle: false,
          }),
        });

        if (autoSettle) {
          await api(`/sandbox/matches/${res.match.id}/simulate`, {
            method: 'POST',
            body: JSON.stringify({ settleNow: true }),
          });
        }
        toast('Sandbox match created.');
        renderSandbox();
        showMatchDetailsModal(res.match.id);
      } catch (err) {
        toast(err.message, 'err');
      }
    };

    document.querySelectorAll('[data-view-match]').forEach((b) => {
      b.onclick = () => showMatchDetailsModal(b.dataset.viewMatch);
    });
    document.querySelectorAll('[data-sim-finish]').forEach((b) => {
      b.onclick = async () => {
        await api(`/sandbox/matches/${b.dataset.simFinish}/simulate`, {
          method: 'POST',
          body: JSON.stringify({ settleNow: true }),
        });
        toast('Sandbox match settled.');
        renderSandbox();
      };
    });
  }

  // =========================================================================
  // 11. Admin Activity Logs
  // =========================================================================
  async function renderLogs() {
    const { logs } = await api('/logs');
    document.getElementById('tab-content').innerHTML = `
      <div class="card">
        <div class="card-header"><div class="card-title">Admin Audit Trail</div></div>
        <div class="table-wrap">
          <table>
            <thead><tr><th>ID</th><th>Admin</th><th>Action</th><th>Target</th><th>Details</th><th>Timestamp</th></tr></thead>
            <tbody>
              ${logs
                .map(
                  (l) => `
                <tr>
                  <td>#${l.id}</td>
                  <td><strong>${esc(l.admin_username)}</strong></td>
                  <td><code>${esc(l.action_type)}</code></td>
                  <td>${esc(l.target_type)} ${esc(l.target_id)}</td>
                  <td style="max-width:360px; white-space:normal;">${esc(l.details)}</td>
                  <td>${fmtDate(l.created_at)}</td>
                </tr>`
                )
                .join('') || '<tr><td colspan="6" class="muted">No activity logs yet.</td></tr>'}
            </tbody>
          </table>
        </div>
      </div>
    `;
  }

  // =========================================================================
  // 12. Settings
  // =========================================================================
  async function renderSettings() {
    const { settings, defaults } = await api('/settings');
    document.getElementById('tab-content').innerHTML = `
      <div class="card">
        <div class="card-header"><div class="card-title">General Panel & Sandbox Defaults</div></div>
        <p class="muted" style="margin-bottom:14px">Signed in as <strong>${esc(state.admin?.username)}</strong>. Production random numbers use Node.js <code>crypto.randomInt(1, 101)</code> and cannot be overridden.</p>
        <div class="toolbar">
          <label><span>Default Sandbox Starting Coins</span><input type="number" id="set-sb-bal" value="${settings.sandbox_default_balance}" /></label>
          <button class="btn btn-primary" id="set-save">Save</button>
          <button class="btn btn-danger" id="set-reset-defaults">Restore Factory Default Config</button>
        </div>
      </div>
    `;

    document.getElementById('set-save').onclick = async () => {
      await api('/settings', {
        method: 'PUT',
        body: JSON.stringify({ sandbox_default_balance: Number(document.getElementById('set-sb-bal').value) }),
      });
      toast('Saved.');
    };
    document.getElementById('set-reset-defaults').onclick = async () => {
      if (!confirm('Restore all Number Guess configuration values to PRD defaults?')) return;
      await api('/settings', { method: 'PUT', body: JSON.stringify(defaults) });
      toast('Defaults restored.');
      renderSettings();
    };
  }

  // =========================================================================
  // Boot & Event Listeners
  // =========================================================================
  async function bootApp() {
    if (!state.token) return;
    try {
      const { admin } = await api('/auth/me');
      state.admin = admin;
      document.getElementById('admin-name-display').textContent = admin.username;
      document.getElementById('login-screen').classList.add('hidden');
      document.getElementById('app-shell').classList.remove('hidden');
      await switchTab('dashboard');
    } catch (_) {
      logout();
    }
  }

  document.getElementById('login-form').onsubmit = async (e) => {
    e.preventDefault();
    const errBox = document.getElementById('login-error');
    errBox.classList.add('hidden');
    try {
      const res = await api('/auth/login', {
        method: 'POST',
        body: JSON.stringify({
          username: document.getElementById('login-username').value.trim(),
          password: document.getElementById('login-password').value,
        }),
      });
      state.token = res.token;
      localStorage.setItem(TOKEN_KEY, res.token);
      await bootApp();
    } catch (err) {
      errBox.textContent = err.message;
      errBox.classList.remove('hidden');
    }
  };

  document.querySelectorAll('#sidebar-nav .nav-item').forEach((btn) => {
    btn.onclick = () => switchTab(btn.dataset.tab);
  });

  document.getElementById('logout-btn').onclick = logout;
  document.getElementById('refresh-btn').onclick = () => renderActiveTab();
  document.getElementById('modal-close').onclick = closeModal;
  document.getElementById('modal-backdrop').onclick = (e) => {
    if (e.target.id === 'modal-backdrop') closeModal();
  };

  bootApp();
})();
