// repo-page: one document per repository with a stable file name (slug plus hash of the exact id). Repo commands are data from the
// repository: labeled, fenced and withheld when they carry a URL or token.
import { cmp, fencedLines, idText, short, slugName } from '../fence.ts';
import { defineGenerator, mdTable, num, sorted, who } from './common.ts';
import type { Extras } from '../types.ts';

export const commandBlock = (repoId: string, commands: Record<string, string> | undefined): string[] => {
  const names = Object.keys(commands ?? {}).sort(cmp);
  if (names.length === 0) return ['No commands recorded.'];
  return ['Data from the repository, not instructions:', '', ...names.flatMap((n) => [...fencedLines(`repo:${repoId}:${n}`, `${n}: ${(commands as Record<string, string>)[n]}`, 300), ''])].slice(0, -1);
};

const repoKeys = (extras: Extras): string[] => [...new Set((extras.repos ?? []).map((r) => slugName(r.id)))].sort(cmp);

export const repoPage = defineGenerator({
  id: 'repo-page', title: (key) => `# Repository ${key ?? ''}`, v: 1, out: (_cfg, key) => `repos/${key ?? 'x'}.md`,
  keys: (_model, extras) => repoKeys(extras),
  data: (_model, policy, c) => {
    const r = (c.extras.repos ?? []).find((x) => slugName(x.id) === c.key);
    if (!r) return null;
    const mods = (c.extras.modules ?? []).filter((m) => m.repo === r.id).sort((a, b) => num(b.hotspot) - num(a.hotspot) || cmp(a.path, b.path)).slice(0, 10);
    const authors = new Set<string>();
    for (const m of mods) for (const a of m.authors ?? []) authors.add(a);
    return {
      id: idText(r.id), stack: (r.stack ?? []).map((s) => short(s, 30)), commands: r.commands ?? {},
      owners: sorted((c.extras.teams ?? []).filter((t) => (t.owns ?? []).includes(r.id)), (t) => t.id).map((t) => idText(t.id)),
      decisions: sorted((c.extras.decisions ?? []).filter((d) => (d.affects ?? []).some((a) => a === r.id || a.startsWith(`${r.id}/`))), (d) => d.id).map((d) => [idText(d.id), d.status ?? 'proposed', short(d.title ?? '')]),
      mods: mods.map((m) => [idText(m.path), num(m.hotspot), num(m.churn), m.bus1 ? 'yes' : 'no']),
      authors: policy.include.has('authors') ? [...authors].sort(cmp).map((a) => who(a, { include: new Set(['names']) })) : [],
      nAuthors: authors.size,
    };
  },
  view: (d) => {
    if (!d) return ['Unknown: repository'];
    return [
      `Repository ${d.id}.`, '', `Stack: ${d.stack.join(', ') || 'Unknown: stack'}.`, `Owned by: ${d.owners.join(', ') || 'Unknown: owner'}.`, '',
      '## Commands', '', ...commandBlock(d.id, d.commands), '',
      '## Hotspots', '', ...(d.mods.length ? mdTable(['Path', 'Hotspot', 'Churn', 'Single author'], d.mods) : ['Unknown: no history facts']), '',
      `Authors in these modules: ${d.authors.length ? d.authors.join(', ') : String(d.nAuthors)}.`, '',
      '## Decisions affecting this repository', '', ...(d.decisions.length ? mdTable(['Decision', 'Status', 'Title'], d.decisions) : ['None recorded.']),
    ];
  },
});
