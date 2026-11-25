#!/usr/bin/env node
// Per-case fixture overlays: small edits applied on top of a shared base fixture (a planted injection, a Jira snapshot, a lowered
// capacity, a thin history). The SAME pure function is used by the generator (to compute ground truth on exactly the patched data) and
// by each case's scaffold.sh (to patch the copied workspace), so the truth and the workspace cannot drift apart.
//   node evals/overlay.ts <overlay.json> <plan dir> <workspace root>     (run by scaffold.sh inside the fresh workspace)
// Ops (allowlisted, bounded):
//   {op:'set', file, key, field, value}   set one field of the row with that key (schedule.jsonl: the "current" row)
//   {op:'append', file, row}              append one JSONL row
//   {op:'config', path:[k,...], value}    set a nested config.json value (own keys only, no prototype names)
//   {op:'write', where:'plangraph'|'root', name, text}   write a small new file (a snapshot, a history) in the plan dir or the workspace root
// Lines that an op does not touch stay byte-identical. Exit codes: 0 ok, 2 bad overlay or target (fixed messages, never echoing data).
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { readCapped } from '../lib/jsonl.ts';
import { writeAtomicSafe, assertInside } from '../lib/fsafe.ts';

/** The fields each op uses are listed at the top of this file; validateOverlay checks them before any use. */
export interface OverlayOp { op: string; file?: string; key?: string; field?: string; value?: unknown; row?: Record<string, unknown>; path?: string[]; where?: string; name?: string; text?: string }
// `unknown[]` on the lists that untrusted values are looked up in: includes() compares by identity, any value is safe
export const DATA_FILES: unknown[] = ['tickets.jsonl', 'edges.jsonl', 'schedule.jsonl', 'findings.jsonl', 'open-items.jsonl', 'learnings.jsonl', 'refs.jsonl'];
const NAME = /^[a-z0-9][a-z0-9._-]{0,60}$/;
const BAD_KEYS = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_OPS = 200, MAX_TEXT = 1 << 20, MAX_FILE = 64 << 20, MAX_OVERLAY = 4 << 20;

export class OverlayError extends Error {}
const fail: (m: string) => never = (m) => { throw new OverlayError(m); }; // an explicit type lets `fail(...)` narrow like a throw
const isObj = (x: unknown): x is Record<string, unknown> => x !== null && typeof x === 'object' && !Array.isArray(x);

export function validateOverlay(ops: unknown): OverlayOp[] {
  if (!Array.isArray(ops) || ops.length > MAX_OPS) fail(`overlay must be an array of at most ${MAX_OPS} ops`);
  for (const o of ops as unknown[]) { // Array.isArray narrowed it to any[]
    if (!isObj(o)) fail('overlay op is not an object');
    if (o.op === 'set') { if (!DATA_FILES.includes(o.file) || typeof o.key !== 'string' || typeof o.field !== 'string' || BAD_KEYS.has(o.field) || o.field === 'key') fail('bad set op'); }
    else if (o.op === 'append') { if (!DATA_FILES.includes(o.file) || !isObj(o.row) || typeof o.row.key !== 'string' && typeof o.row.consumer !== 'string') fail('bad append op'); }
    else if (o.op === 'config') { if (!Array.isArray(o.path) || o.path.length < 1 || o.path.length > 4 || !o.path.every((k: unknown) => typeof k === 'string' && k && !BAD_KEYS.has(k))) fail('bad config op'); }
    else if (o.op === 'write') { if (!['plangraph', 'root'].includes(o.where as string) || typeof o.name !== 'string' || !NAME.test(o.name) || DATA_FILES.includes(o.name) || o.name === 'config.json' || typeof o.text !== 'string' || o.text.length > MAX_TEXT) fail('bad write op'); } // `as string`: includes() compares by identity, any value is safe
    else fail('unknown overlay op');
  }
  return ops as OverlayOp[]; // every op was checked above
}

const splitLines = (text: string) => (text === '' ? [] : text.replace(/\n$/, '').split('\n'));
const joinLines = (lines: string[]) => (lines.length ? lines.join('\n') + '\n' : '');

// files: { [name]: text } for the plan dir (data files and config.json). Returns { plangraph: {name: text} (changed or new), root: {name: text} }.
export function applyOverlay(files: Record<string, string>, ops: OverlayOp[]): { plangraph: Record<string, string>; root: Record<string, string> } {
  // the `as` assertions below: validateOverlay(ops) above checked every field its op uses
  validateOverlay(ops);
  const plangraph: Record<string, string> = {}, root: Record<string, string> = {};
  const get = (n: string) => (Object.hasOwn(plangraph, n) ? plangraph[n] : Object.hasOwn(files, n) ? files[n] : '');
  for (const o of ops) {
    if (o.op === 'set') {
      const lines = splitLines(get(o.file as string)); let hit = 0; // as: validateOverlay checked every field its op uses
      for (let i = 0; i < lines.length; i++) {
        let r: unknown; try { r = JSON.parse(lines[i]); } catch { continue; }
        if (!isObj(r) || r.key !== o.key || (o.file === 'schedule.jsonl' && (r.version ?? 'current') !== 'current')) continue;
        r[o.field as string] = o.value; lines[i] = JSON.stringify(r); hit++; // as: validateOverlay checked every field its op uses
      }
      if (hit !== 1) fail('set op must match exactly one row');
      plangraph[o.file as string] = joinLines(lines); // as: validateOverlay checked every field its op uses
    } else if (o.op === 'append') {
      plangraph[o.file as string] = joinLines([...splitLines(get(o.file as string)), JSON.stringify(o.row)]); // as: validateOverlay checked every field its op uses
    } else if (o.op === 'config') {
      let cfg: Record<string, unknown>; try { cfg = JSON.parse(get('config.json') || '{}'); } catch { fail('config.json is not JSON'); }
      let cur = cfg;
      for (const k of (o.path as string[]).slice(0, -1)) { if (!isObj(cur[k]) || !Object.hasOwn(cur, k)) cur[k] = {}; cur = cur[k] as Record<string, unknown>; } // as Record: isObj(cur[k]) held or the line before just set it; as: validateOverlay checked every field its op uses
      cur[(o.path as string[])[(o.path as string[]).length - 1]] = o.value; // as: validateOverlay checked every field its op uses
      plangraph['config.json'] = JSON.stringify(cfg, null, 1) + '\n';
    } else (o.where === 'plangraph' ? plangraph : root)[o.name as string] = o.text as string; // as: validateOverlay checked every field its op uses
  }
  return { plangraph, root };
}

// On disk: read the touched plangraph files (bounded), apply, write through writeAtomicSafe confined to the workspace root.
export function applyOverlayToDisk(ops: OverlayOp[], brainDir: string, rootDir: string): number {
  validateOverlay(ops);
  const rootReal = fs.realpathSync(rootDir);
  const bd = assertInside(rootReal, path.resolve(rootReal, brainDir));
  const names = new Set(['config.json']);
  for (const o of ops) if (o.file) names.add(o.file);
  const files: Record<string, string> = {};
  for (const n of names) { const f = path.join(bd, n); if (fs.existsSync(f)) files[n] = readCapped(f, MAX_FILE); }
  const { plangraph, root } = applyOverlay(files, ops);
  for (const [n, t] of Object.entries(plangraph)) writeAtomicSafe(path.join(bd, n), t, { root: rootReal });
  for (const [n, t] of Object.entries(root)) writeAtomicSafe(path.join(rootReal, n), t, { root: rootReal });
  return Object.keys(plangraph).length + Object.keys(root).length;
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  try {
    const [ov, brainDir, rootDir] = process.argv.slice(2);
    if (!ov || !brainDir || !rootDir) fail('usage: overlay.ts <overlay.json> <plan dir> <workspace root>');
    let ops: OverlayOp[]; try { ops = JSON.parse(readCapped(ov, MAX_OVERLAY)); } catch { fail('overlay file is unreadable or not JSON'); }
    applyOverlayToDisk(ops, brainDir, rootDir);
  } catch (e) {
    process.stderr.write(`error: ${e instanceof OverlayError ? e.message : 'overlay could not be applied'}\n`);
    process.exitCode = 2;
  }
}
