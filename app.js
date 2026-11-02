/* Hisaab: shared expenses. Plain JavaScript with no libraries, to stay light. */

const root = document.getElementById('app');
const STORE = 'hisaab';

const saved = load();
const S = {
  groups: saved.groups || {},   // groupId -> { token, me, state }
  outbox: saved.outbox || [],   // changes waiting for signal
  current: saved.current || null,
  tab: 'list',
  view: 'home',
  form: null,
  join: null,
  syncing: false,
  sending: new Set(),           // ids of changes on their way to the Sheet
  offline: false,
  gen: 0,                       // goes up each time a sync finishes
};

function load() {
  try { return JSON.parse(localStorage.getItem(STORE)) || {}; } catch { return {}; }
}
function persist() {
  try {
    localStorage.setItem(STORE, JSON.stringify({ groups: S.groups, outbox: S.outbox, current: S.current }));
  } catch {
    toast('Could not save on this phone. Free some space, or changes may be lost.');
  }
}

/* ---------- Helpers ---------- */

const esc = (v) => String(v ?? '').replace(/[&<>"']/g, (c) => (
  { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
));
const group = () => S.groups[S.current];
const money = (n) => {
  const sign = n < 0 ? '-' : '';
  const cur = group() ? group().state.group.currency : 'Rs';
  return `${sign}${cur} ${Math.abs(n).toLocaleString('en-PK', { maximumFractionDigits: 2 })}`;
};
const today = () => {
  const d = new Date();
  return new Date(d - d.getTimezoneOffset() * 60000).toISOString().slice(0, 10);
};
const prettyDate = (s) => new Date(`${s}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
const newId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;

let toastTimer;
function toast(message) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; }, 3500);
}

/** Thrown when the phone could not reach the server, as opposed to a server refusal. */
class Offline extends Error {}
class ApiError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

const TIMEOUT = 45000;

async function api(action, data) {
  const stop = new AbortController();
  const timer = setTimeout(() => stop.abort(), TIMEOUT);
  try {
    let body;
    try {
      const res = await fetch(window.API_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify({ action, ...data }),
        signal: stop.signal,
      });
      body = await res.json();
    } catch {
      throw new Offline('No signal. This step needs internet, so try again when you are online.');
    }
    S.offline = false;
    if (!body.ok) throw new ApiError(body.error, body.code);
    return body.data;
  } finally {
    clearTimeout(timer);
  }
}

/* ---------- Same sums as calculate_ and settle_ in Code.gs. Keep the two in step. ---------- */

function calculate(memberNames, expenses) {
  const people = {};
  const person = (name) => (people[name] = people[name] || { name, paid: 0, share: 0, net: 0 });
  memberNames.forEach(person);

  let total = 0;
  const categories = {};
  expenses.forEach((e) => {
    const cents = Math.round(e.amount * 100);
    const base = Math.floor(cents / e.splitWith.length);
    const extra = cents - base * e.splitWith.length;
    const isExpense = e.kind === 'expense';

    person(e.paidBy).net += cents;
    if (isExpense) person(e.paidBy).paid += cents;
    e.splitWith.forEach((name, i) => {
      const part = base + (i < extra ? 1 : 0);
      person(name).net -= part;
      if (isExpense) person(name).share += part;
    });
    if (isExpense) {
      total += cents;
      const key = `${e.main}|${e.sub}`;
      categories[key] = (categories[key] || 0) + cents;
    }
  });

  const list = Object.values(people);
  return {
    total: total / 100,
    people: list.map((p) => ({ name: p.name, paid: p.paid / 100, share: p.share / 100, net: p.net / 100 })),
    settle: settle(list),
    categories: Object.keys(categories).map((k) => {
      const [main, sub] = k.split('|');
      return { main, sub, amount: categories[k] / 100 };
    }).sort((a, b) => a.main.localeCompare(b.main) || b.amount - a.amount),
  };
}

function settle(people) {
  const side = (list) => list.sort((a, b) => b.left - a.left);
  const owed = side(people.filter((p) => p.net > 0).map((p) => ({ name: p.name, left: p.net })));
  const owing = side(people.filter((p) => p.net < 0).map((p) => ({ name: p.name, left: -p.net })));
  const moves = [];
  let i = 0;
  let j = 0;
  while (i < owing.length && j < owed.length) {
    const amount = Math.min(owing[i].left, owed[j].left);
    moves.push({ from: owing[i].name, to: owed[j].name, amount: amount / 100 });
    owing[i].left -= amount;
    owed[j].left -= amount;
    if (!owing[i].left) i++;
    if (!owed[j].left) j++;
  }
  return moves;
}

/* ---------- What the phone shows: Sheet data plus changes not sent yet ---------- */

const itemsFor = (id) => S.outbox.filter((o) => o.groupId === id);
const sendable = (id) => itemsFor(id).filter((o) => !o.problem);

function view() {
  const g = group();
  const items = itemsFor(S.current);
  const members = g.state.members.map((m) => ({ ...m }));
  items.filter((o) => o.type === 'member').forEach((o) => {
    if (members.some((m) => m.name.toLowerCase() === o.name.toLowerCase())) return;
    members.push({ name: o.name, joined: false, pending: true, cid: o.cid, problem: o.problem });
  });

  let list = g.state.expenses.map((e) => ({ ...e }));
  items.forEach((o) => {
    if (o.type === 'delete') {
      if (!o.problem) list = list.filter((e) => e.id !== o.id);
      else list.filter((e) => e.id === o.id).forEach((e) => Object.assign(e, { problem: o.problem, cid: o.cid }));
    }
    if (o.type === 'save') {
      const old = list.find((e) => e.id === o.id);
      list = list.filter((e) => e.id !== o.id);
      list.push({
        addedBy: g.me, ...old, ...o.expense, pending: true, problem: o.problem, cid: o.cid,
      });
    }
  });
  list.sort((a, b) => (b.date + (b.createdAt || '9')).localeCompare(a.date + (a.createdAt || '9')));

  const sameBill = {};
  const billKey = (e) => [e.date, e.amount, e.paidBy,
    e.kind === 'payment' ? `paid|${e.splitWith[0]}` : `${e.main}|${e.sub}`].join('|');
  list.forEach((e) => { (sameBill[billKey(e)] = sameBill[billKey(e)] || new Set()).add(e.addedBy); });
  list.forEach((e) => { e.duplicate = sameBill[billKey(e)].size > 1; });

  return { members, list, summary: calculate(members.map((m) => m.name), list) };
}

/* ---------- Sync ---------- */

const RETRY_FIRST = 30000;
const RETRY_MAX = 300000;
const BATCH = 20;
let retryTimer;
let retryWait = RETRY_FIRST;

function added() {
  persist();
  render();
  sync();
}

function queueSave(expense, force) {
  const g = group();
  const mine = itemsFor(S.current).filter((o) => o.type === 'save' && o.id === expense.id);
  const idle = mine.find((o) => !S.sending.has(o.cid));
  if (idle) {
    idle.expense = expense;
    if (force) idle.force = true;
    delete idle.problem;
  } else {
    const seen = g.state.expenses.find((e) => e.id === expense.id);
    S.outbox.push({
      cid: newId(), groupId: S.current, type: 'save', id: expense.id, expense,
      base: mine.length ? mine[0].base : (seen ? seen.updatedAt : ''),
    });
  }
  added();
}

function queueDelete(id) {
  const g = group();
  const mine = itemsFor(S.current).filter((o) => o.type === 'save' && o.id === id);
  const idle = mine.find((o) => !S.sending.has(o.cid));
  const seen = g.state.expenses.find((e) => e.id === id);
  if (idle) S.outbox = S.outbox.filter((o) => o !== idle);
  if (!seen && !mine.some((o) => S.sending.has(o.cid))) {
    added(); // it never reached the Sheet, so there is nothing to tell it
    return;
  }
  S.outbox.push({
    cid: newId(), groupId: S.current, type: 'delete', id,
    base: seen ? seen.updatedAt : mine[0].base,
  });
  added();
}

function dropItem(cid) {
  S.outbox = S.outbox.filter((o) => o.cid !== cid);
  persist();
}

/** Redraws for background news, without disturbing someone typing. */
function update() {
  if (S.view !== 'group') return;
  const el = document.activeElement;
  if (el && el.tagName === 'INPUT') return;
  render();
}

function wire(o) {
  const { cid, type, id, expense, name, base, force } = o;
  return { cid, type, id, expense, name, base, force };
}

function applyResults(results) {
  results.forEach((r) => {
    if (r.status === 'ok') S.outbox = S.outbox.filter((o) => o.cid !== r.cid);
    const item = S.outbox.find((o) => o.cid === r.cid);
    if (!item) return;
    if (r.status === 'conflict') item.problem = { kind: 'conflict', by: r.by, deleted: r.deleted };
    if (r.status === 'rejected') item.problem = { kind: 'rejected', message: r.message };
  });
}

async function syncGroup(id) {
  const g = S.groups[id];
  for (;;) {
    const batch = sendable(id).slice(0, BATCH);
    if (!batch.length) return;
    S.sending = new Set(batch.map((o) => o.cid));
    update();
    const reply = await api('sync', { token: g.token, changes: batch.map(wire) });
    applyResults(reply.results);
    g.state = reply.state;
    g.lastSync = Date.now();
    S.gen++;
    S.sending = new Set();
    persist();
    update();
  }
}

async function sync() {
  if (S.syncing) return;
  S.syncing = true;
  let failed = false;
  try {
    const ids = [...new Set(S.outbox.map((o) => o.groupId))];
    for (const id of ids) {
      const g = S.groups[id];
      if (!g || g.needsJoin) continue;
      try {
        await syncGroup(id);
      } catch (err) {
        if (err instanceof ApiError && err.code === 'session') {
          g.needsJoin = true;
          persist();
          continue;
        }
        failed = true;
        if (err instanceof Offline) S.offline = true;
        break;
      }
    }
  } finally {
    S.sending = new Set();
    S.syncing = false;
    clearTimeout(retryTimer);
    if (failed) {
      retryTimer = setTimeout(sync, retryWait);
      retryWait = Math.min(retryWait * 2, RETRY_MAX);
    } else {
      retryWait = RETRY_FIRST;
    }
    update();
  }
}

async function refresh() {
  const id = S.current;
  const g = group();
  if (!g || g.needsJoin) return;
  await sync();
  if (S.groups[id] !== g || sendable(id).length || g.needsJoin) return;
  const gen = S.gen;
  try {
    const state = await api('state', { token: g.token });
    if (gen !== S.gen || S.syncing) return; // a newer sync already has fresher data
    g.state = state;
    g.lastSync = Date.now();
    persist();
  } catch (err) {
    if (err instanceof Offline) S.offline = true;
    if (err instanceof ApiError && err.code === 'session') { g.needsJoin = true; persist(); }
  }
  update();
}

/* ---------- Screens ---------- */

function render() {
  if (!window.API_URL) { root.innerHTML = setupScreen(); return; }
  const screens = { home: homeScreen, create: createScreen, join: joinScreen, group: groupScreen, form: formScreen };
  root.innerHTML = screens[S.view]();
}

function setupScreen() {
  return `<div class="welcome"><h1>Hisaab</h1>
    <p class="notice">Paste your Google Apps Script URL into <b>config.js</b> to start.</p></div>`;
}

function homeScreen() {
  const ids = Object.keys(S.groups);
  return `<div class="welcome"><h1>Hisaab</h1><p class="muted">Shared expenses, kept simple.</p></div>
    <div class="page">
      ${ids.length ? `<div class="card">${ids.map((id) => `
        <button class="row" data-act="open" data-id="${esc(id)}">
          <div><b>${esc(S.groups[id].state.group.name)}</b>
          <div class="muted">You are ${esc(S.groups[id].me)}</div></div><span>›</span>
        </button>`).join('')}</div>` : ''}
      <button class="btn" data-act="go-create">Create a group</button>
      <p class="muted" style="margin-top:14px;text-align:center">To join a group, open the invite link you were sent.</p>
    </div>`;
}

function createScreen() {
  return `<div class="top"><div class="top-row"><h1>New group</h1>
      <button data-act="go-home">Cancel</button></div></div>
    <form class="page" data-form="create">
      <label for="c-name">Group name</label>
      <input class="input" id="c-name" name="name" required maxlength="60" placeholder="Hunza trip">
      <label for="c-type">Type</label>
      <select class="input" id="c-type" name="type">
        <option value="trip">Trip</option><option value="household">Household</option>
      </select>
      <label for="c-me">Your name</label>
      <input class="input" id="c-me" name="me" required maxlength="40">
      <label for="c-members">Other people, one name per line</label>
      <textarea class="input" id="c-members" name="members"></textarea>
      <label for="c-pass">Group password, shared with your people</label>
      <input class="input" id="c-pass" name="password" type="password" required minlength="4" autocomplete="new-password">
      <label for="c-owner">Owner password</label>
      <input class="input" id="c-owner" name="ownerPassword" type="password" required autocomplete="off">
      <button class="btn">Create group</button>
    </form>`;
}

function joinScreen() {
  const j = S.join;
  if (!j.members) {
    return `<div class="welcome"><h1>Join group</h1><p class="muted">Enter the password you were given. Joining needs signal.</p></div>
      <form class="page" data-form="verify">
        <label for="j-pass">Password</label>
        <input class="input" id="j-pass" name="password" type="password" required autocomplete="off">
        <button class="btn">Continue</button>
        ${S.groups[j.id] ? '<button type="button" class="btn plain" data-act="go-home">Not now</button>' : ''}
      </form>`;
  }
  return `<div class="welcome"><h1>${esc(j.name)}</h1><p class="muted">Who are you?</p></div>
    <form class="page" data-form="join">
      ${j.members.length ? `<div class="chips">${j.members.map((n) => `
        <button type="button" class="chip" data-act="join-as" data-name="${esc(n)}">${esc(n)}</button>`).join('')}</div>
      <label for="j-name">Not listed? Write your name</label>` : '<label for="j-name">Write your name</label>'}
      <input class="input" id="j-name" name="name" maxlength="40" required>
      <button class="btn">Join</button>
    </form>`;
}

function groupScreen() {
  const st = group().state;
  const body = { list: listTab, balances: balancesTab, people: peopleTab }[S.tab]();
  const tab = (id, label) => `<button class="${S.tab === id ? 'on' : ''}" data-act="tab" data-id="${id}">${label}</button>`;
  return `<div class="top"><div class="top-row">
      <div><h1>${esc(st.group.name)}</h1><p>${esc(group().me)}</p></div>
      <button data-act="go-home">Groups</button></div></div>
    <nav class="tabs">${tab('list', 'Expenses')}${tab('balances', 'Who owes')}${tab('people', 'People')}</nav>
    ${statusLine()}
    ${body}
    <button class="fab" data-act="add">+ Add expense</button>`;
}

function ago(time) {
  const mins = Math.floor((Date.now() - time) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} min ago`;
  if (mins < 1440) return `${Math.floor(mins / 60)} hr ago`;
  return `${Math.floor(mins / 1440)} days ago`;
}

function statusLine() {
  const g = group();
  const items = itemsFor(S.current);
  const waiting = items.filter((o) => !o.problem).length;
  const stuck = items.length - waiting;
  const plural = waiting === 1 ? '' : 's';
  if (g.needsJoin) {
    return `<button class="status warn" data-act="rejoin">Join again to send ${waiting} change${plural}</button>`;
  }
  if (stuck) return `<p class="status warn">${stuck} need${stuck === 1 ? 's' : ''} your attention</p>`;
  if (S.syncing && waiting) return '<p class="status">Sending…</p>';
  const off = S.offline || !navigator.onLine;
  if (waiting) return `<p class="status">${off ? 'Offline' : 'Not sent yet'} · ${waiting} waiting</p>`;
  if (off) return `<p class="status">Offline${g.lastSync ? ` · saved ${ago(g.lastSync)}` : ''}</p>`;
  return g.lastSync ? `<p class="status">Saved to Sheet · ${ago(g.lastSync)}</p>` : '';
}

const TRASH = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v5M14 11v5"/></svg>';

function listTab() {
  const { list: items, summary } = view();
  let html = `<div class="page">
    <div class="hero"><div class="muted">Total spent</div>
    <div class="total">${money(summary.total)}</div></div>`;
  if (!items.length) return `${html}<p class="empty">No expenses yet. Add the first one.</p></div>`;

  let day = '';
  items.forEach((e, i) => {
    if (e.date !== day) {
      html += `${day ? '</div>' : ''}<h2>${esc(prettyDate(e.date))}</h2><div class="card">`;
      day = e.date;
    }
    const title = e.kind === 'payment'
      ? `${esc(e.paidBy)} paid ${esc(e.splitWith[0])}`
      : `${esc(e.sub)}${e.note ? ` · ${esc(e.note)}` : ''}`;
    const line = e.kind === 'payment'
      ? 'Settle up'
      : `${esc(e.main)} · paid by ${esc(e.paidBy)}`;
    const state = e.problem
      ? ' · <span class="bad">needs your attention</span>'
      : (e.pending ? ' · waiting to send' : '');
    html += `<div class="entry"><button class="row" data-act="edit" data-id="${esc(e.id)}">
      <div><div>${title}</div><div class="muted">${line}${state}</div>
      ${e.duplicate ? '<span class="tag">Possible duplicate</span>' : ''}</div>
      <div class="num">${money(e.amount)}</div></button>
      ${e.problem ? '' : `<button class="del" data-act="delete-row" data-id="${esc(e.id)}" aria-label="Delete">${TRASH}</button>`}
      </div>`;
    if (i === items.length - 1) html += '</div>';
  });
  return `${html}</div>`;
}

function balancesTab() {
  const { summary: s } = view();
  const mains = {};
  s.categories.forEach((c) => { (mains[c.main] = mains[c.main] || []).push(c); });
  return `<div class="page">
    <h2>Settle up</h2>
    <div class="card">${s.settle.length ? s.settle.map((m, i) => `
      <div class="row"><div><b>${esc(m.from)}</b> pays <b>${esc(m.to)}</b>
        <div class="num" style="text-align:left">${money(m.amount)}</div></div>
        <button class="btn plain small" data-act="settle" data-i="${i}">Mark paid</button></div>`).join('')
      : '<div class="row"><div class="muted">Everyone is settled.</div></div>'}</div>
    <h2>Each person</h2>
    <div class="card">${s.people.map((p) => `
      <div class="row"><div>${esc(p.name)}
        <div class="muted">Paid ${money(p.paid)} · Share ${money(p.share)}</div></div>
        <div class="num ${p.net > 0 ? 'good' : p.net < 0 ? 'bad' : ''}">${p.net > 0 ? '+' : ''}${money(p.net)}</div></div>`).join('')}</div>
    <h2>By category</h2>
    ${Object.keys(mains).length ? Object.keys(mains).map((main) => {
      const sum = mains[main].reduce((t, c) => t + c.amount, 0);
      return `<div class="card" style="margin-bottom:10px">
        <div class="row"><b>${esc(main)}</b><div class="num">${money(sum)}</div></div>
        ${mains[main].map((c) => `<div class="row"><div class="muted">${esc(c.sub)}</div><div class="num">${money(c.amount)}</div></div>`).join('')}
      </div>`;
    }).join('') : '<p class="muted">Nothing yet.</p>'}
  </div>`;
}

function peopleTab() {
  const memberRow = (m) => {
    const note = m.problem ? `<span class="bad">${esc(m.problem.message)}</span>`
      : (m.pending ? 'Waiting to send' : (m.joined ? 'Joined' : 'Not joined yet'));
    const button = m.pending
      ? `<button class="btn danger small" data-act="drop-member" data-id="${esc(m.cid)}" aria-label="Remove ${esc(m.name)}">Remove</button>`
      : `<button class="btn danger small" data-act="remove" data-name="${esc(m.name)}" aria-label="Remove ${esc(m.name)}">Remove</button>`;
    return `<div class="row"><div>${esc(m.name)}<div class="muted">${note}</div></div>${button}</div>`;
  };
  return `<div class="page">
    <h2>People in this group</h2>
    <div class="card">${view().members.map(memberRow).join('')}</div>
    <form data-form="member" style="display:flex;gap:8px;margin-top:12px">
      <input class="input" name="name" placeholder="Add a name" maxlength="40" required aria-label="Add a name">
      <button class="btn small">Add</button>
    </form>
    <h2>Invite</h2>
    <div class="card pad">
      <p class="muted">Send the link, then tell them the password separately.</p>
      <button class="btn" data-act="invite">Share invite link</button>
    </div>
    <button class="btn plain" data-act="leave">Remove this group from my phone</button>
  </div>`;
}

function formScreen() {
  const f = S.form;
  const st = group().state;
  const cats = categoriesWithDrafts();
  const mains = [...new Set(cats.map((c) => c.main))];
  const subs = cats.filter((c) => c.main === f.main).map((c) => c.sub);
  const names = namesForForm();
  const chip = (act, value, on) => `<button type="button" class="chip ${on ? 'on' : ''}" data-act="${act}" data-v="${esc(value)}" aria-pressed="${on}">${esc(value)}</button>`;

  return `<div class="top"><div class="top-row"><h1>${f.id ? 'Edit expense' : 'Add expense'}</h1>
      <button data-act="close-form">Cancel</button></div></div>
    <form class="page" data-form="expense">
      ${f.problem ? `<p class="notice">${esc(problemText(f))}</p>` : ''}
      <label for="f-amount">Amount (${esc(st.group.currency)})</label>
      <input class="input amount" id="f-amount" inputmode="decimal" value="${esc(f.amount)}" placeholder="0" required>
      <label>Category</label>
      <div class="chips">${mains.map((m) => chip('main', m, m === f.main)).join('')}
        <button type="button" class="chip add" data-act="new-main">+ New</button></div>
      ${f.main ? `<label>Type</label>
      <div class="chips">${subs.map((s) => chip('sub', s, s === f.sub)).join('')}
        <button type="button" class="chip add" data-act="new-sub">+ New</button></div>` : ''}
      <label>Paid by</label>
      <div class="chips">${names.map((n) => chip('payer', n, n === f.paidBy)).join('')}</div>
      <label>Shared by</label>
      <div class="chips">${names.map((n) => chip('split', n, f.splitWith.includes(n))).join('')}</div>
      <label for="f-date">Date</label>
      <input class="input" id="f-date" type="date" value="${esc(f.date)}" required>
      <label for="f-note">Note (optional)</label>
      <input class="input" id="f-note" maxlength="300" value="${esc(f.note)}">
      ${formButtons(f)}
    </form>`;
}

function problemText(f) {
  const p = f.problem;
  if (p.kind === 'rejected') return `The Sheet refused this: ${p.message}. Fix it, or discard it.`;
  const who = p.by || 'Someone else';
  if (f.deleting) return `${who} changed this entry after you deleted it.`;
  return p.deleted ? `${who} deleted this entry after you changed it.` : `${who} changed this entry first.`;
}

function formButtons(f) {
  const drop = (label) => `<button type="button" class="btn plain" data-act="drop-item">${label}</button>`;
  if (f.problem && f.deleting) {
    return `<button type="button" class="btn" data-act="use-mine">Use mine</button>${drop('Keep theirs')}`;
  }
  if (f.problem && f.problem.kind === 'conflict') return `<button class="btn">Use mine</button>${drop('Keep theirs')}`;
  if (f.problem) return `<button class="btn">Fix and send</button>${drop('Discard')}`;
  return `<button class="btn">Save</button>
      ${f.id ? '<button type="button" class="btn danger" data-act="delete">Delete</button>' : ''}`;
}

function namesForForm() {
  const names = view().members.map((m) => m.name);
  [S.form.paidBy, ...S.form.splitWith].forEach((n) => { if (n && !names.includes(n)) names.push(n); });
  return names;
}

function categoriesWithDrafts() {
  const list = [...group().state.categories];
  itemsFor(S.current).filter((o) => o.type === 'save' && o.expense.kind === 'expense')
    .forEach((o) => list.push({ main: o.expense.main, sub: o.expense.sub }));
  list.push(...S.form.drafts);
  const seen = new Set();
  return list.filter((c) => {
    const key = `${c.main}|${c.sub}`.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/* ---------- Actions ---------- */

function openGroup(id) {
  clearTimeout(toastTimer);
  document.getElementById('toast').hidden = true; // an old error must not follow you into the group
  S.current = id;
  S.view = 'group';
  S.tab = 'list';
  persist();
  render();
  refresh();
}

/** Keeps typed form values when tapping a chip redraws the screen. */
function keepFormValues() {
  const amount = document.getElementById('f-amount');
  if (!amount) return;
  S.form.amount = amount.value;
  S.form.date = document.getElementById('f-date').value;
  S.form.note = document.getElementById('f-note').value;
}

function saveGroup(result) {
  S.groups[result.groupId] = { token: result.token, me: result.me, state: result.state };
  history.replaceState(null, '', location.pathname);
  S.join = null;
  openGroup(result.groupId);
}

async function run(button, work) {
  if (button) button.disabled = true;
  try {
    await work();
  } catch (err) {
    toast(err.message);
    if (button && button.isConnected) button.disabled = false;
  }
}

const actions = {
  'go-home': () => { S.view = 'home'; render(); },
  'go-create': () => { S.view = 'create'; render(); },
  open: (el) => openGroup(el.dataset.id),
  tab: (el) => { S.tab = el.dataset.id; render(); },
  add: () => {
    const g = group();
    S.form = {
      id: null, amount: '', main: '', sub: '', paidBy: g.me, date: today(), note: '', drafts: [],
      splitWith: view().members.map((m) => m.name),
    };
    S.view = 'form';
    render();
    document.getElementById('f-amount').focus();
  },
  edit: (el) => {
    const e = view().list.find((x) => x.id === el.dataset.id);
    if (!e) return;
    const item = S.outbox.find((o) => o.cid === e.cid);
    S.form = { ...e, splitWith: [...e.splitWith], drafts: [], deleting: !!item && item.type === 'delete' };
    S.view = 'form';
    render();
  },
  'close-form': () => { S.view = 'group'; render(); },
  main: (el) => { keepFormValues(); S.form.main = el.dataset.v; S.form.sub = ''; render(); },
  sub: (el) => { keepFormValues(); S.form.sub = el.dataset.v; render(); },
  payer: (el) => { keepFormValues(); S.form.paidBy = el.dataset.v; render(); },
  split: (el) => {
    keepFormValues();
    const list = S.form.splitWith;
    const name = el.dataset.v;
    S.form.splitWith = list.includes(name) ? list.filter((n) => n !== name) : [...list, name];
    render();
  },
  'new-main': () => {
    keepFormValues();
    const name = (prompt('New category name') || '').trim();
    if (!name) return;
    S.form.main = name;
    S.form.sub = '';
    render();
  },
  'new-sub': () => {
    keepFormValues();
    const name = (prompt(`New type in ${S.form.main}`) || '').trim();
    if (!name) return;
    S.form.drafts.push({ main: S.form.main, sub: name });
    S.form.sub = name;
    render();
  },
  delete: () => {
    if (!confirm('Delete this expense?')) return;
    S.view = 'group';
    queueDelete(S.form.id);
  },
  'delete-row': (el) => {
    if (!confirm('Delete this expense?')) return;
    queueDelete(el.dataset.id);
  },
  'use-mine': () => {
    const item = S.outbox.find((o) => o.cid === S.form.cid);
    if (item) { item.force = true; delete item.problem; }
    S.view = 'group';
    added();
  },
  'drop-item': () => {
    if (!confirm('Drop your change?')) return;
    dropItem(S.form.cid);
    S.view = 'group';
    render();
    refresh();
  },
  'drop-member': (el) => { dropItem(el.dataset.id); render(); },
  rejoin: () => { S.join = { id: S.current }; S.view = 'join'; render(); },
  settle: (el) => {
    const m = view().summary.settle[Number(el.dataset.i)];
    if (!confirm(`Mark that ${m.from} paid ${m.to} ${money(m.amount)}?`)) return;
    queueSave({
      id: newId(), kind: 'payment', date: today(), amount: m.amount, paidBy: m.from, splitWith: [m.to],
      main: 'Payment', sub: 'Settle up', note: '',
    });
  },
  remove: (el) => run(el, async () => {
    const name = el.dataset.name;
    if (view().list.some((e) => e.paidBy === name || e.splitWith.includes(name))) {
      throw new Error(`${name} has entries, so they cannot be removed`);
    }
    if (!confirm(`Remove ${name}?`)) { el.disabled = false; return; }
    try {
      group().state = await api('removeMember', { token: group().token, name });
    } catch (err) {
      if (err instanceof Offline) throw new Error('Removing a person needs signal, to check everyone\'s entries.');
      throw err;
    }
    S.gen++;
    persist();
    render();
  }),
  invite: async () => {
    const url = `${location.origin}${location.pathname}?g=${encodeURIComponent(S.current)}`;
    const text = `Join ${group().state.group.name} on Hisaab`;
    try {
      if (navigator.share) { await navigator.share({ title: 'Hisaab', text, url }); return; }
      await navigator.clipboard.writeText(url);
      toast('Link copied');
    } catch (err) {
      if (err.name !== 'AbortError') prompt('Copy this link', url);
    }
  },
  leave: () => {
    const unsent = itemsFor(S.current).length;
    const warning = unsent ? `${unsent} unsent change${unsent > 1 ? 's' : ''} will be lost. ` : '';
    if (!confirm(`${warning}Remove this group from this phone? Nothing is deleted from the Sheet.`)) return;
    S.outbox = S.outbox.filter((o) => o.groupId !== S.current);
    delete S.groups[S.current];
    S.current = null;
    S.view = 'home';
    persist();
    render();
  },
  'join-as': (el) => run(el, async () => {
    saveGroup(await api('join', { groupId: S.join.id, password: S.join.password, name: el.dataset.name }));
  }),
};

const forms = {
  create: (data, button) => run(button, async () => {
    saveGroup(await api('create', {
      ...data,
      members: data.members.split('\n').map((n) => n.trim()).filter(Boolean),
    }));
  }),
  verify: (data, button) => run(button, async () => {
    const info = await api('verify', { groupId: S.join.id, password: data.password });
    S.join = { ...S.join, ...info, password: data.password };
    render();
  }),
  join: (data, button) => run(button, async () => {
    saveGroup(await api('join', { groupId: S.join.id, password: S.join.password, name: data.name }));
  }),
  member: (data) => {
    const name = data.name.trim();
    if (!name) return;
    if (view().members.some((m) => m.name.toLowerCase() === name.toLowerCase())) { toast(`${name} is already here`); return; }
    S.outbox.push({ cid: newId(), groupId: S.current, type: 'member', name });
    added();
  },
  expense: () => {
    keepFormValues();
    const f = S.form;
    if (f.deleting) return;
    const amount = Number(f.amount.replace(/,/g, ''));
    if (!(amount > 0)) return toast('Enter an amount');
    if (f.kind !== 'payment' && (!f.main || !f.sub)) return toast('Choose a category and type');
    if (!f.splitWith.length) return toast('Choose who shares this');
    const expense = {
      id: f.id || newId(), kind: f.kind || 'expense', date: f.date, amount, paidBy: f.paidBy,
      splitWith: f.splitWith, main: f.main, sub: f.sub, note: f.note.trim(),
    };
    S.view = 'group';
    S.tab = 'list';
    queueSave(expense, !!f.problem && f.problem.kind === 'conflict');
  },
};

document.addEventListener('click', (e) => {
  const el = e.target.closest('[data-act]');
  if (el) actions[el.dataset.act](el);
});

document.addEventListener('submit', (e) => {
  e.preventDefault();
  const form = e.target;
  forms[form.dataset.form](Object.fromEntries(new FormData(form)), form.querySelector('.btn'));
});

window.addEventListener('online', () => { retryWait = RETRY_FIRST; sync(); });
window.addEventListener('offline', update);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && S.view === 'group') refresh();
});

/* ---------- Start ---------- */

/** Changes saved by the earlier version of the app keep working after an update. */
function upgrade(o) {
  if (o.cid) return o;
  const item = { cid: newId(), groupId: o.groupId };
  if (o.action === 'saveExpense') return { ...item, type: 'save', id: o.data.expense.id, expense: o.data.expense };
  if (o.action === 'deleteExpense') return { ...item, type: 'delete', id: o.data.id };
  return { ...item, type: 'member', name: o.data.name };
}
S.outbox = S.outbox.map(upgrade);

const invited = new URLSearchParams(location.search).get('g');
if (invited && S.groups[invited]) {
  S.current = invited;
  S.view = 'group';
} else if (invited) {
  S.join = { id: invited };
  S.view = 'join';
} else if (S.current && S.groups[S.current]) {
  S.view = 'group';
}
render();
if (S.view === 'group') refresh(); else sync();

if ('serviceWorker' in navigator && window.isSecureContext) {
  navigator.serviceWorker.register('sw.js');
  if (navigator.storage && navigator.storage.persist) navigator.storage.persist();
}
