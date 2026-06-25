/* SignalAi Dashboard V1 — app.js */

// API_BASE env-aware (S185) : dev local (localhost) → staging ; déployé (signalai.fr) → prod.
const API_BASE = (location.hostname === 'localhost' || location.hostname === '127.0.0.1')
  ? 'https://n8n-staging.signalai.fr/webhook'      // dev local → n8n staging
  : 'https://n8n.srv1265068.hstgr.cloud/webhook';  // signalai.fr → n8n prod

// ─── STATE ────────────────────────────────────────────────────────────────────
const _urlToken = new URLSearchParams(location.search).get('t') || '';
const _lsToken  = (() => { try { return localStorage.getItem('dashboard_token') || ''; } catch (_) { return ''; } })();
if (_urlToken) { try { localStorage.setItem('dashboard_token', _urlToken); } catch (_) {} }
const state = {
  token: _urlToken || _lsToken,
  range: '7d',
  filters: {
    heats: [], verdicts: [], triggers: [], channels: [], sources: [], regions: []
  },
  currentView: 'agg',
  currentItemId: null,
  listPage: 1,
  listPageSize: 50,
  listSort: 'created_at_desc',
  listSearch: '',
  listTotal: 0,
  searchTimer: null,
  donutEnrichChart: null,
  donutLivraisonChart: null,
  sourcesMap: {},
};

// ─── BUILD URL ────────────────────────────────────────────────────────────────
function buildUrl(endpoint, extras = {}) {
  const p = new URLSearchParams({ token: state.token, range: state.range });
  Object.entries(extras).forEach(([k, v]) => { if (v !== undefined && v !== '') p.set(k, v); });
  ['heats', 'verdicts', 'triggers', 'channels', 'regions'].forEach(k => {
    if (!state.filters[k].length) return;
    // Normalisation : si toutes les checkboxes du groupe sont cochées,
    // c'est sémantiquement "no filter" → ne pas envoyer le param.
    // Évite d'exclure les items dont la valeur cible est NULL (ex. items sans région
    // détectée exclus quand toutes régions cochées via `COALESCE(...) IN (...)`).
    const total   = document.querySelectorAll(`input[type=checkbox][name="${k}"]`).length;
    const checked = document.querySelectorAll(`input[type=checkbox][name="${k}"]:checked`).length;
    if (total > 0 && checked === total) return;
    p.set(k, state.filters[k].join(','));
  });
  // Sources : sémantique explicite "aucune cochée = aucun résultat",
  // mais avant le premier populate (sources inconnues), on n'envoie rien (= tout).
  if (_sourcesPopulated) {
    p.set('sources', state.filters.sources.length ? state.filters.sources.join(',') : '__NONE__');
  } else if (state.filters.sources.length) {
    p.set('sources', state.filters.sources.join(','));
  }
  return `${API_BASE}/${endpoint}?${p}`;
}

// ─── FETCH helpers ────────────────────────────────────────────────────────────
async function apiFetch(url) {
  const res = await fetch(url);
  if (res.status === 401) throw Object.assign(new Error('Token invalide ou expiré.'), { status: 401 });
  if (res.status === 404) throw Object.assign(new Error('Ressource introuvable.'), { status: 404 });
  if (!res.ok) throw new Error(`Erreur serveur (${res.status})`);
  const text = await res.text();
  if (!text || text.trim() === '') throw new Error('Réponse vide du serveur.');
  return JSON.parse(text);
}

// ─── FORMAT helpers ───────────────────────────────────────────────────────────
function fmtDate(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
}
function fmtDateOnly(iso) {
  if (!iso) return '—';
  return new Date(iso).toLocaleDateString('fr-FR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}
function fmtNum(n) { return (n ?? 0).toLocaleString('fr-FR'); }
function fmtPct(v) { return v == null ? '—' : v + '%'; }
function escHtml(s) {
  return String(s ?? '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}
function heatBadge(h) {
  if (!h) return '<span class="heat-badge heat-null">—</span>';
  const map = { brulant: '🔥 Brûlant', chaud: '🌡 Chaud', tiede: '🌤 Tiède', froid: '❄ Froid', glace: '🧊 Glace' };
  return `<span class="heat-badge heat-${h}">${escHtml(map[h] || h)}</span>`;
}
function verdictBadge(v) {
  if (!v) return '<span class="verdict-badge verdict-attente">⏳ —</span>';
  const map = { APPROUVE: '✅ Approuvé', A_CREUSER: '🔍 À creuser', ECARTE: '❌ Écarté' };
  return `<span class="verdict-badge verdict-${v}">${escHtml(map[v] || v)}</span>`;
}
function canalBadges(channels) {
  if (!channels || !channels.length) return '—';
  return channels.map(c => `<span class="canal-badge canal-${c}">${escHtml(c)}</span>`).join('');
}
function enrichBadge(trigger) {
  if (!trigger) return '—';
  const map = { AUTO: 'Auto', HUMAN_GATE: 'Demande', STUCK_REPLAY_DEBLOCK: 'Récup.', MANUAL: 'Manuel' };
  return `<span class="enrich-badge">${escHtml(map[trigger] || trigger)}</span>`;
}
function companyNames(raw) {
  if (!raw) return '—';
  try {
    const arr = JSON.parse(raw);
    return arr.join(', ') || '—';
  } catch { return raw || '—'; }
}

// ─── VIEWS ────────────────────────────────────────────────────────────────────
function showView(name) {
  state.currentView = name;
  document.querySelectorAll('.view').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
  const view = document.getElementById(`view-${name}`);
  if (view) view.classList.add('active');
  const tab = document.querySelector(`.tab-btn[data-view="${name}"]`);
  if (tab) tab.classList.add('active');
  if (name === 'item') {
    document.getElementById('tab-item').style.display = '';
  }
}

// ─── AGG VIEW ─────────────────────────────────────────────────────────────────
async function loadAgg() {
  document.getElementById('agg-loading').style.display = '';
  document.getElementById('agg-content').style.display = 'none';
  document.getElementById('agg-error').style.display = 'none';

  try {
    const data = await apiFetch(buildUrl('dashboard-agg'));
    document.getElementById('client-name').textContent = data.meta.client_id.replace('CLIENT_', '');
    const tierEl = document.getElementById('client-tier');
    if (tierEl && data.meta.service_level) {
      tierEl.textContent = data.meta.service_level;
      tierEl.style.display = '';
    }
    renderKpis(data);
    renderFunnel(data.funnel, data);
    updateHeatCounts(data.chaleur || {});
    updateTriggerCounts(data.donut_enrichissement || {});
    updateVerdictCounts(data.verdicts || {});
    // Source Performance : visible si rôle admin OU flag dashboard_advanced_enabled
    // (activable par client via clients.dashboard_advanced_enabled, indépendant du service_level)
    const perfSection = document.getElementById('source-perf-section');
    const showPerf = !!(data.meta && (data.meta.role === 'admin' || data.meta.dashboard_advanced_enabled === true));
    if (perfSection) perfSection.style.display = showPerf ? '' : 'none';
    if (showPerf) renderSourcePerf(data.meta.source_performance || []);
    renderDonutEnrich(data.donut_enrichissement);
    renderDonutLivraison(data.donut_livraison);
    renderRatios(data.ratios);
    renderEntrepriseBreakdown(data.entreprise_breakdown);
    if (data.meta.sources_subscribed && data.meta.sources_subscribed.length) {
      populateSourcesFilter(data.meta.sources_subscribed, data.meta.sources_active_ids || []);
    }
    // Masquer le pavé Régions tant qu'aucun item n'a de région détectée sur la période
    // (sinon cocher 1 région exclut 100% des items via COALESCE(...) IN (...)).
    // À ré-activer dès que enrichissement remplit er.mission_location_region.
    const regionsBlock = document.querySelector('details.filter-group:has(#regions-filter-options)');
    const hasRegionData = Array.isArray(data.meta.regions_active) && data.meta.regions_active.length > 0;
    if (regionsBlock) regionsBlock.style.display = hasRegionData ? '' : 'none';
    if (hasRegionData && data.meta.regions_available && data.meta.regions_available.length) {
      populateRegionsFilter(data.meta.regions_available);
    }
    document.getElementById('agg-loading').style.display = 'none';
    document.getElementById('agg-content').style.display = '';
  } catch (e) {
    document.getElementById('agg-loading').style.display = 'none';
    document.getElementById('agg-error').style.display = '';
    document.getElementById('agg-error-msg').textContent = ' ' + e.message;
  }
}

function renderKpis(data) {
  const f = data.funnel;
  const r = data.ratios;
  const c = data.chaleur;
  const v = data.verdicts;
  const m = data.meta || {};

  const totalH = (c.brulants || 0) + (c.chauds || 0) + (c.tiedes || 0) + (c.froids || 0);
  const barW = (n, tot) => tot > 0 ? Math.max(1, Math.round(n / tot * 100)) : 0;
  const miniBar = (d, tot) =>
    `<div class="kpi-mini-bar">
      <span style="width:${barW(d.brulants,tot)}%;background:var(--heat-brulant)"></span>
      <span style="width:${barW(d.chauds,tot)}%;background:var(--heat-chaud)"></span>
      <span style="width:${barW(d.tiedes,tot)}%;background:var(--heat-tiede)"></span>
      <span style="width:${barW(d.froids,tot)}%;background:var(--heat-froid)"></span>
    </div>`;

  const totalV = (v.approuve||0) + (v.a_creuser||0) + (v.ecarte||0) + (v.attente||0);
  const verdictsExtra = `
    <div class="kpi-verdicts-grid">
      <div class="kpi-verdict-row"><span class="kpi-verdict-label">✅ Approuvé</span><span class="kpi-verdict-val" style="color:#14532d">${fmtNum(v.approuve)}</span></div>
      <div class="kpi-verdict-row"><span class="kpi-verdict-label">🔍 À creuser</span><span class="kpi-verdict-val" style="color:#16a34a">${fmtNum(v.a_creuser)}</span></div>
      <div class="kpi-verdict-row"><span class="kpi-verdict-label">❌ Écarté</span><span class="kpi-verdict-val" style="color:#0f172a">${fmtNum(v.ecarte)}</span></div>
      <div class="kpi-verdict-row"><span class="kpi-verdict-label">⏳ Sans verdict</span><span class="kpi-verdict-val" style="color:#6b7280">${fmtNum(v.attente)}</span></div>
    </div>`;

  const srcA = m.sources_actives_count || 0;
  const srcS = m.sources_subscribed_count || (data.meta && data.meta.sources_subscribed ? data.meta.sources_subscribed.length : 0);

  const cards = [
    { val: `${fmtNum(srcA)}<span class="kpi-suffix">/${fmtNum(srcS)}</span>`, label: '🛰 Sources analysées', ratio: srcS > 0 ? `${Math.round(srcA/srcS*100)}% souscrites actives` : '', cls: '', tooltip: 'Sources distinctes avec activité sur la période (raw_items OU pipeline_run_stats) / total souscrites par le client.' },
    { val: fmtNum(f.ingeres_bruts), label: '📥 Items collectés', ratio: '', cls: 'accent-navy', tooltip: 'Nombre d’items enregistrés en base (raw_items) sur la période et le périmètre filtré. Post-REGEX et post-dédup.' },
    { val: fmtNum(f.scores), label: '🌡 Scorés', ratio: '', extra: miniBar(c, totalH), cls: 'accent-navy', tooltip: 'Items avec un score (scored_at IS NOT NULL). Inclut Pass 1, et Pass 2 si zone grise déclenchée. La barre miniature montre la ventilation par chaleur.' },
    { val: fmtNum(f.pertinents), label: '🎯 Pertinents', ratio: fmtPct(r.rendement_scoring), cls: 'accent-navy', tooltip: 'Items scorés avec chaleur ≥ tiède (brûlant + chaud + tiède).\nRendement scoring = pertinents / extraits.' },
    { val: fmtNum(f.enrichis), label: '🔍 Enrichis', ratio: fmtPct(r.rendement_enrichissement), cls: 'accent-orange', tooltip: 'Items enrichis (Brave + Gold LLM) — enriched_at IS NOT NULL.\nRendement enrichissement = enrichis / pertinents.' },
    { val: fmtNum(f.livres), label: '<img src="logo-signalai.png" class="kpi-icon-img" alt=""> Livrés', ratio: fmtPct(r.rendement_livraison), cls: 'accent-green', tooltip: 'Items effectivement livrés (delivered_at IS NOT NULL).\nRendement livraison = livrés / pertinents.' },
    { val: fmtNum(totalV), label: '⚖ Verdicts', ratio: '', extra: verdictsExtra, cls: 'wide', tooltip: 'Verdicts humains saisis sur les items livrés.\nApprouvé / À creuser / Écarté / Sans verdict (= en attente de revue).' },
  ];

  document.getElementById('kpi-grid').innerHTML = cards.map(c => {
    const tip = c.tooltip ? ` data-tooltip="${escHtml(c.tooltip)}" title="${escHtml(c.tooltip)}"` : '';
    // Layout split horizontal pour les cards 'wide' (Verdicts) : valeur+label à GAUCHE, liste verdicts à droite
    if ((c.cls || '').includes('wide')) {
      return `<div class="kpi-card ${c.cls}"${tip}>
        <div class="kpi-split">
          <div class="kpi-split-left">
            <div class="kpi-value">${c.val}</div>
            <div class="kpi-label">${c.label}</div>
            ${c.ratio ? `<div class="kpi-ratio">${c.ratio} du flux</div>` : ''}
          </div>
          <div class="kpi-split-right">${c.extra || ''}</div>
        </div>
      </div>`;
    }
    return `<div class="kpi-card ${c.cls || ''}"${tip}>
      <div class="kpi-value">${c.val}</div>
      <div class="kpi-label">${c.label}</div>
      ${c.ratio ? `<div class="kpi-ratio">${c.ratio} du flux</div>` : ''}
      ${c.extra || ''}
    </div>`;
  }).join('');
}

function renderFunnel(f, data) {
  const c = data.chaleur || {};
  const v = data.verdicts || {};
  const totalV = (v.approuve||0) + (v.a_creuser||0) + (v.ecarte||0) + (v.attente||0);
  const m  = data.meta || {};

  // Palette refonte client (Q5 — contrastes pâle/foncé marqués)
  const COL = {
    rss_light:    '#93c5fd',  // RSS bleu clair
    others_dark:  '#1e3a8a',  // Autres bleu foncé
    glace_froid:  '#94a3b8',  // slate-400 — gris-bleu froid lisible sur blanc
    tiede:        '#fbbf24',  // jaune ambre
    chaud:        '#F05A1E',  // orange charte SignalAi
    brulant:      '#991b1b',  // rouge foncé
    verdict_app:  '#14532d',  // vert foncé
    verdict_cre:  '#86efac',  // vert pâle
    verdict_rej:  '#0f172a',  // noir
    verdict_non:  '#9ca3af',  // gray-400 — gris neutre lisible sur blanc
  };

  // Max pour calibrage = total collectés (upstream)
  const collectedTotal = (f.collected_rss || 0) + (f.collected_others || 0);
  const max = Math.max(1, collectedTotal, f.ingeres_bruts || 0);

  const makeSegBar = (totalVal, segments) => {
    const pct = Math.max(2, Math.round((totalVal / max) * 100));
    const segTotal = segments.reduce((a, s) => a + (s.val||0), 0);
    if (!segTotal) {
      return `<div class="funnel-bar-wrap"><div class="funnel-bar accent" style="width:${pct}%"></div></div>`;
    }
    const segs = segments.filter(s => s.val > 0).map(s => {
      const w = Math.round((s.val / segTotal) * 100);
      const style = s.hatched
        ? `flex:${w};background:repeating-linear-gradient(45deg, ${s.color} 0 6px, ${s.color}cc 6px 12px)`
        : `flex:${w};background:${s.color}`;
      return `<div style="${style}" title="${s.label}: ${fmtNum(s.val)}"></div>`;
    }).join('');
    return `<div class="funnel-bar-wrap"><div class="funnel-bar segmented" style="width:${pct}%">${segs}</div></div>`;
  };

  const steps = [
    {
      label: 'Collectés (non déjà vu)',
      sublabel: 'Items entrant dans REGEX — Autres (foncé) + RSS (clair)',
      val: collectedTotal,
      filter: null,
      bar: makeSegBar(collectedTotal, [
        { val: f.collected_others || 0, color: COL.others_dark, label: 'Autres (BODACC/BOAMP/FUSACQ)' },
        { val: f.collected_rss || 0,    color: COL.rss_light,   label: 'RSS' },
      ])
    },
    {
      label: 'Après filtre REGEX',
      sublabel: `RSS filtré (~${data.ratios && data.ratios.rendement_regex != null ? data.ratios.rendement_regex + '%' : '—'} rejeté) — Autres inchangés`,
      val: (f.after_regex_rss || 0) + (f.after_regex_others || 0),
      filter: null,
      bar: makeSegBar((f.after_regex_rss || 0) + (f.after_regex_others || 0), [
        { val: f.after_regex_others || 0, color: COL.others_dark, label: 'Autres' },
        { val: f.after_regex_rss || 0,    color: COL.rss_light,   label: 'RSS (post REGEX)' },
      ])
    },
    {
      label: 'Nouveaux (dédup URL faite)',
      sublabel: 'Items uniques entrés en base — Autres (foncé) + RSS (clair)',
      val: (f.nouveaux_rss || 0) + (f.nouveaux_others || 0),
      filter: null,
      bar: makeSegBar((f.nouveaux_rss || 0) + (f.nouveaux_others || 0), [
        { val: f.nouveaux_others || 0, color: COL.others_dark, label: 'Autres' },
        { val: f.nouveaux_rss || 0,    color: COL.rss_light,   label: 'RSS (uniques)' },
      ])
    },
    {
      label: 'Scorés',
      sublabel: 'Pass 1 + Pass 2 — du plus chaud au plus froid',
      val: f.scores,
      filter: null,
      bar: makeSegBar(f.scores, [
        { val: c.brulants || 0, color: COL.brulant,     label: '🔥 Brûlant' },
        { val: c.chauds   || 0, color: COL.chaud,       label: '🌡 Chaud' },
        { val: c.tiedes   || 0, color: COL.tiede,       label: '🌤 Tiède' },
        { val: c.froids   || 0, color: COL.glace_froid, label: '❄ Glacé+Froid' },
      ])
    },
    {
      label: 'Pertinents',
      sublabel: 'Chaleur ≥ tiède',
      val: f.pertinents,
      filter: { heats: ['brulant','chaud','tiede'] },
      bar: makeSegBar(f.pertinents, [
        { val: c.pertinents_brulants || 0, color: COL.brulant, label: '🔥 Brûlant' },
        { val: c.pertinents_chauds   || 0, color: COL.chaud,   label: '🌡 Chaud' },
        { val: c.pertinents_tiedes   || 0, color: COL.tiede,   label: '🌤 Tiède' },
      ])
    },
    {
      label: 'Enrichis',
      sublabel: 'Plein = auto, hachuré = sur demande',
      val: f.enrichis,
      filter: { triggers: ['AUTO','HUMAN_GATE','STUCK_REPLAY_DEBLOCK','MANUAL'] },
      bar: makeSegBar(f.enrichis, [
        { val: c.enrichis_brulants_auto    || 0, color: COL.brulant, label: '🔥 Brûlant (auto)' },
        { val: c.enrichis_brulants_demande || 0, color: COL.brulant, label: '🔥 Brûlant (sur demande)', hatched: true },
        { val: c.enrichis_chauds_auto      || 0, color: COL.chaud,   label: '🌡 Chaud (auto)' },
        { val: c.enrichis_chauds_demande   || 0, color: COL.chaud,   label: '🌡 Chaud (sur demande)',   hatched: true },
        { val: c.enrichis_tiedes_auto      || 0, color: COL.tiede,   label: '🌤 Tiède (auto)' },
        { val: c.enrichis_tiedes_demande   || 0, color: COL.tiede,   label: '🌤 Tiède (sur demande)',   hatched: true },
      ])
    },
    {
      label: 'Livrés',
      sublabel: 'Ventilation par chaleur',
      val: f.livres,
      filter: { channels: ['ALERT','DIGEST','WEEKLY','REDELIVERY'] },
      bar: makeSegBar(f.livres, [
        { val: c.livres_brulants || 0, color: COL.brulant, label: '🔥 Brûlant' },
        { val: c.livres_chauds   || 0, color: COL.chaud,   label: '🌡 Chaud' },
        { val: c.livres_tiedes   || 0, color: COL.tiede,   label: '🌤 Tiède' },
      ])
    },
    {
      label: 'Verdict humain',
      sublabel: `${fmtNum(totalV)} livrés évalués`,
      val: totalV,
      filter: null,
      bar: makeSegBar(totalV, [
        { val: v.approuve  || 0, color: COL.verdict_app, label: '✅ Approuvé' },
        { val: v.a_creuser || 0, color: COL.verdict_cre, label: '🔍 À creuser' },
        { val: v.ecarte    || 0, color: COL.verdict_rej, label: '❌ Écarté' },
        { val: v.attente   || 0, color: COL.verdict_non, label: '⏳ Sans verdict' },
      ])
    },
  ];

  const stepsHtml = steps.map(s => {
    const pctRaw = max > 0 ? (s.val / max) * 100 : 0;
    // Texte affiché : 1 décimale si < 1%, entier sinon (3/3513 = 0.1% au lieu de 2%)
    const pctText = pctRaw < 1 ? (Math.round(pctRaw * 10) / 10) : Math.round(pctRaw);
    return `<div class="funnel-step" data-filter='${s.filter ? JSON.stringify(s.filter) : ''}'>
      <div class="funnel-label">
        <div style="font-weight:500">${s.label}</div>
        <div style="font-size:10px;color:var(--text-light);margin-top:1px">${s.sublabel}</div>
      </div>
      ${s.bar}
      <div class="funnel-count">${fmtNum(s.val)}</div>
      <div class="funnel-pct">${pctText}%</div>
    </div>`;
  }).join('');

  document.getElementById('funnel-container').innerHTML = stepsHtml;

  document.querySelectorAll('.funnel-step[data-filter]').forEach(el => {
    const fd = el.dataset.filter;
    if (!fd) return;
    el.addEventListener('click', () => {
      const filters = JSON.parse(fd);
      Object.keys(state.filters).forEach(k => { state.filters[k] = []; });
      Object.entries(filters).forEach(([k, vals]) => { state.filters[k] = vals; });
      syncCheckboxes();
      navigateToList();
    });
  });
}

function renderSourcePerf(rows) {
  const tbody = document.getElementById('source-perf-tbody');
  if (!tbody) return;
  if (!rows || !rows.length) {
    tbody.innerHTML = '<tr><td colspan="10" style="text-align:center;color:var(--text-light);padding:24px">Aucune donnée sur la période</td></tr>';
    return;
  }
  const colorPct = (p, type) => {
    if (p == null) return '<span class="perf-null">—</span>';
    const v = Number(p);
    let cls = '';
    if (type === 'regex') {
      cls = v >= 80 ? 'perf-good' : (v >= 40 ? 'perf-warn' : 'perf-bad');
    } else if (type === 'dedup') {
      cls = v <= 30 ? 'perf-good' : (v <= 70 ? 'perf-warn' : 'perf-bad');
    } else if (type === 'yield') {
      cls = v >= 5 ? 'perf-good' : (v >= 1 ? 'perf-warn' : 'perf-bad');
    } else if (type === 'pertinence') {
      cls = v >= 20 ? 'perf-good' : (v >= 5 ? 'perf-warn' : 'perf-bad');
    }
    return `<span class="${cls}">${v}%</span>`;
  };
  tbody.innerHTML = rows.map(r => {
    const collected  = Number(r.collected || 0);
    const inserted   = Number(r.inserted || 0);
    const scored     = Number(r.scored || 0);
    const pertinents = Number(r.pertinents || 0);
    // Ligne rouge si bavarde (collected > 0) mais aucune insertion (= filtrée intégralement par REGEX/dédup)
    const isMuted = collected > 0 && inserted === 0;
    const pertinencePct = scored > 0 ? Math.round((pertinents / scored) * 1000) / 10 : null;
    return `
    <tr class="${isMuted ? 'row-muted' : ''}">
      <td title="${escHtml(r.source_id)}">${escHtml(r.source_name)}</td>
      <td>${fmtNum(collected)}</td>
      <td>${r.has_regex ? fmtNum(Number(r.regex_pass || 0)) : '<span class="perf-null">N/A</span>'}</td>
      <td>${r.has_regex ? colorPct(r.regex_efficacy_pct, 'regex') : '<span class="perf-null">N/A</span>'}</td>
      <td>${fmtNum(inserted)}</td>
      <td>${fmtNum(scored)}</td>
      <td>${fmtNum(pertinents)}</td>
      <td>${colorPct(pertinencePct, 'pertinence')}</td>
      <td>${colorPct(r.dedup_rate_pct, 'dedup')}</td>
      <td>${colorPct(r.signal_yield_pct, 'yield')}</td>
    </tr>
  `;
  }).join('');
}

// Phase 4 S-150B : ventilation région + secteur (items chauds+brûlants, période sidebar)
// Source : entreprise_data->'primary' (S-150B Phase 1) avec fallback region_best per-client.
// Gap connu : pas de mutualisation cross-client (region_best_global) — à ajouter si besoin.
function renderEntrepriseBreakdown(eb) {
  const section = document.getElementById('entreprise-breakdown-row');
  if (!section) return;
  const regions = (eb && Array.isArray(eb.regions)) ? eb.regions : [];
  const sectors = (eb && Array.isArray(eb.sectors)) ? eb.sectors : [];
  if (regions.length === 0 && sectors.length === 0) {
    section.style.display = 'none';
    return;
  }
  section.style.display = '';

  const TOP_N = 8;
  const renderList = (rows, target) => {
    const el = document.getElementById(target);
    if (!el) return;
    if (!rows.length) {
      el.innerHTML = '<div class="breakdown-empty">Aucun item chaud/brûlant résolu sur la période</div>';
      return;
    }
    const total = rows.reduce((acc, r) => acc + Number(r.count || 0), 0);
    const max = rows[0] ? Number(rows[0].count || 0) : 1;
    const top = rows.slice(0, TOP_N);
    const rest = rows.slice(TOP_N);
    const restTotal = rest.reduce((acc, r) => acc + Number(r.count || 0), 0);
    let html = top.map(r => {
      const c = Number(r.count || 0);
      const pct = total > 0 ? Math.round((c / total) * 1000) / 10 : 0;
      const w = max > 0 ? Math.max(2, Math.round((c / max) * 100)) : 2;
      const lbl = r.label || '—';
      return `<div class="breakdown-row">
        <div class="breakdown-label" title="${escHtml(lbl)}">${escHtml(lbl)}</div>
        <div class="breakdown-bar-wrap"><div class="breakdown-bar" style="width:${w}%"></div></div>
        <div class="breakdown-count">${fmtNum(c)}</div>
        <div class="breakdown-pct">${pct}%</div>
      </div>`;
    }).join('');
    if (rest.length > 0) {
      html += `<div class="breakdown-more">+${rest.length} autres (${fmtNum(restTotal)} items)</div>`;
    }
    el.innerHTML = html;
  };

  renderList(regions, 'breakdown-region-list');
  renderList(sectors, 'breakdown-sector-list');
}

function renderDonutEnrich(d) {
  const vals = [d.auto, d.sur_demande, d.recuperation, d.manuel, d.autre];
  const total = vals.reduce((a,b) => a + b, 0);
  const labels = ['Automatique', 'Sur demande', 'Récupération', 'Manuel', 'Autre'];
  const colors = ['#F05A1E', '#3b82f6', '#22c55e', '#94a3b8', '#e2e8f0'];

  const wrap = document.getElementById('donut-enrich-wrap');
  if (total === 0) {
    wrap.innerHTML = '<div class="empty-chart">Aucun enrichissement<br>sur la période</div>';
    return;
  }

  if (state.donutEnrichChart) state.donutEnrichChart.destroy();
  wrap.innerHTML = `<canvas id="donut-enrich" width="100" height="100"></canvas><div class="donut-legend" id="donut-enrich-legend"></div>`;

  state.donutEnrichChart = new Chart(document.getElementById('donut-enrich'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data: vals, backgroundColor: colors, borderWidth: 1 }] },
    options: { plugins: { legend: { display: false } }, cutout: '65%', animation: { duration: 400 } }
  });

  document.getElementById('donut-enrich-legend').innerHTML = labels.map((l, i) =>
    vals[i] > 0 ? `<div class="donut-legend-item">
      <div class="donut-legend-dot" style="background:${colors[i]}"></div>
      <span>${l}</span>
      <span class="donut-legend-val">${vals[i]}</span>
    </div>` : ''
  ).join('');
}

function renderDonutLivraison(d) {
  const vals = [d.alert, d.digest, d.weekly || 0, d.redelivery];
  const total = vals.reduce((a,b) => a + b, 0);
  const labels = ['ALERT', 'DIGEST', 'WEEKLY', 'REDELIVERY'];
  const colors = ['#F05A1E', '#3b82f6', '#7c3aed', '#22c55e'];

  const wrap = document.getElementById('donut-livraison-wrap');
  const card = wrap ? wrap.closest('.chart-card') : null;
  if (total === 0) {
    if (card) card.style.display = 'none';
    return;
  }
  if (card) card.style.display = '';

  if (state.donutLivraisonChart) state.donutLivraisonChart.destroy();
  wrap.innerHTML = `<canvas id="donut-livraison" width="100" height="100"></canvas><div class="donut-legend" id="donut-livraison-legend"></div>`;

  state.donutLivraisonChart = new Chart(document.getElementById('donut-livraison'), {
    type: 'doughnut',
    data: { labels, datasets: [{ data: vals, backgroundColor: colors, borderWidth: 1 }] },
    options: { plugins: { legend: { display: false } }, cutout: '65%', animation: { duration: 400 } }
  });

  document.getElementById('donut-livraison-legend').innerHTML = labels.map((l, i) =>
    `<div class="donut-legend-item">
      <div class="donut-legend-dot" style="background:${colors[i]}"></div>
      <span>${l}</span>
      <span class="donut-legend-val">${vals[i]}</span>
    </div>`
  ).join('');
}

function renderRatios(r) {
  const defs = [
    { key: 'rendement_regex',          label: 'Rendement REGEX',     tip: '% d’items RSS rejetés par le filtre REGEX (= 1 − regex_pass_rss / collected_rss_upstream). Calculé sur les RSS uniquement (BODACC/BOAMP/FUSACQ n’ont pas de REGEX).' },
    { key: 'rendement_scoring',        label: 'Rendement scoring',   tip: '% d’items pertinents (chaleur ≥ tiède) parmi les extraits.\nFormule : pertinents / extraits.' },
    { key: 'rendement_enrichissement', label: 'Rendement enrich.',   tip: '% d’items pertinents qui ont été enrichis (Brave + Gold LLM).\nFormule : enrichis / pertinents.' },
    { key: 'rendement_livraison',      label: 'Rendement livraison', tip: '% d’items pertinents qui ont été livrés.\nFormule : livrés / pertinents.' },
    { key: 'rendement_final',          label: 'Rendement final',     tip: '% d’items enrichis approuvés par humain.\nFormule : approuvés / enrichis.' },
    { key: 'taux_bruit',               label: 'Taux de bruit',       tip: '% d’items écartés par règles d’exclusion (globales/client) ou par verdict ECARTE.\nFormule : écartés / items collectés.' },
  ];
  document.getElementById('ratios-grid').innerHTML = defs.map(d => {
    const v = r[d.key];
    const isNull = v == null;
    return `<div class="ratio-item" data-tooltip="${escHtml(d.tip)}" title="${escHtml(d.tip)}">
      <div class="ratio-name">${d.label}</div>
      <div class="ratio-val ${isNull ? 'null-val' : ''}">${isNull ? '—' : v + '%'}</div>
    </div>`;
  }).join('');

  const titleEl = document.getElementById('ratios-card-title');
  if (titleEl) {
    if (state.filters.sources.length === 1) {
      const srcId = state.filters.sources[0];
      const srcName = state.sourcesMap[srcId] || srcId;
      titleEl.textContent = `Ratios — ${srcName}`;
    } else {
      titleEl.textContent = "Ratios d'efficacité";
    }
  }
}

// ─── LIST VIEW ─────────────────────────────────────────────────────────────────
async function loadList() {
  document.getElementById('list-loading').style.display = '';
  document.getElementById('list-content').style.display = 'none';
  document.getElementById('list-error').style.display = 'none';

  try {
    const data = await apiFetch(buildUrl('dashboard-list', {
      page: state.listPage,
      page_size: state.listPageSize,
      sort: state.listSort,
      search: state.listSearch || undefined,
    }));
    state.listTotal = data.meta.total;
    renderTable(data.items);
    renderPagination(data.meta);
    document.getElementById('list-count').textContent =
      `${fmtNum(data.meta.total)} item${data.meta.total !== 1 ? 's' : ''}`;
    document.getElementById('list-loading').style.display = 'none';
    document.getElementById('list-content').style.display = '';
  } catch (e) {
    document.getElementById('list-loading').style.display = 'none';
    document.getElementById('list-error').style.display = '';
    document.getElementById('list-error-msg').textContent = ' ' + e.message;
  }
}

function renderTable(items) {
  if (!items.length) {
    document.getElementById('items-tbody').innerHTML =
      '<tr><td colspan="10" style="text-align:center;padding:32px;color:var(--text-light)">Aucun résultat</td></tr>';
    return;
  }
  document.getElementById('items-tbody').innerHTML = items.map(it => `
    <tr data-item-id="${escHtml(it.item_id)}">
      <td class="col-date">${fmtDateOnly(it.created_at)}</td>
      <td style="max-width:100px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="${escHtml(it.source_name || it.source_id)}">${escHtml(it.source_name || it.source_id || '—')}</td>
      <td class="col-company">${escHtml(companyNames(it.score_company_names))}</td>
      <td style="color:var(--text-muted);font-size:11px">${escHtml(it.region || '—')}</td>
      <td class="col-title"><span title="${escHtml(it.title)}">${escHtml(it.title)}</span></td>
      <td>${heatBadge(it.score_heat_level)}</td>
      <td>${enrichBadge(it.enrichment_trigger)}</td>
      <td>${canalBadges(it.delivered_channels)}</td>
      <td>${verdictBadge(it.human_verdict)}</td>
      <td class="col-arrow">→</td>
    </tr>`).join('');

  document.querySelectorAll('#items-tbody tr').forEach(row => {
    row.addEventListener('click', () => {
      const itemId = row.dataset.itemId;
      if (itemId) openItem(itemId);
    });
  });
}

function renderPagination(meta) {
  const from = ((meta.page - 1) * meta.page_size) + 1;
  const to = Math.min(meta.page * meta.page_size, meta.total);
  document.getElementById('page-info').textContent =
    meta.total ? `${fmtNum(from)}–${fmtNum(to)} / ${fmtNum(meta.total)}` : '0 résultats';
  document.getElementById('btn-prev').disabled = meta.page <= 1;
  document.getElementById('btn-next').disabled = meta.page >= meta.pages;
}


// ─── ITEM VIEW ─────────────────────────────────────────────────────────────────
async function openItem(itemId) {
  state.currentItemId = itemId;
  document.getElementById('tab-item').style.display = '';
  showView('item');
  document.getElementById('item-loading').style.display = '';
  document.getElementById('item-content').style.display = 'none';
  document.getElementById('item-error').style.display = 'none';

  try {
    const data = await apiFetch(`${API_BASE}/dashboard-item?token=${encodeURIComponent(state.token)}&item_id=${encodeURIComponent(itemId)}`);
    renderItem(data.item);
    document.getElementById('item-loading').style.display = 'none';
    document.getElementById('item-content').style.display = '';
  } catch (e) {
    document.getElementById('item-loading').style.display = 'none';
    document.getElementById('item-error').style.display = '';
    document.getElementById('item-error-msg').textContent = ' ' + (e.status === 404 ? 'Item introuvable ou accès refusé.' : e.message);
  }
}

function renderItem(it) {
  const f = (label, value, cls = '') =>
    `<div class="field-row"><div class="field-label">${label}</div><div class="field-value ${cls}">${value}</div></div>`;
  const bool = v => v ? '<span class="bool-true">✓ Oui</span>' : '<span class="bool-false">Non</span>';

  const timeline = buildTimeline(it);

  document.getElementById('item-content').innerHTML = `

    <!-- Signal -->
    <details class="item-section" open>
      <summary>Signal</summary>
      <div class="item-body">
        ${f('Titre', `<a href="${escHtml(it.url)}" target="_blank" rel="noopener">${escHtml(it.title)}</a>`)}
        ${f('Source', escHtml(it.source_name || it.source_id || '—'))}
        ${f('Ingéré', fmtDate(it.created_at))}
        ${f('Publié', escHtml(it.published_at || '—'))}
        ${f('Statut', `<code>${escHtml(it.status)}</code>`)}
      </div>
    </details>

    <!-- REGEX -->
    <details class="item-section">
      <summary>Filtrage REGEX</summary>
      <div class="item-body">
        ${f('Include matched', bool(it.include_matched))}
        ${f('Exclu global', bool(it.exclude_global_matched))}
        ${f('Exclu client', bool(it.exclude_client_matched))}
        ${f('Filtre 1 OK', bool(it.first_filter_pass))}
        ${it.signal_match_count ? f('Nb matches', escHtml(it.signal_match_count)) : ''}
      </div>
    </details>

    <!-- Scoring -->
    <details class="item-section" open>
      <summary>Scoring</summary>
      <div class="item-body">
        ${f('Chaleur', heatBadge(it.score_heat_level))}
        ${f('Confiance', it.score_confidence != null ? `<strong>${it.score_confidence}%</strong>` : '—')}
        ${f('Entreprises', escHtml(companyNames(it.score_company_names)))}
        ${it.score_evidence_snippet ? f('Extrait', `<div class="score-text">${escHtml(it.score_evidence_snippet)}</div>`) : ''}
        ${it.score_why ? f('Pourquoi', `<div class="score-text">${escHtml(it.score_why)}</div>`) : ''}
        ${it.score_emt_reasoning ? f('Raisonnement', `<div class="score-text">${escHtml(it.score_emt_reasoning)}</div>`) : ''}
        ${it.score_next_action ? f('Action suggérée', `<div class="score-text">${escHtml(it.score_next_action)}</div>`) : ''}
        ${f('Scoré le', fmtDate(it.scored_at))}
        ${it.scored_model ? f('Modèle', escHtml(it.scored_model)) : ''}
        ${f('Pass 2 appliqué', bool(it.score_pass2_applied))}
      </div>
    </details>

    <!-- Enrichissement -->
    ${it.enriched_at ? `
    <details class="item-section" open>
      <summary>Enrichissement</summary>
      <div class="item-body">
        ${f('Trigger', enrichBadge(it.enrichment_trigger))}
        ${f('Entreprise', escHtml(it.company_name_exact || '—'))}
        ${it.siren ? f('SIREN', escHtml(it.siren)) : ''}
        ${it.company_size ? f('Taille', escHtml(it.company_size)) : ''}
        ${it.company_sector ? f('Secteur', escHtml(it.company_sector)) : ''}
        ${it.company_hq_location ? f('HQ', escHtml(it.company_hq_location)) : ''}
        ${it.mission_location_region ? f('Région', escHtml(it.mission_location_region)) : ''}
        ${it.contact_name ? f('Contact', `${escHtml(it.contact_name)}${it.contact_title ? ' — ' + escHtml(it.contact_title) : ''}${it.contact_linkedin ? ` <a href="${escHtml(it.contact_linkedin)}" target="_blank">LinkedIn</a>` : ''}`) : ''}
        ${it.mission_type ? f('Type mission', escHtml(it.mission_type)) : ''}
        ${it.urgency ? f('Urgence', `<strong>${escHtml(it.urgency)}</strong>${it.urgency_rationale ? ' — ' + escHtml(it.urgency_rationale) : ''}`) : ''}
        ${it.signal_summary ? f('Résumé', `<div class="score-text">${escHtml(it.signal_summary)}</div>`) : ''}
        ${it.talking_points ? f('Talking points', `<div class="score-text">${escHtml(Array.isArray(it.talking_points) ? it.talking_points.join('\n') : it.talking_points)}</div>`) : ''}
        ${it.recommended_action ? f('Action recommandée', `<div class="score-text">${escHtml(it.recommended_action)}</div>`) : ''}
        ${f('Enrichi le', fmtDate(it.enriched_at))}
        ${it.enriched_model ? f('Modèle', escHtml(it.enriched_model)) : ''}
      </div>
    </details>` : ''}

    <!-- Gold -->
    ${it.gold_pass2_done ? `
    <details class="item-section">
      <summary>🏆 Gold</summary>
      <div class="item-body">
        ${it.gold_narrative ? f('Narrative', `<div class="score-text">${escHtml(it.gold_narrative)}</div>`) : ''}
        ${it.gold_contact_name ? f('Contact Gold', `${escHtml(it.gold_contact_name)}${it.gold_contact_title ? ' — ' + escHtml(it.gold_contact_title) : ''}${it.gold_contact_linkedin_url ? ` <a href="${escHtml(it.gold_contact_linkedin_url)}" target="_blank">LinkedIn</a>` : ''}`) : ''}
        ${it.gold_talking_points ? f('Talking points', `<div class="score-text">${escHtml(Array.isArray(it.gold_talking_points) ? it.gold_talking_points.join('\n') : it.gold_talking_points)}</div>`) : ''}
        ${f('Enrichi Gold le', fmtDate(it.gold_enriched_at))}
      </div>
    </details>` : ''}

    <!-- Décision humaine -->
    <details class="item-section">
      <summary>Décision humaine</summary>
      <div class="item-body">
        ${f('Verdict', verdictBadge(it.human_verdict))}
        ${it.human_verdict_at ? f('Date verdict', fmtDate(it.human_verdict_at)) : ''}
        ${it.human_heat_level ? f('Chaleur corrigée', heatBadge(it.human_heat_level)) : ''}
      </div>
    </details>

    <!-- Livraison -->
    <details class="item-section">
      <summary>Livraison</summary>
      <div class="item-body">
        ${f('Canaux', canalBadges(it.delivered_channels))}
        ${it.delivered_at ? f('Livré le', fmtDate(it.delivered_at)) : ''}
      </div>
    </details>

    <!-- Timeline -->
    <div class="item-section" style="overflow:visible">
      <div style="padding:12px 16px;background:var(--bg);border-bottom:1px solid var(--border);font-size:13px;font-weight:600">Cycle de vie</div>
      <div class="item-body">
        <ol class="timeline">${timeline}</ol>
      </div>
    </div>`;
}

function buildTimeline(it) {
  const steps = [
    { label: 'Ingéré',   done: !!it.created_at,   ts: it.created_at },
    { label: 'REGEX',    done: !!it.first_filter_pass, ts: null },
    { label: 'Extrait',  done: it.status && !['TO_EXTRACT','ERROR'].includes(it.status), ts: null },
    { label: 'Scoré',    done: !!it.scored_at,     ts: it.scored_at },
    { label: 'Enrichi',  done: !!it.enriched_at,   ts: it.enriched_at },
    { label: 'Livré',    done: !!it.delivered_at,  ts: it.delivered_at },
    { label: 'Verdict',  done: !!it.human_verdict, ts: it.human_verdict_at },
  ];
  return steps.map(s =>
    `<li class="tl-step ${s.done ? 'done' : ''}">
      <div class="tl-dot">${s.done ? '✓' : ''}</div>
      <div class="tl-label">${s.label}</div>
      ${s.ts ? `<div class="tl-ts">${fmtDateOnly(s.ts)}</div>` : '<div class="tl-ts"></div>'}
    </li>`
  ).join('');
}

// ─── FILTER GROUP CARDINALITY ─────────────────────────────────────────────────
// Met à jour les labels des checkboxes (heats / triggers / verdicts) avec la cardinalité
// réelle de la période. Important : capturer la baseline UNIQUEMENT quand le groupe
// n'a pas de filtre actif (sinon les compteurs sont eux-mêmes filtrés et tombent à 0
// pour les options décochées).
const _countsBaseline = { heats: null, triggers: null, verdicts: null };
function _renderCountsForGroup(name) {
  const baseline = _countsBaseline[name];
  if (!baseline) return;
  document.querySelectorAll(`input[type=checkbox][name="${name}"]`).forEach(cb => {
    const v = cb.value;
    const n = baseline[v];
    if (n == null) return;
    const label = cb.closest('.filter-option');
    if (!label) return;
    let cnt = label.querySelector('.heat-count');
    if (!cnt) {
      cnt = document.createElement('span');
      cnt.className = 'heat-count';
      label.appendChild(cnt);
    }
    cnt.textContent = ' (' + fmtNum(n) + ')';
  });
}
function updateHeatCounts(chaleur) {
  if (!state.filters.heats.length) {
    _countsBaseline.heats = {
      brulant: chaleur.brulants || 0,
      chaud:   chaleur.chauds   || 0,
      tiede:   chaleur.tiedes   || 0,
      froid:   chaleur.froids   || 0, // froid+glace fusionnés
    };
  }
  _renderCountsForGroup('heats');
}
function updateTriggerCounts(donut) {
  if (!state.filters.triggers.length) {
    _countsBaseline.triggers = {
      AUTO:                 donut.auto         || 0,
      HUMAN_GATE:           donut.sur_demande  || 0,
      STUCK_REPLAY_DEBLOCK: donut.recuperation || 0,
      MANUAL:               donut.manuel       || 0,
    };
  }
  _renderCountsForGroup('triggers');
}
function updateVerdictCounts(v) {
  if (!state.filters.verdicts.length) {
    _countsBaseline.verdicts = {
      APPROUVE:  v.approuve  || 0,
      A_CREUSER: v.a_creuser || 0,
      ECARTE:    v.ecarte    || 0,
      attente:   v.attente   || 0,
    };
  }
  _renderCountsForGroup('verdicts');
}

// ─── FILTERS ─────────────────────────────────────────────────────────────────
function bindFilterCheckboxes() {
  document.querySelectorAll('input[type=checkbox][name]').forEach(cb => {
    cb.removeEventListener('change', onCheckboxChange);
    cb.addEventListener('change', onCheckboxChange);
  });
  document.querySelectorAll('.filter-btn-sm').forEach(btn => {
    btn.removeEventListener('click', onFilterBtnClick);
    btn.addEventListener('click', onFilterBtnClick);
  });
}

function onCheckboxChange(e) {
  const name = e.target.name;
  const val = e.target.value;
  const also = e.target.dataset.also || null;
  if (e.target.checked) {
    if (!state.filters[name].includes(val)) state.filters[name].push(val);
    if (also && !state.filters[name].includes(also)) state.filters[name].push(also);
  } else {
    state.filters[name] = state.filters[name].filter(v => v !== val && v !== also);
  }
  onFilterChange();
}

function onFilterBtnClick(e) {
  const group = e.target.dataset.group;
  const action = e.target.dataset.action;
  if (!group) return;
  const checkboxes = document.querySelectorAll(`input[type=checkbox][name="${group}"]`);
  if (action === 'all') {
    checkboxes.forEach(cb => { cb.checked = true; });
    state.filters[group] = [...checkboxes].map(cb => cb.value);
  } else if (action === 'none') {
    checkboxes.forEach(cb => { cb.checked = false; });
    state.filters[group] = [];
  }
  onFilterChange();
}

function syncCheckboxes() {
  ['heats','verdicts','triggers','channels','sources','regions'].forEach(name => {
    document.querySelectorAll(`input[type=checkbox][name="${name}"]`).forEach(cb => {
      cb.checked = state.filters[name].includes(cb.value);
    });
  });
}

function onFilterChange() {
  if (state.currentView === 'agg') loadAgg();
  else if (state.currentView === 'list') { state.listPage = 1; loadList(); }
}

function navigateToList() {
  showView('list');
  state.listPage = 1;
  loadList();
}

let _sourcesPopulated = false;
function populateSourcesFilter(sources, activeIds) {
  if (!sources || !sources.length) return;
  // Toujours mettre à jour le map (utilisé par renderRatios pour le titre)
  sources.forEach(s => { state.sourcesMap[String(s.source_id)] = s.source_name || String(s.source_id); });
  // Mettre à jour le set des sources actives à chaque appel (la période change peut le modifier)
  const activeSet = new Set((activeIds || []).map(String));
  if (_sourcesPopulated) {
    // Rebuild only the dimming state — without re-creating checkboxes (évite flicker / perte focus)
    document.querySelectorAll('#sources-filter-options .filter-option[data-source-id]').forEach(el => {
      const id = el.dataset.sourceId;
      el.classList.toggle('is-silent', !activeSet.has(id));
    });
    return;
  }
  _sourcesPopulated = true;
  // Premier populate : pré-cocher toutes les sources souscrites (UX "tout actif par défaut").
  // Si user décoche tout, on enverra __NONE__ au backend → 0 résultat.
  if (state.filters.sources.length === 0) {
    state.filters.sources = sources.map(s => String(s.source_id));
  }
  const arr = [...sources].sort((a,b) => (a.source_name||'').localeCompare(b.source_name||''));
  const container = document.getElementById('sources-filter-options');
  container.innerHTML =
    '<div class="filter-actions"><button class="filter-btn-sm" data-group="sources" data-action="all">Tout</button><button class="filter-btn-sm" data-group="sources" data-action="none">Aucun</button></div>' +
    arr.map(s => {
      const id = String(s.source_id);
      const isSilent = !activeSet.has(id);
      return `<label class="filter-option${isSilent ? ' is-silent' : ''}" data-source-id="${escHtml(id)}" title="${isSilent ? 'Aucune activité sur cette période' : 'Active sur cette période'}"><input type="checkbox" name="sources" value="${escHtml(id)}"${state.filters.sources.includes(id) ? ' checked' : ''}> <span class="src-name">${escHtml(s.source_name || s.source_id)}</span>${isSilent ? '<span class="src-silent-dot" title="silencieuse"></span>' : ''}</label>`;
    }).join('');
  bindFilterCheckboxes();
}

let _regionsPopulated = false;
function populateRegionsFilter(regions) {
  if (!regions || !regions.length) return;
  const container = document.getElementById('regions-filter-options');
  // Update silent state on subsequent calls (range change) without rebuild
  if (_regionsPopulated) {
    const activeSet = new Set(regions.filter(r => r.is_active).map(r => r.value));
    container.querySelectorAll('.filter-option[data-region-value]').forEach(el => {
      const v = el.dataset.regionValue;
      el.classList.toggle('is-silent', !activeSet.has(v));
    });
    return;
  }
  _regionsPopulated = true;
  const withItems    = regions.filter(r => r.is_active);
  const withoutItems = regions.filter(r => !r.is_active);
  const renderRow = (r, silent) =>
    `<label class="filter-option${silent ? ' is-silent' : ''}" data-region-value="${escHtml(r.value)}" title="${silent ? 'Souscrite — aucun item sur la période' : 'Souscrite — avec items'}"><input type="checkbox" name="regions" value="${escHtml(r.value)}"${state.filters.regions.includes(r.value) ? ' checked' : ''}> <span class="src-name">${escHtml(r.label)}</span>${silent ? '<span class="src-silent-dot" title="sans item"></span>' : ''}</label>`;
  const blocks = [
    '<div class="filter-actions"><button class="filter-btn-sm" data-group="regions" data-action="all">Tout</button><button class="filter-btn-sm" data-group="regions" data-action="none">Aucun</button></div>',
  ];
  if (withItems.length) {
    blocks.push(withItems.map(r => renderRow(r, false)).join(''));
  }
  if (withoutItems.length) {
    blocks.push('<div class="filter-subgroup">SANS ITEM</div>');
    blocks.push(withoutItems.map(r => renderRow(r, true)).join(''));
  }
  container.innerHTML = blocks.join('');
  bindFilterCheckboxes();
}

// ─── EVENTS ───────────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
  if (!state.token) {
    document.getElementById('main-content').innerHTML =
      '<div class="error-banner"><strong>Token manquant</strong>Ajoutez <code>?t=votre_token</code> à l\'URL.</div>';
    return;
  }

  // Tabs
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const view = btn.dataset.view;
      showView(view);
      if (view === 'agg') loadAgg();
      else if (view === 'list') { state.listPage = 1; loadList(); }
    });
  });

  // Range selector
  document.getElementById('range-select').addEventListener('change', e => {
    state.range = e.target.value;
    if (state.currentView === 'agg') loadAgg();
    else if (state.currentView === 'list') { state.listPage = 1; loadList(); }
  });

  // Search
  document.getElementById('search-input').addEventListener('input', e => {
    clearTimeout(state.searchTimer);
    state.searchTimer = setTimeout(() => {
      state.listSearch = e.target.value;
      state.listPage = 1;
      loadList();
    }, 400);
  });

  // Sort
  document.getElementById('sort-select').addEventListener('change', e => {
    state.listSort = e.target.value;
    state.listPage = 1;
    loadList();
  });

  // Pagination
  document.getElementById('btn-prev').addEventListener('click', () => {
    if (state.listPage > 1) { state.listPage--; loadList(); }
  });
  document.getElementById('btn-next').addEventListener('click', () => {
    const maxPage = Math.ceil(state.listTotal / state.listPageSize);
    if (state.listPage < maxPage) { state.listPage++; loadList(); }
  });

  // Back btn
  document.getElementById('item-back-btn').addEventListener('click', () => {
    showView('list');
    loadList();
  });

  // Initial filter checkbox bindings
  bindFilterCheckboxes();

  // Initial load
  loadAgg();
});
