// Rewrites a freshly built index into the shape of an older one: the eight v1 tables, no graph table, no view, and the content digest taken
// over those eight tables (what 0.3.0 stored). The source fingerprint is kept, so the text still matches. Used by the tests of the older-schema
// rule in src/db.ts, which stays until the incremental index replaces it.
import { DatabaseSync } from 'node:sqlite';
import { contentDigest, TABLES } from '../../src/db.ts';

export function downgradeToV1(file: string): void {
  const db = new DatabaseSync(file);
  try {
    const v1 = [...TABLES.values()].slice(0, 8);
    db.exec('DROP VIEW g_nodes; DROP VIEW g_links');
    for (const t of [...TABLES.values()].slice(8)) db.exec(`DROP TABLE ${t.name}`);
    const h = { prepare: (q: string) => db.prepare(q) } as unknown as Parameters<typeof contentDigest>[0];
    db.prepare('UPDATE index_meta SET v = ? WHERE k = ?').run(contentDigest(h, v1), 'content_digest');
  } finally { db.close(); }
}
