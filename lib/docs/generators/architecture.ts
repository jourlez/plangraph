// architecture: arc42 headings 1 to 12. A section with no source prints `Unknown: <what>`; the same list is repeated at the top.
import { idText, short } from '../fence.ts';
import { defineGenerator, mdTable, num, sorted } from './common.ts';

const SECTIONS = [
  'Introduction and Goals', 'Architecture Constraints', 'Context and Scope', 'Solution Strategy', 'Building Block View', 'Runtime View',
  'Deployment View', 'Cross-cutting Concepts', 'Architecture Decisions', 'Quality Requirements', 'Risks and Technical Debt', 'Glossary',
] as const;

type Sec = { lines: string[]; unknown: string | null };
const known = (lines: string[]): Sec => ({ lines, unknown: null });
const unknown = (what: string): Sec => ({ lines: [`Unknown: ${what}`], unknown: what });

export const architecture = defineGenerator({
  id: 'architecture', title: () => '# Architecture (arc42)', v: 1, out: () => 'architecture.md',
  data: (_model, _policy, c): Sec[] => {
    const reqs = c.extras.requirements ?? [], decs = sorted(c.extras.decisions ?? [], (d) => d.id), repos = sorted(c.extras.repos ?? [], (r) => r.id);
    const teams = sorted(c.extras.teams ?? [], (t) => t.id), mods = c.extras.modules ?? [];
    const count = (xs: readonly string[]) => [...new Set(xs)].sort().map((k) => `${k} ${xs.filter((x) => x === k).length}`).join(', ');
    const accepted = decs.filter((d) => d.status === 'accepted');
    const withAcc = reqs.filter((r) => (r.acceptance ?? []).length > 0);
    const hot = [...mods].sort((a, b) => num(b.hotspot) - num(a.hotspot) || (a.repo + a.path < b.repo + b.path ? -1 : 1)).slice(0, 5);
    const risky = mods.filter((m) => m.bus1).sort((a, b) => (a.repo + a.path < b.repo + b.path ? -1 : 1)).slice(0, 10);
    return [
      reqs.length ? known([`${reqs.length} requirements: ${count(reqs.map((r) => r.status ?? 'proposed'))}.`, `Ids: ${sorted(reqs, (r) => r.id).slice(0, 20).map((r) => idText(r.id)).join(', ')}${reqs.length > 20 ? `, ... ${reqs.length - 20} more` : ''}.`]) : unknown('requirements'),
      unknown('constraints'),
      repos.length || teams.length ? known([`${repos.length} repositories, ${teams.length} teams.`, ...teams.slice(0, 20).map((t) => `- team ${idText(t.id)} owns ${(t.owns ?? []).map(idText).sort().join(', ') || 'nothing recorded'}`)]) : unknown('repositories and teams'),
      accepted.length ? known(accepted.slice(0, 20).map((d) => `- ${idText(d.id)}: ${short(d.title ?? '')}`)) : unknown('strategy (no accepted decisions)'),
      repos.length ? known([...mdTable(['Repository', 'Stack'], repos.slice(0, 60).map((r) => [idText(r.id), (r.stack ?? []).map((s) => short(s, 30)).join(', ')])), ...(repos.length > 60 ? [`... ${repos.length - 60} more`] : []), ...(hot.length ? ['', 'Hotspots:', ...hot.map((m) => `- ${idText(m.repo)}/${idText(m.path)} (${num(m.hotspot)})`)] : [])]) : unknown('building blocks'),
      unknown('runtime scenarios'),
      unknown('deployment'),
      unknown('cross-cutting concepts'),
      decs.length ? known(mdTable(['Decision', 'Status', 'Title'], decs.slice(0, 50).map((d) => [idText(d.id), d.status ?? 'proposed', short(d.title ?? '')]))) : unknown('decisions'),
      withAcc.length ? known([`${withAcc.length} requirements carry acceptance criteria: ${sorted(withAcc, (r) => r.id).slice(0, 20).map((r) => idText(r.id)).join(', ')}.`]) : unknown('quality requirements'),
      risky.length ? known(['Modules with a single recent author:', ...risky.map((m) => `- ${idText(m.repo)}/${idText(m.path)}`)]) : unknown('risks'),
      unknown('glossary'),
    ];
  },
  view: (secs) => {
    const out: string[] = ['## Unknowns', ''];
    const unk = secs.map((s, i) => [i + 1, s.unknown] as const).filter((x): x is readonly [number, string] => x[1] !== null);
    out.push(...(unk.length ? unk.map(([i, w]) => `- ${i} ${SECTIONS[i - 1]}: ${w}`) : ['None.']), '');
    secs.forEach((s, i) => out.push(`## ${i + 1}. ${SECTIONS[i]}`, '', ...s.lines, ''));
    return out.slice(0, -1);
  },
});
