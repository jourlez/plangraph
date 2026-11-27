// The fence for untrusted lines, copied in minimal form from src/commands/shared.ts (fenceLines, fenceBlock) so lib/flow does not import from src/.
// Same output bytes: the nonce is derived from the body, every line should come from oneLine first.
import crypto from 'node:crypto';
import { fence } from '../sanitize.ts';

function fenceLines(src: string, lines: readonly string[]): string {
  const body = lines.join('\n');
  return fence(src, body, { src, nonce: crypto.createHash('sha256').update(body).digest('hex').slice(0, 8), max: body.length + 16 });
}
export const fenceBlock = (src: string, lines: readonly string[]): string[] => fenceLines(src, lines).split('\n');
