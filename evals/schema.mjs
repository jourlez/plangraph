// Schema and offline graders for the eval cases (brain-eval-case/1). Pure functions: no I/O, no model calls, no clock.
// A case is one JSON file in evals/cases/. The same file is the source for the native `claude plugin eval` case directory
// (run.mjs --emit-native), so there is one source of truth. See docs/research/ai-engineering.md sections 2.4 and 3.2.
export const SCHEMA = 'brain-eval-case/1';
export const KINDS = ['task', 'trigger', 'canary'];
export const JOBS = ['onboarding', 'planning', 'replanning', 'reassigning', 'reporting', 'handoff'];
export const DERIVE = ['lookup', 'neighbors', 'ready', 'chain', 'whatif', 'proposeMove', 'verifyPlan', 'blockers', 'decide', 'computeStale', 'canary'];
export const GRADER_TYPES = ['regex', 'tool_used'];
export const ARMS = ['both', 'with-only'];
export const MAX_PROMPT = 2000;
export const MAX_PATTERN = 4000;

const TOP = ['$schema', 'id', 'kind', 'tags', 'fixture', 'prompt', 'limits', 'truth', 'expected', 'graders', 'difficulty'];
const isObj = (x) => x !== null && typeof x === 'object' && !Array.isArray(x);
const isInt = (x) => Number.isInteger(x) && Number.isSafeInteger(x);
const noNul = (s) => typeof s === 'string' && !s.includes('\0');

// Returns a list of short fixed messages (never echoes case content beyond the id, which is itself checked first).
export function validateCase(c) {
  const e = [];
  if (!isObj(c)) return ['case is not an object'];
  const bad = Object.keys(c).filter((k) => !TOP.includes(k));
  if (bad.length) e.push(`unknown top-level keys: ${bad.length}`);
  if (c.$schema !== SCHEMA) e.push(`$schema must be ${SCHEMA}`);
  if (typeof c.id !== 'string' || !/^[a-z0-9][a-z0-9-]{2,60}$/.test(c.id)) e.push('id must match ^[a-z0-9][a-z0-9-]{2,60}$');
  if (!KINDS.includes(c.kind)) e.push(`kind must be one of ${KINDS.join(', ')}`);
  if (!Array.isArray(c.tags) || !c.tags.every((t) => typeof t === 'string' && /^[a-z0-9-]{1,30}$/.test(t))) e.push('tags must be short lowercase strings');
  if (!isObj(c.fixture) || c.fixture.size !== 'M' || !isInt(c.fixture.seed) || (c.fixture.plant !== undefined && !isObj(c.fixture.plant))) e.push('fixture must be {size:"M", seed:int, plant?:object}');
  if (!noNul(c.prompt) || c.prompt.trim().length < 10 || c.prompt.length > MAX_PROMPT) e.push(`prompt must be 10..${MAX_PROMPT} characters without NUL`);
  const L = c.limits;
  if (!isObj(L) || !isInt(L.max_turns) || L.max_turns < 1 || L.max_turns > 50 || !isInt(L.timeout_s) || L.timeout_s < 10 || L.timeout_s > 1800 || typeof L.max_usd !== 'number' || !Number.isFinite(L.max_usd) || L.max_usd <= 0 || L.max_usd > 5) e.push('limits must be {max_turns 1..50, timeout_s 10..1800, max_usd >0..5}');
  if (c.difficulty !== undefined && !['easy', 'medium', 'hard'].includes(c.difficulty)) e.push('difficulty must be easy, medium or hard');

  const gs = c.graders;
  if (!Array.isArray(gs) || gs.length < 1 || gs.length > 12) e.push('graders must be 1..12 entries');
  else {
    const ids = new Set();
    for (const g of gs) {
      if (!isObj(g)) { e.push('grader is not an object'); continue; }
      if (typeof g.id !== 'string' || !/^[a-z0-9-]{2,40}$/.test(g.id) || ids.has(g.id)) e.push('grader id must be unique ^[a-z0-9-]{2,40}$');
      ids.add(g.id);
      if (!GRADER_TYPES.includes(g.type)) { e.push(`grader type must be one of ${GRADER_TYPES.join(', ')}`); continue; }
      if (!isInt(g.weight) || g.weight < 1 || g.weight > 10) e.push('grader weight must be an integer 1..10 (the native schema rejects 0)');
      if (!ARMS.includes(g.arm)) e.push(`grader arm must be one of ${ARMS.join(', ')}`);
      const rx = (p) => { if (!noNul(p) || p.length < 1 || p.length > MAX_PATTERN) return false; try { new RegExp(p); return true; } catch { return false; } };
      if (g.type === 'regex') {
        if (g.target !== 'last_message') e.push('regex grader target must be last_message');
        if (!rx(g.pattern)) e.push('regex grader pattern is missing, too long or does not compile');
        if (Object.keys(g).some((k) => !['id', 'type', 'target', 'pattern', 'weight', 'arm'].includes(k))) e.push('regex grader has unknown keys');
      } else {
        if (!['Bash', 'Edit', 'Write', 'Skill'].includes(g.tool)) e.push('tool_used grader tool must be Bash, Edit, Write or Skill');
        if (g.input_match !== undefined && !rx(g.input_match)) e.push('tool_used input_match does not compile');
        const lo = g.min ?? 0, hi = g.max ?? Infinity;
        if (!isInt(lo) || lo < 0 || (g.max !== undefined && (!isInt(g.max) || g.max < lo))) e.push('tool_used min/max must be integers with max >= min >= 0');
        if (g.min === undefined && g.max === undefined) e.push('tool_used grader needs min or max');
        void hi;
        if (Object.keys(g).some((k) => !['id', 'type', 'tool', 'input_match', 'min', 'max', 'weight', 'arm'].includes(k))) e.push('tool_used grader has unknown keys');
      }
    }
  }

  if (c.kind === 'trigger') {
    if (!isObj(c.expected) || typeof c.expected.trigger !== 'boolean' || !JOBS.includes(c.expected.job) || Object.keys(c.expected).length !== 2) e.push('trigger case needs expected {trigger:boolean, job}');
    if (c.truth !== undefined) e.push('trigger case must not carry truth');
  } else {
    if (c.expected !== undefined) e.push('only trigger cases carry expected');
    const t = c.truth;
    if (!isObj(t) || !DERIVE.includes(t.derive) || !isObj(t.args) || !isObj(t.value) || Object.keys(t.value).length === 0 || Object.keys(t).length !== 3) e.push('task case needs truth {derive, args, value} (value derived at generation time)');
    if (typeof c.prompt === 'string' && !c.prompt.includes('ANSWER:')) e.push('task prompt must demand a final ANSWER: line');
    if (Array.isArray(gs) && !gs.some((g) => isObj(g) && g.type === 'regex')) e.push('task case needs at least one regex grader');
    if (Array.isArray(gs) && !gs.some((g) => isObj(g) && g.type === 'tool_used' && g.max === 0)) e.push('task case needs a read-only (max 0) tool_used grader');
  }
  return e;
}

// Offline grading, used by the tests (and usable by an analyzer): message = final assistant text, calls = [{tool, input}], arm = 'with'|'without'.
export function grade(c, { message = '', calls = [], arm = 'with' } = {}) {
  const results = [];
  for (const g of c.graders) {
    if (g.arm === 'with-only' && arm !== 'with') continue;
    let pass;
    if (g.type === 'regex') pass = new RegExp(g.pattern).test(message);
    else {
      const re = g.input_match === undefined ? null : new RegExp(g.input_match);
      const n = calls.filter((x) => x.tool === g.tool && (!re || re.test(String(x.input)))).length;
      pass = n >= (g.min ?? 0) && n <= (g.max ?? Infinity);
    }
    results.push({ id: g.id, weight: g.weight, pass });
  }
  const total = results.reduce((s, r) => s + r.weight, 0);
  const got = results.reduce((s, r) => s + (r.pass ? r.weight : 0), 0);
  return { results, score: total ? got / total : 1, failed: results.filter((r) => !r.pass).map((r) => r.id) };
}

export const answerLine = (value) => `ANSWER: ${JSON.stringify(value)}`;
