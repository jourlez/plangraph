// In-process CLI runs for the stratified CLI properties: a throwaway repository (mkdtemp, a `.git` directory, `.plangraph/*.jsonl`) and
// src/cli.ts main() with a captured io, which is the whole CLI except the bin/brain Node-floor shim (spawned separately on a few cases).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../src/cli.ts';

const line = (o: object): string => JSON.stringify(o);
export function makeRepo(base: string, files: Record<string, string | object[]>): string {
  const root = fs.mkdtempSync(path.join(base, 'r-'));
  fs.mkdirSync(path.join(root, '.git'));
  const dir = path.join(root, '.plangraph');
  fs.mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), Array.isArray(content) ? content.map(line).join('\n') + (content.length ? '\n' : '') : content);
  return root;
}
export async function run(root: string, argv: string[]): Promise<{ code: number; out: string; err: string }> {
  const out: string[] = [], err: string[] = [];
  const code = await main(argv, { io: { out: (s: string) => out.push(s), err: (s: string) => err.push(s) }, env: { PATH: process.env.PATH, HOME: root, SOURCE_DATE_EPOCH: '1' }, cwd: root });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
export const tmpBase = (): string => fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-assure-'));
export const rmBase = (b: string): void => fs.rmSync(b, { recursive: true, force: true });
