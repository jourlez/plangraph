# Widget Export Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Export a workspace's widgets as RFC 4180 CSV.

**Architecture:** A pure CSV formatter, a streaming store query, and a thin HTTP handler that wires them together.

**Tech Stack:** Node 24, node:test.

**Spec:** docs/superpowers/specs/2026-11-20-widget-export-design.md

## Global Constraints

- Columns are exactly `id,name,color,created_at`, in that order.
- Max 50,000 rows per export; above that the error code is `EXPORT_TOO_LARGE`.
- Dates are ISO 8601 UTC.

## Review Focus

- A widget name containing a comma, quote or newline must round-trip through a spreadsheet unchanged.

---

### Task 1: CSV formatter

**Files:**
- Create: `src/export/csv.mjs`
- Test: `test/export/csv.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `formatRow(widget: {id, name, color, createdAt: Date}): string` and `HEADER: string`.

- [ ] **Step 1: Write the failing test**

```js
test('formatRow quotes commas and quotes', () => {
  assert.equal(formatRow({ id: 1, name: 'a,"b"', color: 'red', createdAt: new Date(0) }), '1,"a,""b""",red,1970-01-01T00:00:00.000Z');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test test/export/csv.test.mjs`
Expected: FAIL with "Cannot find module"

- [ ] **Step 3: Implement `formatRow` in `src/export/csv.mjs`**

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test test/export/csv.test.mjs`
Expected: PASS

- [ ] **Step 5: Commit**

### Task 2: Streaming widget query

**Files:**
- Modify: `src/store/widgets.mjs:40-62`
- Test: `test/store/widgets.test.mjs`

**Interfaces:**
- Consumes: nothing from other tasks.
- Produces: `streamWidgets(workspaceId: string, { limit: number }): AsyncIterable<Widget>` that throws `ExportTooLarge` past `limit`.

- [ ] **Step 1: Write the failing test** for 50,001 rows throwing `ExportTooLarge`.
- [ ] **Step 2: Run** `node --test test/store/widgets.test.mjs`, expect FAIL.
- [ ] **Step 3: Implement** `streamWidgets`.
- [ ] **Step 4: Run** the test, expect PASS.
- [ ] **Step 5: Commit**

### Task 2: Export HTTP handler

**Files:**
- Create: `src/http/export-handler.mjs`
- Test: `test/http/export-handler.test.mjs`

**Interfaces:**
- Consumes: `formatRow` and `HEADER` from Task 1; `streamWidgets` from Task 2.
- Produces: `GET /workspaces/:id/widgets.csv`.

- [ ] **Step 1: Write the failing test** asserting `content-type: text/csv` and the first line equals `HEADER`.
- [ ] **Step 2: Run** `node --test test/http/export-handler.test.mjs`, expect FAIL.
- [ ] **Step 3: Implement** the handler; map `ExportTooLarge` to HTTP 413 with body `EXPORT_TOO_LARGE`.
- [ ] **Step 4: Run** the test, expect PASS.
- [ ] **Step 5: Commit**
