// Converts a plan directory written in the old layout (one JSONL file per kind) into the entity layout and stamps format.json as `init` does.
// Not a takeover: it reads the old files as they are (no validation, no repair) and removes each one once its rows are in the store. Used by the
// eval scaffolds and the test fixtures, which author old-layout files and need entity files before the first command.
import fs from 'node:fs';
import path from 'node:path';
import { readRecords, writeFormat, FORMAT_VERSION } from '../store.ts';
import { KINDS, kindFile } from '../planstore.ts';
import type { Row } from '../planstore.ts';
import { EntityStore } from './entitystore.ts';

/** Moves every old-layout file of `dir` (meta.jsonl stays a file in the entity layout) into entity files; a directory with no old file is only stamped, so the call is safe to repeat. */
export function adoptOldLayout(dir: string): void {
  const entity = new EntityStore({ dir, root: dir }, { durable: false }); // a fixture conversion: no fsync per file
  const found = KINDS.filter((k) => k !== 'meta' && fs.existsSync(path.join(dir, kindFile(k))));
  const rows = new Map(found.map((k) => [k, readRecords(dir, kindFile(k), { defaults: false }) as Row[]]));
  writeFormat(dir, { format_version: FORMAT_VERSION, min_reader: FORMAT_VERSION, storage: 'entity' });
  const nodes = found.filter((k) => !['schedule', 'evidence', 'finding', 'learning'].includes(k)); // kinds that live in node files: one pass over them
  entity.writeKinds(nodes.map((k) => [k, rows.get(k) as Row[]] as const));
  for (const k of found) { if (!nodes.includes(k)) entity.writeKind(k, rows.get(k) as Row[]); fs.rmSync(path.join(dir, kindFile(k))); }
}
