// The version and CHANGELOG rules of the release flow, shared by test/packaging.test.ts and its unit cases.
export const versionOk = (v: string): boolean => /^\d+\.\d+\.\d+(-dev)?$/.test(v);

/** A -dev version needs `## [Unreleased]` above the first `## 0.` heading; a release needs its own entry. */
export function changelogOk(v: string, c: string): boolean {
  if (!v.endsWith('-dev')) return c.includes(`## [${v}] - `) || c.includes(`## ${v}`);
  const m = /^## \[Unreleased\]\s*$/m.exec(c);
  const first = /^## 0\./m.exec(c);
  return m !== null && (first === null || m.index < first.index);
}
