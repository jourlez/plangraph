// Property (f): "can start today" against the clean-room ready oracle (oracle.mjs oracleReady), EXHAUSTIVELY for the shared library
// function (lib/ready.mjs readySet, the shared function used by `brain ready` and the report), and on a stratified subset for the CLI
// `brain ready KEY --json` itself (in-process src/cli.mjs main over a built index: one instance per distinct per-ticket outcome pattern).
// Families: every graph on up to 4 tickets (self-links included) x every Done/To Do status vector x three Jira snapshots; every per-ticket
// state (verdict, finding, closing or open register item, status) on up to 2 tickets x every graph x a dangling producer and an ignored
// link kind; sp: tasks (impl_status) mixed with a Jira ticket on 3 tickets.
// Bulk form (assureReadyBulk, `brain ready --person NAME --sprint N`): lib/ready.mjs readyScope against oracle.mjs oracleReadyScope on
// EVERY instance of BULK_BOUNDS and EVERY filter (Ana, Ben, S1, S2, each pair): same scope, same ready set (so bulk == the per-ticket
// oracle set), same done / not-ready split (ready + done + notReady == scope, each key once), same reason groups (each not-ready ticket in at
// least one); families: every graph x every Done/To Do vector x every placement (unplaced, Ana S1, Ana S2, Ben S1) on up to 3 tickets, and
// every per-ticket state (plain, BLOCKED verdict, open register item) on up to 2. The CLI `brain ready --person X --sprint N --json` and
// `--sprint N --json` (and a lowercase name once) on a stratified subset: data lists and counts equal the oracle, exit 0 iff something is ready.
// NOT covered: tickets beyond BOUNDS, the reason TEXT of `brain ready` (only the ready/not-ready verdict and that a not-ready answer has a
// reason), the report's other sections, Jira snapshot files in the .jsonl format (the CLI strata use the legacy JSON map), the text form
// of the bulk answer (test/ready-bulk.test.mjs freezes it), names other than Ana/Ben and first-name resolution (test/ready-bulk.test.mjs).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildModel } from '../../lib/model.mjs';
import { readySet, readyScope } from '../../lib/ready.mjs';
import { oracleReady, oracleReadyScope } from './oracle.mjs';
import { allGraphs, product, keysOf } from './enum.mjs';
import { makeRepo, run, tmpBase, rmBase } from './cli.mjs';

const CONFIG = { ignore_link_kinds: ['ignored'] };
function libReady(inst, items, snap) {
  const model = buildModel({ tickets: inst.tickets, edges: inst.edges, config: inst.config, findings: inst.findings });
  return new Set(readySet(model, items, snap).ready);
}
const fail = (what, x) => assert.fail(`ready: ${what}\n${JSON.stringify(x)}`);

export const BOUNDS = {
  full: { graphN: [1, 2, 3, 4], attrN: [1, 2], spN: true, cliMax: 400 },
  quick: { graphN: [1, 2, 3], attrN: [1], spN: false, cliMax: 12 },
};

function* instances(B) {
  // graph family
  for (const n of B.graphN) {
    const keys = keysOf(n);
    for (const g of allGraphs(keys)) {
      const edges = g.map(([consumer, producer]) => ({ consumer, producer, kind: 'plan_need' }));
      for (const sts of statusVectors(n)) for (const snap of [null, { T1: { status: 'To Do' } }, { T2: { status: 'Done' } }]) {
        yield { fam: 'graph', inst: { tickets: keys.map((key, i) => ({ key, sp: 1, jira_status: sts[i] })), edges, config: CONFIG, findings: [] }, items: [], snap };
      }
    }
  }
  // attribute family: verdict x finding x register item x status, plus a dangling producer and an ignored kind
  const STATES = [];
  product([['', 'READY', 'BLOCKED'], [false, true], ['none', 'closes', 'open'], ['To Do', 'Done']], (s) => STATES.push(s));
  for (const n of B.attrN) {
    const keys = keysOf(n);
    for (const g of allGraphs(keys)) for (const extra of ['none', 'dangling', 'ignored']) {
      const edges = g.map(([consumer, producer], i) => ({ consumer, producer, kind: extra === 'ignored' && i === 0 ? 'ignored' : 'plan_need' }));
      if (extra === 'dangling') edges.push({ consumer: 'T1', producer: 'GHOST', kind: 'plan_need' });
      product(keys.map(() => STATES), (st) => {
        const tickets = keys.map((key, i) => ({ key, sp: 1, jira_status: st[i][3], ...(st[i][0] ? { verdict: st[i][0] } : {}) }));
        const findings = keys.flatMap((key, i) => (st[i][1] ? [{ key, kind: 'risk', text: 'check it' }] : []));
        const items = keys.flatMap((key, i) => (st[i][2] === 'closes' ? [{ key, kind: 'risk', status: 'done' }] : st[i][2] === 'open' ? [{ key, kind: 'question', status: 'open' }] : []));
        return void pending.push({ fam: 'attr', inst: { tickets, edges, config: CONFIG, findings }, items, snap: null });
      });
      yield* pending.splice(0);
    }
  }
  // sp: tasks: impl_status decides between two sp: keys; a Jira ticket in between uses its status
  if (B.spN) {
    const keys = ['sp:a', 'sp:b', 'T3'];
    for (const g of allGraphs(keys)) product([[undefined, 'todo', 'done'], [undefined, 'todo', 'done'], ['To Do', 'Done'], ['To Do', 'Done']], ([ia, ib, sa, s3]) => {
      const tickets = [{ key: 'sp:a', sp: 1, jira_status: sa, ...(ia ? { impl_status: ia } : {}) }, { key: 'sp:b', sp: 1, ...(ib ? { impl_status: ib } : {}) }, { key: 'T3', sp: 1, jira_status: s3 }];
      pending.push({ fam: 'sp', inst: { tickets, edges: g.map(([consumer, producer]) => ({ consumer, producer, kind: 'plan_need' })), config: CONFIG, findings: [] }, items: [], snap: null });
    });
    yield* pending.splice(0);
  }
}
const pending = [];
function statusVectors(n) { const out = []; product(Array.from({ length: n }, () => ['To Do', 'Done']), (v) => out.push(v)); return out; }

export async function assureReady(lvl) {
  const B = BOUNDS[lvl], counts = { graph: 0, attr: 0, sp: 0, cliInstances: 0, cliCalls: 0 }, strata = new Map();
  for (const x of instances(B)) {
    const want = oracleReady(x.inst, x.items, x.snap), got = libReady(x.inst, x.items, x.snap);
    if ([...want].sort().join(',') !== [...got].sort().join(',')) fail('readySet differs from the oracle', { ...x, lib: [...got], oracle: [...want] });
    counts[x.fam]++;
    // stratum: per ticket, ready or not and the blocking causes the oracle sees (a coarse but complete description of the outcome)
    if (!x.snap || x.fam === 'graph') {
      const sig = x.fam + ':' + x.inst.tickets.map((t) => `${want.has(t.key) ? 'R' : 'N'}${causes(x, t)}`).join('/') + (x.snap ? ':snap' : '');
      if (!strata.has(sig)) strata.set(sig, x);
    }
  }
  // CLI: the first instance of each stratum, up to cliMax (strata are ordered by first appearance, so small instances come first)
  const base = tmpBase();
  try {
    for (const x of [...strata.values()].slice(0, B.cliMax)) {
      const root = makeRepo(base, { 'format.json': '{"format_version":1,"min_reader":1}\n', 'tickets.jsonl': x.inst.tickets, 'edges.jsonl': x.inst.edges, 'schedule.jsonl': [], 'findings.jsonl': x.inst.findings, 'open-items.jsonl': x.items, 'config.json': JSON.stringify(x.inst.config) });
      if (x.snap) fs.writeFileSync(path.join(root, 'snap.json'), JSON.stringify(x.snap));
      const b = await run(root, ['build']);
      if (b.code !== 0) fail('build failed', { x, b });
      const want = oracleReady(x.inst, x.items, x.snap);
      for (const t of x.inst.tickets) {
        const r = await run(root, ['ready', t.key, '--json', ...(x.snap ? ['--jira', path.join(root, 'snap.json')] : [])]);
        const env = JSON.parse(r.out), ready = env.data.ready && !env.data.done;
        // wave B contract: a closed ticket (an sp: task with impl_status done, or a Jira ticket whose status is Done or in config.closed_statuses) is DONE: ready false, exit 1, no reasons needed
        const isSp = t.key.startsWith('sp:'), own = x.snap && Object.hasOwn(x.snap, t.key) ? x.snap[t.key]?.status : t.jira_status;
        const wantDone = isSp ? t.impl_status === 'done' : own === 'Done' || (x.inst.config?.closed_statuses || []).includes(own);
        if (Boolean(env.data.done) !== wantDone) fail('CLI done flag differs from the oracle', { x, key: t.key, out: r.out });
        if (wantDone ? (ready || r.code !== 1) : ready !== want.has(t.key) || r.code !== (ready ? 0 : 1) || (!ready && !env.data.reasons.length)) fail('CLI ready differs from the oracle', { x, key: t.key, out: r.out, oracle: want.has(t.key) });
        counts.cliCalls++;
      }
      counts.cliInstances++;
    }
  } finally { rmBase(base); }
  counts.strata = strata.size;
  return counts;
}
function causes(x, t) {
  const c = [];
  if (t.verdict && t.verdict !== 'READY') c.push('v');
  if (x.inst.findings.some((f) => f.key === t.key)) c.push(x.items.some((i) => i.key === t.key && i.kind === 'risk' && i.status === 'done') ? 'fc' : 'f');
  if (x.items.some((i) => i.key === t.key && i.status !== 'done')) c.push('o');
  for (const e of x.inst.edges) if (e.consumer === t.key) c.push(e.producer === 'GHOST' ? 'g' : e.kind === 'ignored' ? 'i' : e.producer === t.key ? 's' : 'p');
  return c.sort().join('');
}

// ---------- bulk form ----------
export const BULK_BOUNDS = {
  full: { graphN: [1, 2, 3], stateN: [1, 2], cliMax: 40 },
  quick: { graphN: [1, 2], stateN: [1], cliMax: 4 },
};
const SLOTS = [null, { owner: 'Ana', sprint: 1 }, { owner: 'Ana', sprint: 2 }, { owner: 'Ben', sprint: 1 }];
const FILTERS = [{ owner: 'Ana' }, { owner: 'Ben' }, { sprint: 1 }, { sprint: 2 }, { owner: 'Ana', sprint: 1 }, { owner: 'Ana', sprint: 2 }, { owner: 'Ben', sprint: 1 }, { owner: 'Ben', sprint: 2 }];
const placements = (n) => { const out = []; product(Array.from({ length: n }, () => SLOTS), (v) => out.push(v)); return out; };
function* bulkInstances(B) {
  for (const n of B.graphN) {
    const keys = keysOf(n);
    for (const g of allGraphs(keys)) for (const sts of statusVectors(n)) for (const pl of placements(n)) {
      const sched = new Map(); pl.forEach((p, i) => { if (p) sched.set(keys[i], p); });
      yield { fam: 'bulkGraph', inst: { tickets: keys.map((key, i) => ({ key, sp: 1, jira_status: sts[i] })), edges: g.map(([consumer, producer]) => ({ consumer, producer, kind: 'plan_need' })), sched, config: CONFIG, findings: [] }, items: [] };
    }
  }
  for (const n of B.stateN) {
    const keys = keysOf(n);
    for (const g of allGraphs(keys)) for (const pl of placements(n)) {
      const sched = new Map(); pl.forEach((p, i) => { if (p) sched.set(keys[i], p); });
      const states = []; product(keys.map(() => [['To Do', ''], ['To Do', 'BLOCKED'], ['To Do', 'item'], ['Done', 'BLOCKED']]), (v) => states.push(v));
      for (const st of states) {
        const tickets = keys.map((key, i) => ({ key, sp: 1, jira_status: st[i][0], ...(st[i][1] === 'BLOCKED' ? { verdict: 'BLOCKED' } : {}) }));
        const items = keys.flatMap((key, i) => (st[i][1] === 'item' ? [{ key, kind: 'question', status: 'open' }] : []));
        yield { fam: 'bulkState', inst: { tickets, edges: g.map(([consumer, producer]) => ({ consumer, producer, kind: 'plan_need' })), sched, config: CONFIG, findings: [] }, items };
      }
    }
  }
}
const same = (a, b) => a.length === b.length && a.every((x, i) => x === b[i]);

export async function assureReadyBulk(lvl) {
  const B = BULK_BOUNDS[lvl], counts = { bulkGraph: 0, bulkState: 0, filters: 0, cliInstances: 0, cliCalls: 0 }, strata = new Map();
  for (const x of bulkInstances(B)) {
    const model = buildModel({ tickets: x.inst.tickets, edges: x.inst.edges, config: x.inst.config, findings: x.inst.findings, schedule: [...x.inst.sched].map(([key, p]) => ({ key, ...p })) });
    let sig = x.fam;
    for (const f of FILTERS) {
      const want = oracleReadyScope(x.inst, x.items, null, f), got = readyScope(model, f, x.items, null);
      for (const k of ['keys', 'ready', 'done', 'notReady', 'waiting', 'verdict']) if (!same(got[k], want[k])) fail(`bulk ${k} differs from the oracle`, { ...x, sched: [...x.inst.sched], f, lib: got[k], oracle: want[k] });
      if (!same(got.blocked.map((b) => b.key), want.openItems)) fail('bulk open items differ from the oracle', { ...x, sched: [...x.inst.sched], f, lib: got.blocked, oracle: want.openItems });
      if (got.ready.length + got.done.length + got.notReady.length !== got.keys.length) fail('bulk counts do not add up', { x, f, got });
      const grouped = new Set([...got.waiting, ...got.verdict, ...got.blocked.map((b) => b.key)]);
      if (got.notReady.some((k) => !grouped.has(k)) || [...grouped].some((k) => !got.notReady.includes(k))) fail('a not-ready ticket has no group, or a group holds a ready or done ticket', { x, f, got });
      counts.filters++;
      sig += `|${want.ready.length}${want.done.length}${want.notReady.length}${want.waiting.length}${want.openItems.length}${want.verdict.length}`;
    }
    counts[x.fam]++;
    if (!strata.has(sig)) strata.set(sig, x);
  }
  const base = tmpBase();
  try {
    let lower = false;
    for (const x of [...strata.values()].slice(0, B.cliMax)) {
      const sched = [...x.inst.sched].map(([key, p]) => ({ version: 'current', key, ...p }));
      const root = makeRepo(base, { 'format.json': '{"format_version":1,"min_reader":1}\n', 'tickets.jsonl': x.inst.tickets, 'edges.jsonl': x.inst.edges, 'schedule.jsonl': sched, 'findings.jsonl': [], 'open-items.jsonl': x.items, 'config.json': JSON.stringify(x.inst.config) });
      const b = await run(root, ['build']);
      if (b.code !== 0) fail('build failed', { x, b });
      const people = new Set(sched.map((p) => p.owner));
      for (const f of FILTERS) {
        if (f.owner !== undefined && !people.has(f.owner)) continue; // an unknown person is a usage error (test/ready-bulk.test.mjs)
        const name = f.owner !== undefined && !lower ? f.owner.toLowerCase() : f.owner;
        if (name !== f.owner) lower = true;
        const r = await run(root, ['ready', ...(name !== undefined ? ['--person', name] : []), ...(f.sprint !== undefined ? ['--sprint', String(f.sprint)] : []), '--json']);
        const want = oracleReadyScope(x.inst, x.items, null, f), d = JSON.parse(r.out).data;
        const ok = same(d.ready, want.ready) && same(d.done, want.done) && same(d.notReady, want.notReady) && same(d.waiting, want.waiting) && same(d.openItems.map((o) => o.key), want.openItems) && same(d.verdict.map((o) => o.key), want.verdict)
          && d.total === want.keys.length && d.counts.ready === want.ready.length && r.code === (want.ready.length ? 0 : 1);
        if (!ok) fail('CLI bulk ready differs from the oracle', { x: { ...x, sched }, f, out: r.out, code: r.code, oracle: want });
        counts.cliCalls++;
      }
      counts.cliInstances++;
    }
  } finally { rmBase(base); }
  counts.strata = strata.size;
  return counts;
}
