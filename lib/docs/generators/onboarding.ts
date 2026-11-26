// onboarding: where to start. Stack commands are labeled data from each repository, owners are ids, then hotspots and open decisions.
import { cmp, idText, short } from '../fence.ts';
import { commandBlock } from './repo-page.ts';
import { defineGenerator, mdTable, num, sorted, who } from './common.ts';

export const onboarding = defineGenerator({
  id: 'onboarding', title: () => '# Onboarding', v: 1, out: () => 'onboarding.md',
  data: (_model, policy, c) => ({
    repos: sorted(c.extras.repos ?? [], (r) => r.id).slice(0, 30).map((r) => ({ id: idText(r.id), stack: (r.stack ?? []).map((s) => short(s, 30)), commands: r.commands ?? {} })),
    nRepos: (c.extras.repos ?? []).length,
    teams: sorted(c.extras.teams ?? [], (t) => t.id).slice(0, 30).map((t) => ({ id: idText(t.id), members: (t.members ?? []).map((m) => who(m, policy)).sort(cmp), owns: (t.owns ?? []).map(idText).sort(cmp) })),
    hot: [...(c.extras.modules ?? [])].sort((a, b) => num(b.hotspot) - num(a.hotspot) || cmp(a.repo + a.path, b.repo + b.path)).slice(0, 10).map((m) => [idText(m.repo), idText(m.path), num(m.hotspot)]),
    open: sorted((c.extras.decisions ?? []).filter((d) => d.status === 'proposed'), (d) => d.id).slice(0, 20).map((d) => [idText(d.id), short(d.title ?? '')]),
  }),
  view: (d) => {
    const out = ['## Repositories', ''];
    if (d.repos.length === 0) out.push('Unknown: repositories');
    for (const r of d.repos) out.push(`### ${r.id}`, '', `Stack: ${r.stack.join(', ') || 'Unknown: stack'}.`, '', ...commandBlock(r.id, r.commands), '');
    if (d.nRepos > d.repos.length) out.push(`... ${d.nRepos - d.repos.length} more repositories`, '');
    out.push('## Owners', '', ...(d.teams.length ? mdTable(['Team', 'Members', 'Owns'], d.teams.map((t) => [t.id, t.members.join(', '), t.owns.join(', ')])) : ['Unknown: owners']), '');
    out.push('## Hotspots', '', ...(d.hot.length ? mdTable(['Repository', 'Path', 'Hotspot'], d.hot) : ['Unknown: hotspots (no history facts)']), '');
    out.push('## Open decisions', '', ...(d.open.length ? mdTable(['Decision', 'Title'], d.open) : ['None.']));
    return out;
  },
});
