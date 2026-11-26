// In-memory FsLike for the document tests.
import type { FsLike } from '../../lib/docs/registry.ts';

export const memfs = (): FsLike & { files: Map<string, string> } => {
  const files = new Map<string, string>();
  return { files, read: (p) => files.get(p) as string, write: (p, t) => void files.set(p, t), exists: (p) => files.has(p), mkdirp: () => {} };
};
