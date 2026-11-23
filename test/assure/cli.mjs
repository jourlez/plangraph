// In-process CLI runs for the stratified CLI properties: a throwaway repository (mkdtemp, a `.git` directory, `.brain/*.jsonl`) and
// src/cli.mjs main() with a captured io, which is the whole CLI except the bin/brain Node-floor shim (spawned separately on a few cases).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../../src/cli.mjs';

const line = (o) => JSON.stringify(o);
export function makeRepo(base, files) {
  const root = fs.mkdtempSync(path.join(base, 'r-'));
  fs.mkdirSync(path.join(root, '.git'));
  const dir = path.join(root, '.brain');
  fs.mkdirSync(dir);
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), Array.isArray(content) ? content.map(line).join('\n') + (content.length ? '\n' : '') : content);
  return root;
}
export async function run(root, argv) {
  const out = [], err = [];
  const code = await main(argv, { io: { out: (s) => out.push(s), err: (s) => err.push(s) }, env: { PATH: process.env.PATH, HOME: root, SOURCE_DATE_EPOCH: '1' }, cwd: root });
  return { code, out: out.join('\n'), err: err.join('\n') };
}
export const tmpBase = () => fs.mkdtempSync(path.join(os.tmpdir(), 'brain-assure-'));
export const rmBase = (b) => fs.rmSync(b, { recursive: true, force: true });
