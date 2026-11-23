// expect: TS2322
// Negative-type fixture for the MCP server (src/mcp.ts). Never run, only type-checked by test/types.test.ts.
import { createServer } from '../../src/mcp.ts';

// TS2322: the working directory is a string
export const badCwd = createServer({ cwd: 5 });
