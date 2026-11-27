// The bundled MCP server is opt-in. Three variables can switch it on and only the value `on` does: PLANGRAPH_MCP_OPTION (the plugin option, which
// .mcp.json passes under its own name), CLAUDE_PLUGIN_OPTION_MCP (the name Claude Code exports) and PLANGRAPH_MCP (a shell variable, which the
// plugin's .mcp.json must not override). Found by running the real plugin: a shell PLANGRAPH_MCP=on was replaced by the unset option.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer } from '../src/mcp.ts';

const INIT = { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-11-25' } };
const reply = async (env: Record<string, string | undefined>, cwd: string): Promise<{ result?: unknown; error?: { message: string } }> => {
  const s = createServer({ env, cwd, run: async () => 0 });
  return (await s.handle(new TextEncoder().encode(JSON.stringify(INIT)))) as { result?: unknown; error?: { message: string } };
};

test('each of the three variables switches the server on, and no other value does', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'plangraph-mcpopt-'));
  fs.mkdirSync(path.join(dir, '.plangraph'));
  try {
    for (const name of ['PLANGRAPH_MCP_OPTION', 'CLAUDE_PLUGIN_OPTION_MCP', 'PLANGRAPH_MCP']) {
      assert.ok((await reply({ [name]: 'on' }, dir)).result, `${name}=on serves`);
      assert.ok((await reply({ [name]: ' ON ' }, dir)).result, `${name} is trimmed and case-insensitive`);
      for (const v of ['', 'off', 'auto', 'true', '1']) assert.match((await reply({ [name]: v }, dir)).error?.message ?? '', /disabled/, `${name}=${JSON.stringify(v)}`);
    }
    assert.match((await reply({}, dir)).error?.message ?? '', /disabled/, 'nothing set');
    assert.ok((await reply({ PLANGRAPH_MCP_OPTION: 'off', PLANGRAPH_MCP: 'on' }, dir)).result, 'an unset or off plugin option does not cancel the shell variable');
    assert.ok((await reply({ PLANGRAPH_MCP_OPTION: '', CLAUDE_PLUGIN_OPTION_MCP: 'on' }, dir)).result, 'any one of them is enough');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('.mcp.json passes the plugin option under its own name and does not set PLANGRAPH_MCP', () => {
  const s = JSON.parse(fs.readFileSync(path.join(import.meta.dirname, '..', '.mcp.json'), 'utf8')).mcpServers.plangraph;
  assert.deepEqual(s.env, { PLANGRAPH_MCP_OPTION: '${user_config.mcp}' });
});
