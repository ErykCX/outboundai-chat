const tabs = document.querySelectorAll('.tab');
const panels = document.querySelectorAll('.panel');
let UI_CHAT_ONLY = false;

function activateTab(tabName) {
  tabs.forEach((t) => t.classList.remove('active'));
  panels.forEach((p) => p.classList.remove('active'));
  const tabEl = [...tabs].find((t) => t.dataset.tab === tabName);
  const panelEl = document.getElementById(tabName);
  if (tabEl) tabEl.classList.add('active');
  if (panelEl) panelEl.classList.add('active');
}

tabs.forEach((tab) => {
  tab.addEventListener('click', () => {
    activateTab(tab.dataset.tab);
  });
});

function applyUiMode() {
  if (!UI_CHAT_ONLY) return;
  tabs.forEach((tab) => {
    const keep = tab.dataset.tab === 'chat';
    tab.style.display = keep ? '' : 'none';
  });
  panels.forEach((panel) => {
    panel.style.display = panel.id === 'chat' ? '' : 'none';
  });
  activateTab('chat');
}

function esc(v) {
  return String(v ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function statusBadge(status) {
  const s = String(status || 'unknown');
  const cls = s === 'completed' ? 'ok' : s === 'in_progress' ? 'warn' : 'err';
  return `<span class="badge ${cls}">${esc(s)}</span>`;
}

const FLOW_ORDER = [
  'intro',
  'recording_consent',
  'identity_gate',
  'pitch',
  'objection',
  'data_confirmation',
  'end_success',
  'end_reject',
  'end_compliance',
  'end_handoff'
];
const chatRuntime = {
  call_id: '',
  current_state: 'intro',
  context: {}
};
let learningStateOptions = [...FLOW_ORDER];
function refreshLearningStateFilterOptions() {
  const select = document.getElementById('learning-state-filter');
  if (!select) return;
  const prev = select.value || 'all';
  select.innerHTML = '<option value="all">alle states</option>';
  (learningStateOptions || []).forEach((key) => {
    const opt = document.createElement('option');
    opt.value = key;
    opt.textContent = key;
    if (key === prev) opt.selected = true;
    select.appendChild(opt);
  });
  if (!select.value) select.value = 'all';
}
function renderLearningCreateStates() {
  const root = document.getElementById('learning-create-states');
  if (!root) return;
  root.innerHTML = '';
  (learningStateOptions || []).forEach((stateKey, idx) => {
    const label = document.createElement('label');
    label.innerHTML = `<input type="checkbox" class="learning-create-state-cb" value="${esc(stateKey)}" ${idx === 0 ? 'checked' : ''} /> ${esc(stateKey)}`;
    root.appendChild(label);
  });
}
function stateRank(key) {
  const idx = FLOW_ORDER.indexOf(String(key || ''));
  return idx === -1 ? 999 : idx;
}
function sortStatesByFlow(states) {
  return [...(states || [])].sort((a, b) => {
    const ra = stateRank(a.key);
    const rb = stateRank(b.key);
    if (ra !== rb) return ra - rb;
    return String(a.key || '').localeCompare(String(b.key || ''));
  });
}

function scrollChatToBottom() {
  const view = document.getElementById('chat-view');
  if (!view) return;
  view.scrollTop = 0;
}

let chatMsgCounter = 0;
function renderMessageHtml(role, text, metaText, infoObj) {
  const infoId = `chat-info-${chatMsgCounter++}`;
  const infoJson = infoObj ? JSON.stringify(infoObj, null, 2) : JSON.stringify({ note: 'Keine Zusatzdaten' }, null, 2);
  return `
    <div class="msg-head">
      <span>${esc(role)}</span>
      <button class="info-btn" type="button" data-target="${infoId}">Info</button>
    </div>
    <div>${esc(text)}</div>
    <span class="meta">${esc(metaText || '')}</span>
    <pre id="${infoId}" class="msg-info hidden">${esc(infoJson)}</pre>
  `;
}

function bindInfoButtons(container) {
  container.querySelectorAll('.info-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = btn.getAttribute('data-target');
      const panel = target ? document.getElementById(target) : null;
      if (!panel) return;
      panel.classList.toggle('hidden');
    });
  });
}

function resetChatRuntime() {
  chatRuntime.call_id = `chat-${Date.now()}`;
  chatRuntime.current_state = 'intro';
  chatRuntime.context = {};
}

async function loadLastCall() {
  const res = await fetch('/api/calls/recent?limit=1');
  const data = await res.json();
  const root = document.getElementById('last-call');
  root.innerHTML = '';
  const c = data.calls?.[0];
  if (!c) {
    root.textContent = 'Kein Anruf vorhanden.';
    return;
  }
  root.innerHTML = `
    <div class="kv"><div>Call ID</div><div>${esc(c.call_id)}</div></div>
    <div class="kv"><div>Status</div><div>${statusBadge(c.status)}</div></div>
    <div class="kv"><div>Letzter State</div><div>${esc(c.final_state || '-')}</div></div>
    <div class="kv"><div>End-Grund</div><div>${esc(c.end_call_reason || '-')}</div></div>
    <div class="kv"><div>Telefon</div><div>${esc(c.phone_to || '-')}</div></div>
    <div class="kv"><div>Zeit</div><div>${esc(new Date(c.created_at).toLocaleString('de-DE'))}</div></div>
  `;
}

async function loadLatestTurn() {
  const res = await fetch('/api/turns/latest');
  const data = await res.json();
  const root = document.getElementById('latest-turn');
  root.innerHTML = '';
  if (!data.turn) {
    root.textContent = 'Keine Turn-Daten vorhanden.';
    return;
  }
  const p = data.turn.payload || {};
  root.innerHTML = `
    <div class="kv"><div>Call ID</div><div>${esc(data.turn.call_id || '-')}</div></div>
    <div class="kv"><div>Intent</div><div>${esc(p.intent || '-')}</div></div>
    <div class="kv"><div>State (in -> out)</div><div>${esc(p.current_state || '-')} -> ${esc(p.next_state || '-')}</div></div>
    <div class="kv"><div>Response Source</div><div>${esc(p.response_source || 'rules')}</div></div>
    <div class="kv"><div>used_llm</div><div>${esc(String(p.used_llm ?? false))}</div></div>
    <div class="kv"><div>end_call</div><div>${esc(String(p.end_call ?? false))}</div></div>
    <div class="kv"><div>Kundentext</div><div>${esc(p.customer_text || '-')}</div></div>
  `;
}

async function loadChatView() {
  const callInput = document.getElementById('chat-call-id');
  const callId = (callInput?.value || '').trim();
  const url = callId ? `/api/chat?project=rheinpfalz&call_id=${encodeURIComponent(callId)}` : '/api/chat?project=rheinpfalz';
  const res = await fetch(url);
  const data = await res.json();
  const meta = document.getElementById('chat-meta');
  const view = document.getElementById('chat-view');
  if (!meta || !view) return;
  meta.textContent = data.call_id ? `call_id: ${data.call_id}` : 'Kein Gespr�ch gefunden.';
  if (data.call_id) chatRuntime.call_id = data.call_id;
  view.innerHTML = '';
  if (!Array.isArray(data.messages) || !data.messages.length) {
    view.innerHTML = '<p class="hint">Keine Nachrichten vorhanden.</p>';
    return;
  }
  [...data.messages].reverse().forEach((m) => {
    const row = document.createElement('div');
    row.className = `msg ${m.role === 'user' ? 'user' : 'bot'}`;
    const when = m.created_at ? new Date(m.created_at).toLocaleTimeString('de-DE') : '';
    row.innerHTML = renderMessageHtml(m.role, m.text, `${m.role} ${when ? `� ${when}` : ''}`, m.info || null);
    bindInfoButtons(row);
    view.appendChild(row);
  });
  scrollChatToBottom();
}

function appendChatMessage(role, text, info = null) {
  const view = document.getElementById('chat-view');
  if (!view) return;
  const row = document.createElement('div');
  row.className = `msg ${role === 'user' ? 'user' : 'bot'}`;
  row.innerHTML = renderMessageHtml(role, text, role, info);
  bindInfoButtons(row);
  view.prepend(row);
  scrollChatToBottom();
}

async function loadFacts() {
  const res = await fetch('/api/kb/overview');
  const data = await res.json();

  const factsRoot = document.getElementById('facts-list');
  factsRoot.innerHTML = '';
  (data.facts || []).forEach((f) => {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `<strong>${esc(f.key)}</strong><code>${esc(f.value)}</code><small>active: ${esc(f.active)}</small><br><button data-id="${f.id}">L�schen</button>`;
    el.querySelector('button').addEventListener('click', async () => {
      await fetch(`/api/kb/facts/${f.id}`, { method: 'DELETE' });
      await loadFacts();
    });
    factsRoot.appendChild(el);
  });

  const intentsRoot = document.getElementById('intents-list');
  intentsRoot.innerHTML = '';
  const ires = await fetch('/api/intents');
  const idata = await ires.json();
  (idata.intents || []).forEach((i) => {
    const el = document.createElement('div');
    el.className = 'item';
    el.innerHTML = `<strong>${esc(i.key)}</strong><code>${esc((i.phrases || []).join(', '))}</code><button data-key="${esc(i.key)}">L�schen</button>`;
    el.querySelector('button').addEventListener('click', async () => {
      await fetch(`/api/intents/${encodeURIComponent(i.key)}`, { method: 'DELETE' });
      await loadFacts();
    });
    intentsRoot.appendChild(el);
  });

  const statesRoot = document.getElementById('state-responses');
  statesRoot.innerHTML = '';
  const fres = await fetch('/api/flow-plan');
  const fdata = await fres.json();
  const orderedStates = sortStatesByFlow(fdata.states || []);
  learningStateOptions = orderedStates.map((s) => s.key).filter(Boolean);
  refreshLearningStateFilterOptions();
  renderLearningCreateStates();
  const simState = document.getElementById('sim-state');
  if (simState) {
    const selected = simState.value || 'intro';
    simState.innerHTML = '';
    orderedStates.forEach((s) => {
      const opt = document.createElement('option');
      opt.value = s.key;
      opt.textContent = `${s.key}${s.goal ? ` � ${s.goal}` : ''}`;
      if (s.key === selected) opt.selected = true;
      simState.appendChild(opt);
    });
    if (!simState.value) simState.value = 'intro';
  }
  orderedStates.forEach((s) => {
    const row = document.createElement('div');
    row.className = 'state-row';
    row.innerHTML = `<strong>${esc(s.key)}</strong><div class="hint">${esc(s.goal || '')}</div><textarea>${esc(s.proposed_response || '')}</textarea><button>Speichern</button>`;
    row.querySelector('button').addEventListener('click', async () => {
      const proposed_response = row.querySelector('textarea').value;
      await fetch(`/api/flow-plan/${encodeURIComponent(s.key)}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project: 'rheinpfalz', proposed_response })
      });
    });
    statesRoot.appendChild(row);
  });

  const treeRoot = document.getElementById('state-tree');
  if (treeRoot) {
    const map = new Map((fdata.states || []).map((s) => [s.key, s]));
    const visited = new Set();
    const lines = [];
    function walk(stateKey, indent = '') {
      if (!stateKey || visited.has(`${indent}|${stateKey}`)) return;
      const s = map.get(stateKey);
      if (!s) return;
      lines.push(`${indent}${stateKey}`);
      const next = Array.isArray(s.next_states) ? s.next_states : [];
      next.forEach((n, i) => {
        const branch = i === next.length - 1 ? '+- ' : '+- ';
        lines.push(`${indent}${branch}${n}`);
      });
    }
    FLOW_ORDER.forEach((k) => walk(k, ''));
    // Also add any custom states not in flow order.
    (fdata.states || [])
      .filter((s) => !FLOW_ORDER.includes(String(s.key || '')))
      .forEach((s) => walk(s.key, ''));

    if (!lines.length) {
      treeRoot.innerHTML = '<p class="hint">Keine State-Daten vorhanden.</p>';
    } else {
      treeRoot.innerHTML = `<div class="tree">${esc(lines.join('\n'))}</div>`;
    }
  }
}

async function loadLearningQueue() {
  const status = (document.getElementById('learning-status')?.value || 'pending').trim();
  const stateFilter = (document.getElementById('learning-state-filter')?.value || 'all').trim();
  const q = (document.getElementById('learning-search')?.value || '').trim();
  const root = document.getElementById('learning-list');
  if (!root) return;
  root.innerHTML = 'L�dt...';
  const res = await fetch(`/api/learning/questions?project=rheinpfalz&status=${encodeURIComponent(status)}&state=${encodeURIComponent(stateFilter)}&q=${encodeURIComponent(q)}`);
  const data = await res.json();
  if (!res.ok) {
    root.textContent = `Fehler: ${data.error || 'unknown'}`;
    return;
  }
  const items = data.items || [];
  if (!items.length) {
    root.textContent = 'Keine Eintr�ge.';
    return;
  }
  root.innerHTML = '';
  items.forEach((q) => {
    const el = document.createElement('div');
    el.className = 'learning-item';
    el.innerHTML = `
      <div class="kv"><div>ID</div><div>${esc(q.id)}</div></div>
      <div class="kv"><div>State</div><div>${esc(q.state_key || '-')}</div></div>
      <div class="kv"><div>Intent</div><div>${esc(q.intent_key || '-')}</div></div>
      <div class="kv"><div>Status</div><div>${esc(q.status || '-')}</div></div>
      <div class="kv"><div>Frage</div><div>${esc(q.question_text || '-')}</div></div>
      <div class="kv"><div>LLM Antwort</div><div>${esc(q.llm_answer || '-')}</div></div>
      <div class="learning-states">
        ${(learningStateOptions || []).map((stateKey) => {
          const checked = Array.isArray(q.state_keys) ? q.state_keys.includes(stateKey) : q.state_key === stateKey;
          return `<label><input type="checkbox" class="learning-state-cb" value="${esc(stateKey)}" ${checked ? 'checked' : ''} /> ${esc(stateKey)}</label>`;
        }).join('')}
      </div>
      <textarea class="learning-approve" placeholder="Eigene Antwort speichern...">${esc(q.approved_response || '')}</textarea>
      <button class="learning-save">Freigeben (Speichern)</button>
      <button class="learning-delete">L�schen</button>
    `;
    const btn = el.querySelector('.learning-save');
    const delBtn = el.querySelector('.learning-delete');
    const ta = el.querySelector('.learning-approve');
    btn?.addEventListener('click', async () => {
      const state_keys = [...el.querySelectorAll('.learning-state-cb:checked')]
        .map((c) => c.value)
        .filter(Boolean);
      const approved_response = ta.value.trim();
      if (!state_keys.length || !approved_response) return;

      const saveStates = await fetch(`/api/learning/questions/${q.id}/states`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state_keys })
      });
      if (!saveStates.ok) return;

      const approve = await fetch(`/api/learning/questions/${q.id}/approve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ approved_response })
      });
      if (approve.ok) {
        await loadLearningQueue();
      }
    });
    delBtn?.addEventListener('click', async () => {
      if (!window.confirm(`Frage #${q.id} wirklich l�schen?`)) return;
      const r = await fetch(`/api/learning/questions/${q.id}?cascade=true`, { method: 'DELETE' });
      if (r.ok) await loadLearningQueue();
    });
    root.appendChild(el);
  });
}

function renderTableSection(title, rows) {
  const section = document.createElement('div');
  section.className = 'card';
  const count = Array.isArray(rows) ? rows.length : 0;
  section.innerHTML = `<h3>${esc(title)} (${count})</h3>`;
  if (!count) {
    section.innerHTML += '<p class="hint">Keine Daten.</p>';
    return section;
  }
  const keys = Object.keys(rows[0] || {});
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  keys.forEach((k) => {
    const th = document.createElement('th');
    th.textContent = k;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);
  const tbody = document.createElement('tbody');
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    keys.forEach((k) => {
      const td = document.createElement('td');
      const val = r[k];
      if (val && typeof val === 'object') {
        td.innerHTML = `<code>${esc(JSON.stringify(val, null, 2))}</code>`;
      } else {
        td.textContent = String(val ?? '');
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  section.appendChild(wrap);
  return section;
}

function renderResponseVariantsSection(title, rows, projectKey = 'rheinpfalz') {
  const section = document.createElement('div');
  section.className = 'card';
  const count = Array.isArray(rows) ? rows.length : 0;
  section.innerHTML = `<h3>${esc(title)} (${count})</h3>`;
  if (!count) {
    section.innerHTML += '<p class="hint">Keine Daten.</p>';
    return section;
  }
  const keys = Object.keys(rows[0] || {});
  const wrap = document.createElement('div');
  wrap.className = 'table-wrap';
  const table = document.createElement('table');
  const thead = document.createElement('thead');
  const headRow = document.createElement('tr');
  const actionTh = document.createElement('th');
  actionTh.textContent = 'aktion';
  headRow.appendChild(actionTh);
  keys.forEach((k) => {
    const th = document.createElement('th');
    th.textContent = k;
    headRow.appendChild(th);
  });
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = document.createElement('tbody');
  rows.forEach((r) => {
    const tr = document.createElement('tr');
    const actionTd = document.createElement('td');
    const btn = document.createElement('button');
    btn.textContent = 'L�schen';
    btn.addEventListener('click', async () => {
      const id = r.id;
      if (!id) return;
      if (!window.confirm(`Variant #${id} wirklich l�schen?`)) return;
      const res = await fetch(`/api/response-variants/${encodeURIComponent(id)}?project=${encodeURIComponent(projectKey)}`, {
        method: 'DELETE'
      });
      if (res.ok) await loadDataView();
    });
    actionTd.appendChild(btn);
    tr.appendChild(actionTd);
    keys.forEach((k) => {
      const td = document.createElement('td');
      const val = r[k];
      if (val && typeof val === 'object') {
        td.innerHTML = `<code>${esc(JSON.stringify(val, null, 2))}</code>`;
      } else {
        td.textContent = String(val ?? '');
      }
      tr.appendChild(td);
    });
    tbody.appendChild(tr);
  });
  table.appendChild(tbody);
  wrap.appendChild(table);
  section.appendChild(wrap);
  return section;
}

async function loadDataView() {
  const project = (document.getElementById('data-project')?.value || 'rheinpfalz').trim() || 'rheinpfalz';
  const res = await fetch(`/api/kb/full-view?project=${encodeURIComponent(project)}`);
  const data = await res.json();
  const summary = document.getElementById('data-summary');
  const sections = document.getElementById('data-sections');
  if (!summary || !sections) return;

  if (!res.ok) {
    summary.innerHTML = `<div>Fehler</div><div>${esc(data.error || 'unknown')}</div>`;
    sections.innerHTML = '';
    return;
  }

  summary.innerHTML = `
    <div>Projekt</div><div>${esc(data.project?.key || '-')} (${esc(data.project?.name || '-')})</div>
    <div>Entscheidungs-Input</div><div>${esc((data.decision_columns?.input || []).join(', '))}</div>
    <div>Entscheidungs-Kontext</div><div>${esc((data.decision_columns?.context || []).join(', '))}</div>
    <div>Entscheidungs-Output</div><div>${esc((data.decision_columns?.output || []).join(', '))}</div>
  `;

  sections.innerHTML = '';
  sections.appendChild(renderTableSection('State Responses', data.state_responses || []));
  sections.appendChild(renderResponseVariantsSection('Response Variants', data.response_variants || [], project));
  sections.appendChild(renderTableSection('Conversation States', data.conversation_states || []));
  sections.appendChild(renderTableSection('Objections', data.objections || []));
  sections.appendChild(renderTableSection('Compliance Rules', data.compliance_rules || []));
  sections.appendChild(renderTableSection('Facts', data.facts || []));
  sections.appendChild(renderTableSection('Routing Rules', data.routing_rules || []));
  sections.appendChild(renderTableSection('System Intents', (data.system_intents || []).map((i) => ({ key: i.key, phrases: i.phrases }))));
  sections.appendChild(renderTableSection('Custom Intents', data.custom_intents || []));
}

async function loadCodeTexts() {
  const res = await fetch('/api/code-texts');
  const data = await res.json();
  const summary = document.getElementById('code-text-summary');
  const sections = document.getElementById('code-text-sections');
  if (!summary || !sections) return;

  if (!res.ok) {
    summary.innerHTML = `<div>Fehler</div><div>${esc(data.error || 'unknown')}</div>`;
    sections.innerHTML = '';
    return;
  }

  summary.innerHTML = `
    <div>LATENCY_MODE</div><div>${esc(data.latency_mode || '-')}</div>
    <div>Hinweis</div><div>${esc(data.note || '-')}</div>
  `;

  sections.innerHTML = '';
  sections.appendChild(renderTableSection('Code Text Entries', data.items || []));
}

async function startCallFromForm() {
  const to_number = document.getElementById('to-number').value.trim();
  const out = document.getElementById('call-result');
  if (!to_number) {
    out.textContent = 'Fehler: Bitte eine Telefonnummer eingeben.';
    return;
  }
  out.textContent = 'Anruf wird gestartet...';
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 15000);
    const res = await fetch('/api/calls/outbound', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ to_number, project: 'rheinpfalz' }),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const data = await res.json();
    out.textContent = res.ok
      ? `OK: conversation_id=${data.result?.conversation_id || '-'} callSid=${data.result?.callSid || '-'}`
      : `Fehler: ${data.error || 'unknown'}${data.details ? ' | ' + JSON.stringify(data.details) : ''}`;
    await loadLastCall();
    await loadLatestTurn();
  } catch (err) {
    out.textContent = `Fehler beim Aufruf: ${err.message}`;
  }
}

document.getElementById('call-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  await startCallFromForm();
});

document.getElementById('refresh-last-call').addEventListener('click', loadLastCall);
document.getElementById('refresh-latest-turn').addEventListener('click', loadLatestTurn);

document.getElementById('simulate-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const state = document.getElementById('sim-state').value.trim();
  const customer_text = document.getElementById('sim-text').value.trim();
  const context = {
    identity_confirmed: Boolean(document.getElementById('ctx-identity')?.checked),
    address_confirmed: Boolean(document.getElementById('ctx-address')?.checked),
    email_confirmed: Boolean(document.getElementById('ctx-email')?.checked),
    human_recovery_attempted: Boolean(document.getElementById('ctx-human')?.checked)
  };
  const out = document.getElementById('sim-minimal');
  out.textContent = 'L�dt...';
  const payload = { project: 'rheinpfalz', state, customer_text, context };
  const res = await fetch('/api/simulate-decision', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  out.innerHTML = `
    <div class="kv"><div>Status</div><div>${esc(String(res.status))}</div></div>
    <div class="kv"><div>Intent</div><div>${esc(data.intent || '-')}</div></div>
    <div class="kv"><div>N�chster State</div><div>${esc(data.next_state || '-')}</div></div>
    <div class="kv"><div>Antwort</div><div>${esc(data.tool_response || '-')}</div></div>
    <div class="kv"><div>end_call</div><div>${esc(String(data.end_call))}</div></div>
    <div class="kv"><div>Request JSON</div><div><pre class="json-box">${esc(JSON.stringify(payload, null, 2))}</pre></div></div>
    <div class="kv"><div>Response JSON</div><div><pre class="json-box">${esc(JSON.stringify(data, null, 2))}</pre></div></div>
  `;
});

document.getElementById('chat-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const cid = (document.getElementById('chat-call-id')?.value || '').trim();
  if (cid) chatRuntime.call_id = cid;
  await loadChatView();
});

document.getElementById('chat-clear')?.addEventListener('click', () => {
  resetChatRuntime();
  const cidInput = document.getElementById('chat-call-id');
  const view = document.getElementById('chat-view');
  const meta = document.getElementById('chat-meta');
  const input = document.getElementById('chat-input');
  if (cidInput) cidInput.value = chatRuntime.call_id;
  if (view) view.innerHTML = '';
  if (meta) meta.textContent = `call_id: ${chatRuntime.call_id} � state: intro � end_call: false`;
  if (input) input.focus();
});

document.getElementById('chat-send-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('chat-input');
  const meta = document.getElementById('chat-meta');
  const text = (input?.value || '').trim();
  if (!text) return;

  const manualCallId = (document.getElementById('chat-call-id')?.value || '').trim();
  if (manualCallId) chatRuntime.call_id = manualCallId;
  const payload = {
    project: 'rheinpfalz',
    call_id: chatRuntime.call_id || `chat-${Date.now()}`,
    current_state: chatRuntime.current_state || 'intro',
    customer_text: text,
    context: chatRuntime.context || {}
  };

  appendChatMessage('user', text, {
    request_preview: {
      current_state: payload.current_state,
      customer_text: payload.customer_text,
      context: payload.context
    }
  });
  if (input) input.value = '';
  if (meta) meta.textContent = `call_id: ${payload.call_id} � state: ${payload.current_state}`;

  const res = await fetch('/api/chat/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload)
  });
  const data = await res.json();
  if (!res.ok) {
    appendChatMessage('bot', `Fehler: ${data.error || 'unknown'}`, data);
    return;
  }
  const r = data.response || {};
  const botText = r.tool_response || '[leer]';
  appendChatMessage('bot', botText, {
    request: data.request || payload,
    response: r
  });
  chatRuntime.call_id = data.call_id;
  chatRuntime.current_state = r.next_state || chatRuntime.current_state;
  chatRuntime.context = { ...(chatRuntime.context || {}), ...(r.context_patch || {}) };
  const cidInput = document.getElementById('chat-call-id');
  if (cidInput && !cidInput.value) cidInput.value = chatRuntime.call_id;
  if (meta) {
    meta.textContent = `call_id: ${chatRuntime.call_id} � state: ${chatRuntime.current_state} � end_call: ${String(Boolean(r.end_call))}`;
  }
});

document.getElementById('fact-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = document.getElementById('fact-key').value.trim();
  const value = document.getElementById('fact-value').value.trim();
  const out = document.getElementById('fact-result');
  out.textContent = 'Speichere...';
  const res = await fetch('/api/kb/facts', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ project: 'rheinpfalz', key, value, active: true })
  });
  const data = await res.json();
  out.textContent = res.ok ? `OK: ${data.item.key}` : `Fehler: ${data.error || 'unknown'}`;
  if (res.ok) document.getElementById('fact-form').reset();
  await loadFacts();
});

document.getElementById('intent-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const key = document.getElementById('intent-key').value.trim();
  const phrases = document.getElementById('intent-phrases').value.split(',').map((p) => p.trim()).filter(Boolean);
  await fetch('/api/intents', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ key, phrases })
  });
  document.getElementById('intent-form').reset();
  await loadFacts();
});

document.getElementById('learning-create-form')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const out = document.getElementById('learning-create-result');
  const question_text = (document.getElementById('learning-create-question')?.value || '').trim();
  const intent_key = (document.getElementById('learning-create-intent')?.value || '').trim();
  const approved_response = (document.getElementById('learning-create-answer')?.value || '').trim();
  const status = (document.getElementById('learning-create-status')?.value || 'pending').trim();
  const state_keys = [...document.querySelectorAll('.learning-create-state-cb:checked')].map((c) => c.value).filter(Boolean);

  if (!question_text || !state_keys.length) {
    if (out) out.textContent = 'Bitte Frage und mindestens einen State setzen.';
    return;
  }
  if (status === 'approved' && !approved_response) {
    if (out) out.textContent = 'Bei approved ist ein Antworttext erforderlich.';
    return;
  }

  if (out) out.textContent = 'Speichere...';
  const res = await fetch('/api/learning/questions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      project: 'rheinpfalz',
      question_text,
      intent_key: intent_key || null,
      approved_response: approved_response || null,
      status,
      state_keys
    })
  });
  const data = await res.json();
  if (!res.ok) {
    if (out) out.textContent = `Fehler: ${data.error || 'unknown'}`;
    return;
  }
  if (out) out.textContent = `OK: Frage #${data.id} hinzugef�gt`;
  document.getElementById('learning-create-form')?.reset();
  renderLearningCreateStates();
  await loadLearningQueue();
});

async function bootUi() {
  try {
    const res = await fetch('/api/ui-config');
    if (res.ok) {
      const cfg = await res.json();
      UI_CHAT_ONLY = Boolean(cfg.chat_only);
      applyUiMode();
    }
  } catch (_e) {
    // fallback to full UI when config is not available
  }

  loadLastCall();
  loadLatestTurn();
  loadFacts();
  loadDataView();
  loadCodeTexts();
  loadChatView();
  loadLearningQueue();
}

bootUi();

document.getElementById('refresh-data-view')?.addEventListener('click', loadDataView);
document.getElementById('refresh-code-texts')?.addEventListener('click', loadCodeTexts);
document.getElementById('refresh-learning')?.addEventListener('click', loadLearningQueue);
document.getElementById('learning-status')?.addEventListener('change', loadLearningQueue);
document.getElementById('learning-state-filter')?.addEventListener('change', loadLearningQueue);
document.getElementById('learning-search')?.addEventListener('input', async () => {
  await loadLearningQueue();
});

const uiStatus = document.getElementById('ui-status');
if (uiStatus) uiStatus.textContent = 'UI bereit.';
const callSubmit = document.getElementById('call-submit');
if (callSubmit) {
  callSubmit.addEventListener('click', async (e) => {
    e.preventDefault();
    const out = document.getElementById('call-result');
    if (out && !out.textContent) out.textContent = 'Button geklickt, sende Anfrage...';
    await startCallFromForm();
  });
}


