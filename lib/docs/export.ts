// Export of one generated document as neutral blocks for a remote mirror (Google Docs, Confluence, Notion, a connector). Pure: the same
// graph gives the same bytes. `source` is the repository path of the live copy, never a URL; a D24 or data-class finding refuses the export.
import type { Model, PlanConfig } from '../model.ts';
import { planDocs, policyOf, knownOf } from './registry.ts';
import { scanDocs } from './policy.ts';
import type { Extras } from './types.ts';

export type Block = { type: 'heading' | 'paragraph' | 'table' | 'code'; text: string };
export type ExportedDoc = { id: string; title: string; blocks: Block[]; fp: string; source: string };
export type ExportError = Error & { code: 'UNKNOWN_DOC' | 'D24_VIOLATION' | 'DATA_CLASS_VIOLATION' };
const fail = (code: ExportError['code'], message: string): ExportError => Object.assign(new Error(message), { code });

/** Markdown body of a generator to blocks: headings, pipe tables, <untrusted> fences (code), and paragraphs of consecutive lines. */
export function toBlocks(body: string): Block[] {
  const out: Block[] = [];
  const lines = body.split('\n');
  let para: string[] = [];
  const flush = () => { if (para.length > 0) out.push({ type: 'paragraph', text: para.join('\n') }); para = []; };
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] as string;
    if (/^<untrusted [^>]*>$/.test(l)) {
      flush();
      const j = lines.indexOf('</untrusted>', i + 1);
      const end = j < 0 ? lines.length : j;
      out.push({ type: 'code', text: lines.slice(i, end + 1).join('\n') });
      i = end;
    } else if (/^#{1,6} /.test(l)) { flush(); out.push({ type: 'heading', text: l.replace(/^#+ /, '') }); }
    else if (l.startsWith('|')) {
      flush();
      let j = i;
      while (j < lines.length && (lines[j] as string).startsWith('|')) j++;
      out.push({ type: 'table', text: lines.slice(i, j).join('\n') });
      i = j - 1;
    } else if (l.trim() === '') flush();
    else para.push(l);
  }
  flush();
  return out;
}

/** The document `id` (a generator id, or `<generator>.<key>` for a one-file-per-key generator) as blocks. */
export function exportDoc(id: string, model: Model, cfg: PlanConfig, extras: Extras = {}): ExportedDoc {
  const u = planDocs(model, cfg, extras).find((x) => x.region.id === id);
  if (!u) throw fail('UNKNOWN_DOC', 'no such document id');
  const policy = policyOf(cfg);
  const found = scanDocs(u.body, policy, knownOf(model, extras))[0];
  if (found) throw fail(found.code, `${found.code} ${found.kind} at line ${found.line} of ${u.region.id}`);
  return { id, title: u.title.replace(/^#+ /, ''), blocks: toBlocks(u.body), fp: u.region.fp, source: u.path };
}

/** The document ids a caller may export, sorted. */
export const exportableIds = (model: Model, cfg: PlanConfig, extras: Extras = {}): string[] => planDocs(model, cfg, extras).map((u) => u.region.id);
