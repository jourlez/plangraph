// The synthetic project the documentation examples run in (docs/GETTING-STARTED.md and the README): a scripted git repository named `widgets`
// in a fresh temp directory, three commits by two authors, one superpowers-style plan document. Used by test/docs-examples.test.ts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { makeRepo, gitEnv, ANA, BEN } from './gitrepo.ts';
import { normalizeGolden } from './plan-dir.ts';

export const PLAN_PATH = 'docs/superpowers/plans/2026-01-05-widget-export.md';
export const PLAN_TEXT = `# Widget Export Implementation Plan

**Goal:** Export a workspace's widgets as CSV.

### Task 1: CSV formatter

Points: 3

**Files:**
- Create: \`src/csv.mjs\`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: \`formatRow(widget): string\`.

### Task 2: Export query

Points: 2

**Files:**
- Create: \`src/query.mjs\`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: \`streamWidgets(workspaceId): AsyncIterable<Widget>\`.

### Task 3: HTTP handler

Points: 2

**Files:**
- Create: \`src/handler.mjs\`

**Interfaces:**
- Consumes: \`formatRow\` from Task 1; \`streamWidgets\` from Task 2.
- Produces: \`GET /workspaces/:id/widgets.csv\`.
`;

/** The synthetic project: a git repository named `widgets` in a fresh temp directory, three commits by two authors, one plan document. */
export function makeProject(): { dir: string; home: string; cleanup(): void } {
  const base = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-docs-')));
  const home = path.join(base, 'home'); fs.mkdirSync(home);
  const repo = makeRepo({ dir: path.join(base, 'widgets') });
  repo.commit({ files: { 'src/csv.mjs': 'export const HEADER = "id,name";\n', 'README.txt': 'widgets\n' }, who: ANA, message: 'add the csv header' });
  repo.commit({ files: { 'src/query.mjs': 'export const limit = 50000;\n' }, who: BEN, message: 'add the query limit' });
  repo.commit({ files: { [PLAN_PATH]: PLAN_TEXT, 'src/handler.mjs': 'export const route = "/widgets.csv";\n' }, who: ANA, message: 'plan the export' });
  return { dir: repo.dir, home, cleanup: () => fs.rmSync(base, { recursive: true, force: true }) };
}

export const docsEnv = (home: string): NodeJS.ProcessEnv => ({
  ...gitEnv(), PATH: process.env.PATH, HOME: home, CLAUDE_PLUGIN_DATA: path.join(home, 'data'), LC_ALL: 'C', TZ: 'UTC', NO_COLOR: '1', PLANGRAPH_DIR: '', SOURCE_DATE_EPOCH: '1795305600', PLANGRAPH_STRICT_OUT: '1',
});
export const normalizeDoc = (text: string, dir: string): string => normalizeGolden(text.split(dir).join('<repo>')).replace(/(fresh: index )[0-9a-f]{8}/g, '$1<FP>').replace(/\s+$/, '');

