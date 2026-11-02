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
  settlerDraft: null,           // { id, names } picked but not sent yet
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
const myRole = () => (group().state.members.find((m) => m.name === group().me) || {}).role || '';
const isAdmin = () => ['creator', 'admin'].includes(myRole());
const money = (n) => {
  const sign = n < 0 ? '-' : '';
  const cur = group() ? group().state.group.currency : 'Rs';
  const digits = Math.round(Math.abs(n) * 100) % 100 ? 2 : 0;
  return `${sign}${cur} ${Math.abs(n).toLocaleString('en-PK', { minimumFractionDigits: digits, maximumFractionDigits: 2 })}`;
};
const nameJoin = (names) => (names.length < 2
  ? names.join('')
  : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`);
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

function calculate(memberNames, expenses, settlers) {
  const people = Object.create(null);
  const person = (name) => (people[name] = people[name] || { name, paid: 0, share: 0, net: 0 });
  memberNames.forEach(person);
  const chosen = settlers && settlers.length ? settlers : null;
  if (chosen) chosen.forEach(person);

  let total = 0;
  const categories = Object.create(null);
  let counter = 0; // the spare cents rotate between entries, so the same settler is not always rounded up
  expenses.forEach((e) => {
    const cents = Math.round(e.amount * 100);
    const isExpense = e.kind === 'expense';
    const rotate = isExpense && chosen;
    const split = rotate ? chosen : e.splitWith;
    const n = split.length;
    const base = Math.floor(cents / n);
    const extra = cents - base * n;

    person(e.paidBy).net += cents;
    if (isExpense) person(e.paidBy).paid += cents;
    split.forEach((name, i) => {
      const gets = rotate ? ((i - counter) % n + n) % n < extra : i < extra;
      const part = base + (gets ? 1 : 0);
      person(name).net -= part;
      if (isExpense) person(name).share += part;
    });
    if (rotate) counter = (counter + extra) % n;
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

  const sameBill = Object.create(null);
  const billKey = (e) => [e.date, e.amount,
    e.kind === 'payment' ? `${e.paidBy}|paid|${e.splitWith[0]}` : `${e.main}|${e.sub}`].join('|');
  list.forEach((e) => { (sameBill[billKey(e)] = sameBill[billKey(e)] || new Set()).add(e.addedBy); });
  list.forEach((e) => { e.duplicate = sameBill[billKey(e)].size > 1; });

  return { members, list, summary: calculate(members.map((m) => m.name), list, g.state.group.settlers) };
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
  // A save that was sent may be on the Sheet even though no reply came back.
  const maybeThere = seen || mine.some((o) => o.attempted || S.sending.has(o.cid));
  if (idle) S.outbox = S.outbox.filter((o) => o !== idle);
  if (!maybeThere) {
    added(); // it never left this phone, so there is nothing to tell the Sheet
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
    // With no network nothing leaves the phone. Any other failure may have reached the Sheet.
    if (navigator.onLine !== false) batch.forEach((o) => { if (o.type === 'save') o.attempted = true; });
    persist();
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

const MIN_PASSWORD = 6;

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
      <input class="input" id="c-pass" name="password" type="password" required minlength="${MIN_PASSWORD}" autocomplete="new-password">
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
    <div class="page">
      ${j.members.length ? `<div class="chips">${j.members.map((n) => `
        <button type="button" class="chip" data-act="join-as" data-name="${esc(n)}">${esc(n)}</button>`).join('')}</div>` : ''}
      <p class="muted" style="margin-top:14px">Not listed? Ask an admin to add you, or to let you join from this phone.</p>
      ${j.reclaim ? `<form data-form="reclaim">
        <label for="j-owner">Owner password</label>
        <input class="input" id="j-owner" name="ownerPassword" type="password" required autocomplete="off">
        <button class="btn">Get back in</button>
        <button type="button" class="btn plain" data-act="reclaim-cancel">Cancel</button>
      </form>` : '<button type="button" class="btn plain" data-act="reclaim">I am the group creator</button>'}
      ${S.groups[j.id] ? '<button type="button" class="btn plain" data-act="go-home">Not now</button>' : ''}
    </div>`;
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
  if (stuck) return `<button class="status warn" data-act="to-problem">${stuck} need${stuck === 1 ? 's' : ''} your attention</button>`;
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
    const body = `<div><div>${title}</div><div class="muted">${line}${state}</div>
      ${e.duplicate ? '<span class="tag">Possible duplicate</span>' : ''}</div>
      <div class="num">${money(e.amount)}</div>`;
    const mine = e.addedBy === group().me;
    html += `<div class="entry"${e.problem ? ' data-problem' : ''}>${mine
      ? `<button class="row" data-act="edit" data-id="${esc(e.id)}">${body}</button>`
      : `<div class="row">${body}</div>`}
      ${mine && !e.problem ? `<button class="del" data-act="delete-row" data-id="${esc(e.id)}" aria-label="Delete ${title}, ${esc(money(e.amount))}">${TRASH}</button>` : ''}
      </div>`;
    if (i === items.length - 1) html += '</div>';
  });
  return `${html}</div>`;
}

function balancesTab() {
  const { summary: s } = view();
  const me = group().me;
  const mains = Object.create(null);
  s.categories.forEach((c) => { (mains[c.main] = mains[c.main] || []).push(c); });
  const chosen = settlersNow();
  const names = group().state.members.map((m) => m.name);
  const waiting = !!S.settlerDraft && S.settlerDraft.id === S.current;
  const gone = chosen.filter((n) => !names.includes(n));
  const chipFor = (n) => {
    const on = !chosen.length || chosen.includes(n);
    return `
    <button type="button" class="chip ${on ? 'on' : ''}" data-act="settler" data-v="${esc(n)}" aria-pressed="${on}">${esc(n)}${names.includes(n) ? '' : ' (removed)'}</button>`;
  };
  const pickerHelp = gone.length
    ? `${esc(nameJoin(gone))} left the group but still ${gone.length === 1 ? 'shares' : 'share'} all expenses. Tap a name to take them out, and the others cover that share.`
    : 'Tap a name to take them out. If everyone stays on, everyone shares.';
  const picker = isAdmin() ? `<div class="chips${waiting ? ' sending' : ''}" role="group" aria-labelledby="settlers-title" aria-busy="${waiting}">${[...names, ...gone].map(chipFor).join('')}</div>
    <p class="muted" style="margin-top:8px">${pickerHelp}</p>` : '';
  const who = esc(nameJoin(chosen));
  const rule = !chosen.length
    ? 'Everyone shares all expenses.'
    : (chosen.length === 1
      ? `Only ${who} settles up. ${who} covers all expenses, and everyone else gets back what they paid.`
      : `Only ${who} settle up. They share all expenses equally, and everyone else gets back what they paid.`);
  const canMark = (m) => m.from === me || m.to === me
    || (isAdmin() && !names.includes(m.from) && !names.includes(m.to));
  return `<div class="page">
    <h2 id="settlers-title">Who settles up</h2>
    ${picker}
    <p class="muted" style="margin-top:8px">${rule}</p>
    <h2>Settle up</h2>
    <div class="card">${s.settle.length ? s.settle.map((m, i) => `
      <div class="row"><div><b>${esc(m.from)}</b> pays <b>${esc(m.to)}</b>
        <div class="num" style="text-align:left">${money(m.amount)}</div></div>
        ${canMark(m) ? `<button class="btn plain small" data-act="settle" data-i="${i}">Mark paid</button>` : ''}</div>`).join('')
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
  const g = group();
  const creator = myRole() === 'creator';
  const admin = isAdmin();
  const memberButtons = (m) => {
    const label = esc(m.name);
    if (m.pending) return `<button class="btn danger small" data-act="drop-member" data-id="${esc(m.cid)}" aria-label="Remove ${label}">Remove</button>`;
    if (m.role === 'creator' || m.name === g.me) return '';
    const on = m.role === 'admin';
    const canChange = creator || (admin && !on); // admins may act on plain members only
    return [
      creator && (on || m.joined) ? `<button class="btn plain small" data-act="set-admin" data-name="${label}" data-on="${on ? '' : 'yes'}" aria-label="${on ? `Remove admin from ${label}` : `Make ${label} an admin`}">${on ? 'Remove admin' : 'Make admin'}</button>` : '',
      canChange && m.joined ? `<button class="btn plain small" data-act="reset-join" data-name="${label}" aria-label="New phone for ${label}">New phone</button>` : '',
      canChange ? `<button class="btn danger small" data-act="remove" data-name="${label}" aria-label="Remove ${label}">Remove</button>` : '',
    ].join('');
  };
  const memberRow = (m) => {
    const title = { creator: 'Creator', admin: 'Admin' }[m.role];
    const status = m.pending ? 'Waiting to send' : (m.joined ? 'Joined' : 'Not joined yet');
    const note = m.problem ? `<span class="bad">${esc(m.problem.message)}</span>` : (title ? `${title} · ${status}` : status);
    return `<div class="row"${m.problem ? ' data-problem' : ''}><div>${esc(m.name)}<div class="muted">${note}</div></div>
      <div class="row-actions">${memberButtons(m)}</div></div>`;
  };
  return `<div class="page">
    <h2>People in this group</h2>
    <div class="card">${view().members.map(memberRow).join('')}</div>
    ${admin ? `<form data-form="member" style="display:flex;gap:8px;margin-top:12px">
      <input class="input" name="name" placeholder="Add a name" maxlength="40" required aria-label="Add a name">
      <button class="btn small">Add</button>
    </form>` : '<p class="muted" style="margin-top:12px">Only admins can add or remove people.</p>'}
    <h2>Invite</h2>
    <div class="card pad">
      <p class="muted">Send the link, then tell them the password separately.</p>
      <button class="btn" data-act="invite">Share invite link</button>
    </div>
    ${creator ? `<h2>Group password</h2>
    <form class="card pad" data-form="password">
      <p class="muted">People already in the group stay in. New people need the new password.</p>
      <label for="p-new">New group password</label>
      <input class="input" id="p-new" name="password" type="password" required minlength="${MIN_PASSWORD}" autocomplete="new-password">
      <button class="btn">Change group password</button>
    </form>` : ''}
    <button class="btn plain" data-act="leave">Remove this group from my phone</button>
  </div>`;
}

function formScreen() {
  const f = S.form;
  const st = group().state;
  const cats = categoriesWithDrafts();
  const mains = [...new Set(cats.map((c) => c.main))];
  const subs = cats.filter((c) => c.main === f.main).map((c) => c.sub);
  const chip = (act, value, on) => `<button type="button" class="chip ${on ? 'on' : ''}" data-act="${act}" data-v="${esc(value)}" aria-pressed="${on}">${esc(value)}</button>`;

  const isPayment = f.kind === 'payment';
  const settlers = st.group.settlers || [];
  const sharedBy = settlers.length ? settlers : f.splitWith;
  const title = isPayment ? 'Edit payment' : (f.id ? 'Edit expense' : 'Add expense');

  return `<div class="top"><div class="top-row"><h1>${title}</h1>
      <button data-act="close-form">Cancel</button></div></div>
    <form class="page" data-form="expense">
      ${f.problem ? `<p class="notice">${esc(problemText(f))}</p>` : ''}
      <label for="f-amount">Amount (${esc(st.group.currency)})</label>
      <input class="input amount" id="f-amount" inputmode="decimal" value="${esc(f.amount)}" placeholder="0" required>
      ${isPayment ? '' : `<div class="label" id="f-main-label">Category</div>
      <div class="chips" role="group" aria-labelledby="f-main-label">${mains.map((m) => chip('main', m, m === f.main)).join('')}
        <button type="button" class="chip add" data-act="new-main">+ New</button></div>
      ${f.main ? `<div class="label" id="f-sub-label">Type</div>
      <div class="chips" role="group" aria-labelledby="f-sub-label">${subs.map((s) => chip('sub', s, s === f.sub)).join('')}
        <button type="button" class="chip add" data-act="new-sub">+ New</button></div>` : ''}
      <p class="muted" style="margin-top:12px">Paid by ${esc(f.paidBy)} · shared by ${esc(nameJoin(sharedBy))}</p>`}
      <label for="f-date">Date</label>
      <input class="input" id="f-date" type="date" value="${esc(f.date)}" required>
      <label for="f-note">Note (optional)</label>
      <input class="input" id="f-note" maxlength="300" value="${esc(f.note)}">
      ${formButtons(f)}
    </form>`;
}

function problemText(f) {
  const p = f.problem;
  if (p.kind === 'rejected') return `This could not be saved: ${p.message}. Fix it, or discard it.`;
  const who = p.by || 'Someone else';
  if (p.deleted) return `${who} deleted this entry after you changed it.`;
  const theirs = group().state.expenses.find((e) => e.id === f.id);
  const amount = theirs ? ` ${who}'s amount: ${money(theirs.amount)}.` : '';
  return `${who} changed this entry ${f.deleting ? 'after you deleted it' : 'first'}.${amount}`;
}

function formButtons(f) {
  const drop = (label) => `<button type="button" class="btn plain" data-act="drop-item">${label}</button>`;
  const by = f.problem && f.problem.by;
  const theirs = by ? `${esc(by)}'s` : 'theirs';
  if (f.problem && f.deleting) {
    return `<button type="button" class="btn" data-act="use-mine">Delete it anyway</button>${drop(by ? `Keep ${theirs} version` : 'Keep their version')}`;
  }
  if (f.problem && f.problem.deleted) return `<button class="btn">Add mine back</button>${drop('Leave it deleted')}`;
  if (f.problem && f.problem.kind === 'conflict') return `<button class="btn">Save mine over ${theirs}</button>${drop(`Keep ${theirs}`)}`;
  if (f.problem) return `<button class="btn">Fix and send</button>${drop('Discard')}`;
  return `<button class="btn">Save</button>
      ${f.id ? '<button type="button" class="btn danger" data-act="delete">Delete</button>' : ''}`;
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

/** Changes to people need signal, so the Sheet can check who is asking. */
async function memberChange(action, data) {
  const g = group();
  try {
    const reply = await api(action, { token: g.token, ...data });
    if (reply && reply.group) g.state = reply;
  } catch (err) {
    if (err instanceof Offline) throw new Error('This needs signal. Try again when you are online.');
    throw err;
  }
  S.gen++;
  persist();
  render();
}

/** What the picker shows: the choice still waiting to send, or else the stored list. */
function settlersNow() {
  const d = S.settlerDraft;
  return d && d.id === S.current ? d.names : (group().state.group.settlers || []);
}

const SETTLER_PAUSE = 900;
let settlerTimer = null;
let settlerSending = false;

/** Sends the picked list once, after the taps stop. Taps made during a send go out after it. */
async function sendSettlers() {
  settlerTimer = null;
  const draft = S.settlerDraft;
  if (!draft || settlerSending) return;
  const g = S.groups[draft.id];
  if (!g) { S.settlerDraft = null; return; }
  settlerSending = true;
  let failure = '';
  try {
    g.state = await api('setSettlers', { token: g.token, names: draft.names });
    S.gen++;
    persist();
  } catch (err) {
    failure = err instanceof Offline ? 'This needs signal. Try again when you are online.' : err.message;
  }
  settlerSending = false;
  if (S.settlerDraft === draft) S.settlerDraft = null;
  if (failure) {
    S.settlerDraft = null;
    clearTimeout(settlerTimer);
    settlerTimer = null;
    toast(failure);
  }
  update();
  if (S.settlerDraft && settlerTimer === null) sendSettlers();
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
  'to-problem': () => {
    const first = itemsFor(S.current).find((o) => o.problem);
    if (!first) return;
    S.tab = first.type === 'member' ? 'people' : 'list';
    render();
    const row = document.querySelector('[data-problem]');
    if (row) row.scrollIntoView({ block: 'center' });
  },
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
  remove: (el) => {
    const { name } = el.dataset;
    const after = settlersNow().includes(name)
      ? 'They keep sharing expenses until you take them out of Who settles up.'
      : 'New expenses will not include them.';
    if (!confirm(`Remove ${name}? Their past entries and balance stay. ${after}`)) return;
    run(el, () => memberChange('removeMember', { name }));
  },
  'reset-join': (el) => {
    const { name } = el.dataset;
    if (!confirm(`Let ${name} join from a new phone? Their current phone will be signed out.`)) return;
    run(el, () => memberChange('resetJoin', { name }));
  },
  settler: (el) => {
    const names = group().state.members.map((m) => m.name);
    const chosen = settlersNow();
    const now = chosen.length ? chosen : names;
    const name = el.dataset.v;
    const next = now.includes(name) ? now.filter((n) => n !== name) : [...now, name];
    if (!next.some((n) => names.includes(n))) return toast('Choose at least one person');
    // Removed people stay in the list sent until their own chip is tapped.
    const everyone = next.length === names.length && names.every((n) => next.includes(n));
    S.settlerDraft = { id: S.current, names: everyone ? [] : next };
    clearTimeout(settlerTimer);
    settlerTimer = setTimeout(sendSettlers, SETTLER_PAUSE);
    render();
  },
  'set-admin': (el) => run(el, () => memberChange('setAdmin', { name: el.dataset.name, admin: !!el.dataset.on })),
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
  reclaim: () => {
    S.join.reclaim = true;
    render();
    document.getElementById('j-owner').focus();
  },
  'reclaim-cancel': () => { S.join.reclaim = false; render(); },
  'join-as': (el) => run(el, async () => {
    saveGroup(await api('join', { groupId: S.join.id, password: S.join.password, name: el.dataset.name }));
  }),
};

const forms = {
  create: (data, button) => run(button, async () => {
    if (data.password.length < MIN_PASSWORD) throw new Error(`Password needs at least ${MIN_PASSWORD} characters`);
    const seen = new Set([data.me.trim().toLowerCase()]);
    const repeated = [];
    const members = data.members.split('\n').map((n) => n.trim()).filter(Boolean).filter((n) => {
      const key = n.toLowerCase();
      if (seen.has(key)) { repeated.push(n); return false; }
      seen.add(key);
      return true;
    });
    saveGroup(await api('create', { ...data, members }));
    if (repeated.length) toast(`Listed twice, so added once: ${nameJoin(repeated)}`);
  }),
  reclaim: (data, button) => run(button, async () => {
    saveGroup(await api('reclaim', { groupId: S.join.id, ownerPassword: data.ownerPassword }));
  }),
  password: (data, button) => run(button, async () => {
    if (data.password.length < MIN_PASSWORD) throw new Error(`Password needs at least ${MIN_PASSWORD} characters`);
    await memberChange('changePassword', { password: data.password });
    toast('Group password changed. Tell your people the new one.');
  }),
  verify: (data, button) => run(button, async () => {
    const info = await api('verify', { groupId: S.join.id, password: data.password });
    S.join = { ...S.join, ...info, password: data.password };
    render();
  }),
  member: (data) => {
    if (!isAdmin()) return;
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
