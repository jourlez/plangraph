// Read-only queries over the index: ticket neighbors chain sprint person blockers findings rules check verify ready card.
// Output and exit codes are those of the old bin/brain (frozen by test/golden.test.mjs); errors are typed (src/errors.mjs).
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { readDataCapped, presentDataFile } from '../../lib/jsonl.mjs';
import { oneLine, fenceInline } from '../../lib/sanitize.mjs';
import { makeGit } from '../../lib/gitsafe.mjs';
import { BIN, CUR, SRC_FILES, MAX_DATA, capOf, dbFile, rel, verbose, isPlaced, needBrain, usage, dataError, readJsonInput, modelFromDb, readItems, loadJiraSnap, wireMergeDriver, precheckTargets, writeState, fenceBlock, fencedList, nextCommand, nextList, dataText } from './shared.mjs';
/** @typedef {import('../context.mjs').Context} Ctx @typedef {import('../context.mjs').Args} Args */

const placeOf = (/** @type {import('../db.mjs').IndexHandle} */ d, /** @type {unknown} */ key) => d.get(`SELECT owner,sprint FROM schedule WHERE ${CUR} AND key=?`, key);

// Short data fields (status, verdict, owner, kind) are printed as one sanitized capped line each; free text (summary, finding text,
// evidence resolution) only inside one <untrusted> fence, one record per line, with the number of records bounded.
const w = (/** @type {unknown} */ x, n = 40) => oneLine(x, n);
/** @param {Ctx} ctx @param {Args} args */
function ticket(ctx, args) {
  const d = ctx.db(), [key] = args.positionals, out = ctx.io.out, v = verbose(args);
  const t = d.get('SELECT * FROM ticket WHERE key=?', key);
  if (!t) { out('not in the plan'); return 0; }
  const s = placeOf(d, key);
  // Fragments with no value are omitted (an unplaced or freshly ingested sp: task has no points, Jira status, verdict or placement).
  const parts = [w(t.key, 120)], data = [];
  if (t.sp != null) parts.push(`${w(t.sp, 20)} SP`);
  if (t.jira_status) data.push(`Jira ${w(t.jira_status)}`);
  if (t.verdict) data.push(`verdict ${w(t.verdict)}${t.verdict_source ? ` (${w(t.verdict_source)})` : ''}`);
  if (t.impl_status) data.push(`impl ${w(t.impl_status)}`);
  if (isPlaced(s)) data.push(`plan S${s.sprint} ${w(s.owner, 60)}`);
  const needs = d.all(`SELECT e.producer,e.kind,s.sprint,s.owner FROM edge e LEFT JOIN schedule s ON s.key=e.producer AND s.${CUR} WHERE e.consumer=? ORDER BY s.sprint, e.producer`, key);
  const neededBy = d.get('SELECT COUNT(*) c FROM edge WHERE producer=?', key).c;
  const fs_ = d.all('SELECT kind,text FROM finding WHERE key=?', key);
  // The data fields (statuses, verdict and its source, owner) are text from the plan: one inline <untrusted> fence around the group.
  if (data.length) parts.push(fenceInline(data.join(' | '), 400));
  if (!v) {
    // Default: ONE line. The summary is free text: one sanitized line (fenceInline: no newline, no angle brackets, so no forged line or tag),
    // capped at 60 characters, last, inside one inline <untrusted> fence; -v shows it inside the fence with the findings and evidence.
    parts.push(`needs ${needs.length}`, `needed by ${neededBy}`);
    if (fs_.length) parts.push(`${fs_.length} finding${fs_.length === 1 ? '' : 's'}`);
    if (t.summary) parts.push(fenceInline(t.summary, 60));
    out(parts.join(' | '));
    return 0;
  }
  out(parts.join(' | '));
  out(`needs: ${needs.map((n) => `${w(n.producer, 120)}${isPlaced(n) ? ` S${n.sprint}/${w(n.owner.split(' ')[0])}` : ''} [${w(n.kind)}]`).join(', ') || 'nothing'}`);
  out(`needed by: ${neededBy} tickets`);
  const max = 100, ev = d.all('SELECT source,verdict,resolution FROM evidence WHERE key=?', key);
  const lines = [
    ...(t.summary ? [`summary: ${oneLine(t.summary, 100)}`] : []),
    ...fs_.slice(0, max).map((f) => `finding [${w(f.kind)}]: ${oneLine(f.text, 1000)}`),
    ...ev.slice(0, max).map((e) => `evidence [${w(e.source)}] ${w(e.verdict)}: ${oneLine(e.resolution || '', 400)}`),
  ];
  if (lines.length) ctx.io.outBlock(fenceBlock(`ticket:${key}`, lines));
  const more = Math.max(0, fs_.length - max) + Math.max(0, ev.length - max);
  if (more) out(`... ${more} more findings or evidence rows`);
  return 0;
}

const MAX_DEPTH = 50;
/** @param {Ctx} ctx @param {Args} args */
function neighbors(ctx, args) {
  const d = ctx.db(), [key, rawDepth = '1'] = args.positionals;
  // The depth bounds a recursive query: an ASCII whole number from 0 to 50, never NaN or a huge value.
  if (!/^\d{1,3}$/.test(rawDepth) || Number(rawDepth) > MAX_DEPTH) throw usage('depth must be a whole number from 0 to 50');
  const depth = Number(rawDepth);
  const walk = (/** @type {string} */ a, /** @type {string} */ b) => d.all(`WITH RECURSIVE c(k,depth) AS (SELECT ?,0 UNION SELECT e.${b},c.depth+1 FROM edge e JOIN c ON e.${a}=c.k WHERE c.depth<?) SELECT k,MIN(depth) depth FROM c WHERE k<>? GROUP BY k`, key, depth, key);
  const fmt = (/** @type {any} */ r) => { const s = placeOf(d, r.k); return `${w(r.k, 120)}${s ? ` S${w(s.sprint, 20)}/${w(String(s.owner).split(' ')[0])}` : ''}`; };
  const down = walk('consumer', 'producer'), up = walk('producer', 'consumer');
  const lim = verbose(args) ? Infinity : 25, lst = (/** @type {any[]} */ a) => a.slice(0, lim).map(fmt).join(', ') + (a.length > lim ? ` +${a.length - lim} more` : '');
  ctx.io.out(`${w(key, 120)} needs (${down.length}): ${lst(down)}`);
  ctx.io.out(`${w(key, 120)} is needed by (${up.length}): ${lst(up)}`);
  return 0;
}

// Longest dependency chain behind a ticket: memoized DP over the producers in O(tickets + links), no path enumeration.
// "hops" is the longest path; "handoffs" is the longest path counting only links where the owner changes (each costs a sprint).
/** @param {Ctx} ctx @param {Args} args */
function chain(ctx, args) {
  const d = ctx.db(), [key] = args.positionals, out = ctx.io.out, skip = new Set(ctx.config().ignore_link_kinds || []); // like check
  const prods = new Map();
  for (const e of d.all('SELECT consumer,producer,kind FROM edge')) { if (skip.has(e.kind)) continue; if (!prods.has(e.consumer)) prods.set(e.consumer, []); prods.get(e.consumer).push(e.producer); }
  for (const a of prods.values()) a.sort(); // stable tie-break: the smallest key wins
  const own = new Map(d.all(`SELECT key,owner FROM schedule WHERE ${CUR}`).map((r) => [r.key, r.owner]));
  const hops = new Map(), via = new Map(), cnt = new Map(), hand = new Map(), state = new Map();
  const stack = /** @type {Array<[string, number]>} */ ([[key, 0]]); state.set(key, 1);
  while (stack.length) {
    const top = stack[stack.length - 1], v = top[0], ps = prods.get(v) || [];
    if (top[1] < ps.length) {
      const p = ps[top[1]++], st = state.get(p);
      if (st === 1) throw dataError(`dependency cycle: ${oneLine(p, 120)} is needed by ${oneLine(v, 120)} and also needs it`, 'run `brain check`');
      if (!st) { state.set(p, 1); stack.push([p, 0]); }
      continue;
    }
    let h = 0, bp = null, c = 1, w = 0;
    for (const p of ps) {
      const hp = hops.get(p) + 1;
      if (hp > h) { h = hp; bp = p; c = cnt.get(p); } else if (hp === h) c += cnt.get(p);
      const wp = hand.get(p) + (own.get(p) && own.get(v) && own.get(p) !== own.get(v) ? 1 : 0);
      if (wp > w) w = wp;
    }
    hops.set(v, h); via.set(v, bp); cnt.set(v, c); hand.set(v, w); state.set(v, 2); stack.pop();
  }
  const list = []; for (let v = key; v; v = via.get(v)) list.push(v);
  out(`longest chain behind ${w(key, 120)}: ${hops.get(key)} hops, ${hand.get(key)} handoffs, ${cnt.get(key)} critical path${cnt.get(key) === 1 ? '' : 's'}`);
  const rev = list.reverse(), show = rev.length > 12 ? [...rev.slice(0, 5), null, ...rev.slice(-5)] : rev;
  for (const k of show) {
    if (k === null) { out(`  ... ${rev.length - 10} more`); continue; }
    const s = placeOf(d, k); out(`  ${w(k, 120)} ${s ? `S${w(s.sprint, 20)} ${w(String(s.owner).split(' ')[0])}` : ''}`);
  }
  return 0;
}

/** @param {Ctx} ctx @param {Args} args */
function sprint(ctx, args) {
  if (!/^-?\d{1,7}$/.test(String(args.positionals[0]))) throw usage(`sprint needs a whole number, got "${oneLine(String(args.positionals[0])).slice(0, 40)}"`);
  const d = ctx.db(), cfg = ctx.config(), n = Number(args.positionals[0]);
  const rows = d.all(`SELECT s.owner, SUM(t.sp) sp, COUNT(*) n FROM schedule s JOIN ticket t ON t.key=s.key WHERE s.${CUR} AND s.sprint=? GROUP BY s.owner ORDER BY s.owner`, Number.isFinite(n) ? n : null);
  for (const r of rows) ctx.io.out(`${w(r.owner, 60)}: ${r.sp} SP / cap ${capOf(cfg, r.owner)} (${r.n} tickets)`);
  const over = rows.filter((r) => r.sp > capOf(cfg, r.owner));
  let none = null;
  if (!rows.length) { // say so, with the sprints the plan does cover, instead of printing nothing
    const rg = d.get(`SELECT MIN(sprint) lo, MAX(sprint) hi FROM schedule WHERE ${CUR}`);
    none = rg && rg.lo != null ? { first: rg.lo, last: rg.hi } : null;
    ctx.io.out(`sprint ${w(args.positionals[0], 40)}: no tickets${none ? `; plan covers S${none.first}-S${none.last}` : '; the plan has no scheduled tickets'}`);
  }
  ctx.io.data?.({ sprint: Number.isFinite(n) ? n : null, ...(rows.length ? {} : { empty: true, covers: none }), rows: rows.map((r) => ({ owner: w(r.owner, 60), sp: r.sp, cap: capOf(cfg, r.owner), tickets: r.n })), over: over.map((r) => w(r.owner, 60)) },
    { next: nextList(over.map((r) => nextCommand(['person', [r.owner]]))) });
  return 0;
}

/** @param {Ctx} ctx @param {Args} args */
function person(ctx, args) {
  const d = ctx.db(), rows = d.all(`SELECT s.sprint, SUM(t.sp) sp, COUNT(*) n FROM schedule s JOIN ticket t ON t.key=s.key WHERE s.${CUR} AND s.owner=? GROUP BY s.sprint ORDER BY s.sprint`, args.positionals[0]);
  ctx.io.out(`total ${rows.reduce((a, r) => a + r.sp, 0)} SP in ${rows.length} sprints`);
  for (const r of rows) ctx.io.out(`S${r.sprint}: ${r.sp} SP (${r.n})`);
  return 0;
}

/** @param {Ctx} ctx @param {Args} args */
function blockers(ctx, args) {
  // the verdict list as stored (a closed ticket with a non-READY verdict is listed too: `brain ready` says DONE for it)
  const d = ctx.db(), rows = d.all("SELECT key,verdict FROM ticket WHERE verdict<>'READY' AND verdict<>'' ORDER BY verdict,key"), by = new Map();
  for (const r of rows) { if (!by.has(r.verdict)) by.set(r.verdict, []); by.get(r.verdict).push(r.key); }
  ctx.io.out(`${rows.length} tickets not READY`); const lim = verbose(args) ? Infinity : 150;
  for (const [v, ks] of by) ctx.io.out(`${w(v)} (${ks.length}): ${ks.slice(0, lim).map((/** @type {unknown} */ k) => w(k, 120)).join(' ')}${ks.length > lim ? ` +${ks.length - lim} more` : ''}`);
  return 0;
}

/** @param {Ctx} ctx @param {Args} args */
function findings(ctx, args) {
  const d = ctx.db(), [kind] = args.positionals;
  if (!kind) { for (const r of d.all('SELECT kind, COUNT(*) c FROM finding GROUP BY kind')) ctx.io.out(`${w(r.kind, 48)}: ${r.c}`); return 0; }
  const v = verbose(args), rows = d.all('SELECT key,text FROM finding WHERE kind=? ORDER BY key', kind);
  ctx.io.outBlock(fencedList(`findings:${kind}`, rows, v ? 2000 : 30, (r) => `${w(r.key, 120)}: ${oneLine(r.text, v ? 2000 : 100)}`, `findings${v ? '' : ' (-v for up to 2000)'}`));
  return 0;
}

// ---- rules: brain learnings (index) or, with --repo, OpenWolf's .wolf/cerebrum.md read through and fenced ----
/** @param {Ctx} ctx @param {Args} args */
async function rulesRepo(ctx, args) {
  const W = await import('../../lib/integrations/openwolf.mjs'), v = verbose(args); let max = v ? 200 : 12;
  if (args.values.max !== undefined) {
    const m = args.values.max;
    if (!/^\d{1,3}$/.test(m) || +m < 1 || +m > (v ? 200 : 30)) throw usage('--max needs a whole number from 1 to 30 (up to 200 with -v)');
    max = +m;
  }
  const r = W.readWolfFile(ctx.root, 'cerebrum.md');
  if (!r.ok) { ctx.io.out(r.missing ? 'no repo rules: .wolf/cerebrum.md not found' : `warning: ${r.warning}`); return 0; }
  ctx.io.outBlock(W.renderRepoRules(W.parseCerebrum(r.text), { max, entryMax: v ? 1000 : 200 }));
  return 0;
}
/** @param {Ctx} ctx @param {Args} args */
function rules(ctx, args) {
  if (args.values.repo) return rulesRepo(ctx, args);
  const d = ctx.db(), [topic] = args.positionals;
  if (!topic) { for (const r of d.all('SELECT topic, COUNT(*) c FROM learning GROUP BY topic ORDER BY topic')) ctx.io.out(`${w(r.topic, 80)}: ${r.c}`); return 0; }
  // learning text is free text from the repo: one fence, one sanitized line per field, bounded
  const v = verbose(args), rows = d.all('SELECT id,kind,text,why FROM learning WHERE topic=? ORDER BY id', topic);
  const t = v ? 1000 : 300;
  ctx.io.outBlock(fencedList(`rules:${topic}`, rows, v ? 2000 : 30, (r) => `${w(r.id, 120)} [${w(r.kind, 40)}] ${oneLine(r.text, t)}\n   why: ${oneLine(r.why, t)}`, `rules${v ? '' : ' (-v for up to 2000)'}`));
  return 0;
}

/** @param {Ctx} ctx */
function check(ctx) {
  const d = ctx.db(), cfg = ctx.config(), skip = new Set(cfg.ignore_link_kinds || []);
  const sched = new Map(d.all(`SELECT key,owner,sprint FROM schedule WHERE ${CUR}`).map((r) => [r.key, r]));
  const sp = new Map(d.all('SELECT key,sp FROM ticket').map((r) => [r.key, r.sp]));
  const edges = d.all('SELECT consumer,producer,kind FROM edge').filter((e) => !skip.has(e.kind));
  let viol = 0; const load = new Map();
  for (const [k, s] of sched) { const id = `${s.owner}|${s.sprint}`; load.set(id, (load.get(id) || 0) + (sp.get(k) || 0)); }
  for (const e of edges) { const c = sched.get(e.consumer), p = sched.get(e.producer); if (!c || !p) continue; if (p.owner === c.owner ? p.sprint > c.sprint : p.sprint >= c.sprint) viol++; }
  const over = [...load].filter(([k, v]) => v > capOf(cfg, k.split('|')[0])).length;
  const ind = /** @type {Map<string, any>} */ (new Map([...sched.keys()].map((k) => [k, 0]))), adj = /** @type {Map<string, any>} */ (new Map([...sched.keys()].map((k) => [k, []])));
  for (const e of edges) if (ind.has(e.consumer) && ind.has(e.producer)) { ind.set(e.consumer, ind.get(e.consumer) + 1); adj.get(e.producer).push(e.consumer); }
  const q = [...ind].filter(([, v]) => v === 0).map((x) => x[0]); let seen = 0;
  while (q.length) { const u = /** @type {string} */ (q.pop()); seen++; for (const v of adj.get(u)) { ind.set(v, ind.get(v) - 1); if (!ind.get(v)) q.push(v); } }
  const last = [...sched.values()].reduce((m, s) => Math.max(m, s.sprint), -Infinity); // Math.max semantics, without spreading a huge array
  ctx.io.out(`tickets ${sched.size} | links ${edges.length} | strict-rule violations ${viol} | person-sprints over cap ${over} | loop-free ${seen === sched.size} | last sprint ${sched.size ? last : 0}`);
  return viol || over || seen !== sched.size ? 1 : 0; // CI fails on any violation
}

/** @param {Ctx} ctx @param {Args} args */
async function verify(ctx, args) {
  const V = await import('../../lib/verify.mjs'), R = await import('../../lib/render.mjs'), model = modelFromDb(ctx);
  let sched = model.sched;
  const [file] = args.positionals;
  if (file !== undefined) {
    const rows = readJsonInput(file, 'schedule file');
    if (!Array.isArray(rows)) throw dataError('schedule file must be a JSON array of {item, owner, sprint}');
    sched = new Map(rows.map((r) => [r?.item ?? r?.key, { owner: r?.owner, sprint: r?.sprint }]));
  }
  const v = V.verifyPlan(model, sched, { enforceMin: Boolean(args.values['enforce-min']) }), limit = verbose(args) ? 200 : 20;
  ctx.io.data?.({ ok: !v.length, tickets: model.tickets.size, violations: v.slice(0, limit).map((x) => ({ code: w(x.code), key: w(x.key, 120), detail: dataText(x.detail) })), total: v.length },
    { next: v.length ? nextList([nextCommand(['ticket', [v[0].key], '-v']), file === undefined ? 'brain check' : null]) : [] });
  if (!v.length) { ctx.io.out(`OK plan valid (${model.tickets.size} tickets)`); return 0; } // every ticket (unplaced sp: tasks included)
  for (const l of R.bound(v.map((x) => `${w(x.code)} ${w(x.key, 120)} ${dataText(x.detail, 1000)}`), { limit })) ctx.io.out(l);
  return 1;
}

// ---- definition of ready: may this ticket be started now? (the rules: lib/ready.mjs, shared with blockers and report) ----
/** @param {Ctx} ctx @param {Args} args */
async function ready(ctx, args) {
  const R = await import('../../lib/ready.mjs'), [key] = args.positionals, out = ctx.io.out;
  const model = modelFromDb(ctx);
  const data = (/** @type {Record<string, unknown>} */ o, /** @type {string[]} */ next = []) => ctx.io.data?.({ key: w(key, 120), ...o }, { next });
  // the key argument is printed as one sanitized line: it can be a key taken from the data (units --stale, a next command)
  const k = w(key, 120);
  if (!model.tickets.has(key)) { out(`${k}: not an open plan ticket (done, or not in the plan)`); data({ found: false, ready: false, reasons: [] }); return 0; }
  const snap = args.values.jira !== undefined ? await loadJiraSnap(args.values.jira) : null;
  const { items } = await readItems(ctx), r = R.readiness(model, key, { items, statuses: snap });
  // DONE: its own status is closed, so it is not something to start (a negative answer, exit 1)
  if (r.done) { out(`DONE ${k} (${r.done.by === 'impl' ? 'impl_status done' : `status ${w(r.done.status)}`})`); data({ found: true, ready: false, done: true, reasons: [] }); return 1; }
  // Open-item texts are free text: the reasons name only their kind, and the texts follow in one fence.
  // why: the text lines; reasons: the same facts as structured data for --json (same order); waits and kinds feed the next commands.
  const why = [], reasons = [], texts = [], waits = /** @type {string[]} */ ([]), kinds = [];
  for (const x of r.reasons) {
    if (x.code === 'VERDICT') { why.push(`readiness verdict is ${w(x.verdict)}`); reasons.push({ code: 'VERDICT', detail: w(x.verdict) }); }
    else if (x.code === 'OPEN_ITEM' && x.from === 'finding') { kinds.push(x.kind); why.push(`open item [${w(x.kind)}]`); reasons.push({ code: 'OPEN_ITEM', kind: w(x.kind) }); texts.push(`[${w(x.kind)}] ${oneLine(x.text, 120)}`); }
    else if (x.code === 'OPEN_ITEM') { why.push(`open item [${w(x.kind)}] (owner ${w(x.owner || '?')})`); reasons.push({ code: 'OPEN_ITEM', kind: w(x.kind), owner: w(x.owner) }); texts.push(`[${w(x.kind)}] ${oneLine(x.text, 120)}`); }
    else {
      const plan = x.place ? `, planned S${x.place.sprint} ${w(x.place.owner, 60)}` : '', st = x.status === null ? null : w(x.status);
      waits.push(x.key);
      reasons.push({ code: 'WAITS', key: w(x.key, 120), status: st, ...(x.place ? { sprint: x.place.sprint, owner: w(x.place.owner, 60) } : {}) });
      why.push(`waits for ${w(x.key, 120)} (${x.impl ? `impl_status ${st}` : st ?? 'no status'}${plan})`);
    }
  }
  // Bounded so the 40-line output bound never cuts the fence: at most 20 reasons and 10 texts (-v: 200 and 100).
  const v = verbose(args), maxWhy = v ? 200 : 20, maxText = v ? 100 : 10;
  if (!why.length) out(`READY TO START ${k}`);
  else {
    ctx.io.outBlock([`NOT READY ${k}`, ...why.slice(0, maxWhy).map((x) => `- ${x}`)]);
    if (why.length > maxWhy) out(`... ${why.length - maxWhy} more reasons (-v for up to 200)`);
    ctx.io.outBlock(fencedList(`ready:${key}`, texts, maxText, (x) => x, 'open-item texts'));
  }
  if (verbose(args) || !snap) out(snap ? '(statuses from the Jira snapshot given)' : '(statuses as of the last build: pass --jira snapshot.json for live ones)');
  data({ found: true, ready: !why.length, reasons: reasons.slice(0, maxWhy), more: Math.max(0, reasons.length - maxWhy), statuses: snap ? 'jira snapshot' : 'last build' },
    why.length ? nextList([...waits.slice(0, 2).map((p) => nextCommand(['ready', [p]])), ...kinds.map((k) => nextCommand(['findings', [k]]))]) : nextList([nextCommand(['ticket', [key]])]));
  return why.length ? 1 : 0;
}

// ---- session card ----
// Session-hook repair (`card --heal`): silent, never throws, never prompts. Only when the brain dir exists inside a git work tree,
// and only when doctor sees a problem (including a driver.target left at an older plugin install), so a healthy setup is not rewritten.
/** @param {Ctx} ctx */
async function healMergeDriver(ctx) {
  try {
    if (!fs.existsSync(ctx.dir)) return;
    if (makeGit(ctx.dir)('rev-parse', '--is-inside-work-tree').trim() !== 'true') return;
    const S = await import('../../lib/store.mjs');
    if (S.doctorMergeDriver(ctx.root, { dir: rel(ctx, ctx.dir), target: path.join(BIN, 'brain-merge') }).problems.length) await wireMergeDriver(ctx);
  } catch { /* the hook must never fail or print */ }
}

// One deterministic line for the agent to place under `## Context` in STATUS (never under OpenWolf's injected section). Brain data only.
/** @param {Ctx} ctx */
async function cardLine(ctx) {
  needBrain(ctx);
  const { loadModel, CONFIG_MAX } = await import('../../lib/model.mjs'), V = await import('../../lib/verify.mjs');
  const model = loadModel(ctx.dir, { config: ctx.config() }), h = crypto.createHash('sha256'); let last = 0;
  for (const f of ['config.json', ...SRC_FILES]) {
    let b = '';
    if (f !== 'config.json' && !presentDataFile(path.join(ctx.dir, f))) { h.update(`${f}\0${b.length}\0${b}\0`); continue; } // a symlinked data file is refused
    try { b = readDataCapped(path.join(ctx.dir, f), f === 'config.json' ? CONFIG_MAX : MAX_DATA); } catch (/** @type {any} */ e) { if (e.code !== 'ENOENT') throw e; } // O_NOFOLLOW + dev/ino: no symlink, no swap
    h.update(`${f}\0${b.length}\0${b}\0`);
  }
  for (const s of model.sched.values()) if (Number.isInteger(s.sprint) && s.sprint > last) last = s.sprint;
  ctx.io.out(`brain: ${model.tickets.size} tickets, last sprint ${last}, ${V.verifyPlan(model).length} violations @${h.digest('hex').slice(0, 8)}`);
  return 0;
}

/** @param {Ctx} ctx @param {Args} args */
async function card(ctx, args) {
  if (args.values.heal) await healMergeDriver(ctx);
  // Hook only: `card: off` (plugin userConfig, exported as CLAUDE_PLUGIN_OPTION_CARD, or BRAIN_CARD) silences the session-start card.
  // Healing above still ran; a manual `brain card` is never affected.
  if (args.values['if-present'] && [ctx.env.CLAUDE_PLUGIN_OPTION_CARD, ctx.env.BRAIN_CARD].some((v) => String(v ?? '').trim().toLowerCase() === 'off')) return 0;
  if (args.values.line) return cardLine(ctx);
  const file = dbFile(ctx);
  if (args.values['if-present'] && !fs.existsSync(file)) return 0;
  const R = await import('../../lib/render.mjs'), model = modelFromDb(ctx);
  // Cache-stable: identity is the source fingerprint of the text, STALE comes only from the fingerprint check of ctx.db() (content, not
  // modification times or a clock), so the same data prints the same bytes; in hook mode (--if-present) the card text itself says STALE.
  const h = ctx.db(), meta = { fp: h.fingerprint, stale: Boolean(h.stale) };
  const text = `${R.renderCard(model, meta)}\n`;
  if (args.values.write) {
    const dst = path.join(ctx.dir, 'CARD.md');
    precheckTargets(ctx, [dst]); writeState(ctx, dst, text); // a symlink or outside target is REFUSED (exit 4), nothing written
    ctx.io.out(`wrote ${rel(ctx, dst)} (${R.estTokens(text)} est tokens)`);
  } else ctx.io.raw(text);
  return 0;
}

const B = { type: 'boolean' };
export const commands = {
  ticket: { run: ticket, positionals: [1, 1], summary: 'one ticket: size, status, verdict, placement, needs, findings, evidence' },
  neighbors: { run: neighbors, positionals: [1, 2], summary: 'what a ticket needs and what needs it, to a depth (default 1)' },
  chain: { run: chain, positionals: [1, 1], summary: 'longest dependency chain behind a ticket' },
  sprint: { run: sprint, positionals: [1, 1], summary: 'load per person in one sprint' },
  person: { run: person, positionals: [1, 1], summary: "one person's load per sprint" },
  blockers: { run: blockers, positionals: [0, 0], summary: 'tickets whose verdict is not READY' },
  findings: { run: findings, positionals: [0, 1], summary: 'finding counts by kind, or the findings of one kind' },
  rules: { run: rules, positionals: [0, 1], options: { repo: B, max: { type: 'string', missing: '--max needs a whole number from 1 to 30 (up to 200 with -v)' } }, summary: 'learned rules by topic; --repo reads OpenWolf rules' },
  check: { run: check, positionals: [0, 0], summary: 'strict handoff rule, capacity and loops of the current plan (exit 1 on a violation)' },
  verify: { run: verify, positionals: [0, 1], options: { 'enforce-min': B }, summary: 'independent plan verifier (exit 1 on a violation)' },
  ready: { run: ready, positionals: [1, 1], options: { jira: { type: 'string' } }, summary: 'may this ticket be started now? (exit 1 with reasons)' },
  card: { run: card, positionals: [0, 0], writes: 'file', options: { write: B, line: B, heal: { ...B, writes: ['git-config', 'gitattributes', 'merge-shim'] } }, guard: (/** @type {Record<string, unknown>} */ v) => (v['if-present'] ? 'none' : 'soft'), summary: 'short plan summary for a session start' },
};
