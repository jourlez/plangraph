// Fixed synthetic plan for the graph answer-format benchmark. Pure data, no randomness: same bytes every run.
export type Ticket = { key: string; owner: string; sprint: string; epic: string; deps: string[] };

export const PEOPLE = ['Ana', 'Ben', 'Cy', 'Dee'];
export const SPRINTS = ['S1', 'S2', 'S3', 'S4', 'S5'];
const EPICS = ['E-A', 'E-B', 'E-C'];
const N = 30;

export const TICKETS: Ticket[] = Array.from({ length: N }, (_, k) => {
  const i = k + 1;
  const deps: string[] = [];
  if (i > 2) deps.push(`T-${i - 2}`);
  if (i > 5) deps.push(`T-${i - 5}`);
  return { key: `T-${i}`, owner: PEOPLE[i % PEOPLE.length] as string, sprint: SPRINTS[Math.floor(k / 6)] as string, epic: EPICS[i % EPICS.length] as string, deps };
});
