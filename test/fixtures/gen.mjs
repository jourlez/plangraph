// Deterministic synthetic plans for tests and benchmarks. Names and keys are invented; never put real people or tickets in fixtures.
export function rng(seed = 1) { let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; }

const NAMES = ['Ana', 'Ben', 'Cleo', 'Dan', 'Eva', 'Finn', 'Gia', 'Hal'];

// genPlan({ n, people, density, seed, cap }): a feasible plan by construction (each ticket sprint = max over producers of
// producer sprint + 1 when owners differ, else +0; first sprint 1). Capacity is NOT enforced by construction: pass a large cap or check it.
export function genPlan({ n = 20, people = 3, density = 0.1, seed = 1, cap = 1000, maxSp = 5, prefix = 'T' } = {}) {
  const r = rng(seed), names = NAMES.slice(0, people);
  const key = (i) => `${prefix}-${i + 1}`;
  const tickets = [], edges = [], sched = [];
  const owner = [], sprint = [];
  for (let i = 0; i < n; i++) {
    owner[i] = names[Math.floor(r() * people)]; let s = 1;
    for (let j = 0; j < i; j++) if (r() < density * (i < 40 ? 1 : 40 / i)) { // forward edges only (j produces for i), so the graph is a DAG
      edges.push({ consumer: key(i), producer: key(j), kind: 'plan_need', note: '' });
      s = Math.max(s, sprint[j] + (owner[j] === owner[i] ? 0 : 1));
    }
    sprint[i] = s;
    tickets.push({ key: key(i), summary: `ticket ${i + 1}`, epic: `E${i % 4}`, sp: 1 + Math.floor(r() * maxSp), jira_status: 'To Do', v2_owner: owner[i], v2_sprint: s, verdict: 'READY', verdict_source: 'audit', first_verdict: 'READY' });
    sched.push({ version: 'current', key: key(i), owner: owner[i], sprint: s });
  }
  const config = { first_sprint: 1, end_sprint: Math.max(...sprint) + 2, caps: { default: cap }, min_per_sprint: {}, ignore_link_kinds: [], weights: { shortfall: 10000, load: 2, owner_change: 1 } };
  return { tickets, edges, schedule: sched, config };
}
