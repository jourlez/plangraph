// Structural validation against the documented Claude Code plugin layout (no live session needed). Exit 1 on any problem.
import fs from "node:fs";
import path from "node:path";
const root = path.resolve(new URL("..", import.meta.url).pathname);
const bad = [];
const must = (c, m) => { if (!c) bad.push(m); };
const man = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin/plugin.json"), "utf8"));
must(/^[a-z][a-z0-9-]*$/.test(man.name), "plugin name must be kebab-case");
const mk = JSON.parse(fs.readFileSync(path.join(root, ".claude-plugin/marketplace.json"), "utf8"));
must(Array.isArray(mk.plugins) && mk.plugins.length > 0, "marketplace lists no plugin");
for (const p of mk.plugins) { const src = path.resolve(root, p.source || "."); must(fs.existsSync(path.join(src, ".claude-plugin/plugin.json")), `marketplace source ${p.source} has no plugin.json`); must(p.name === man.name, "marketplace plugin name differs from the manifest"); }
// skills: SKILL.md with frontmatter, description within the documented 1,536-character listing limit, body under 500 lines
for (const d of fs.readdirSync(path.join(root, "skills"))) {
  const f = path.join(root, "skills", d, "SKILL.md"); must(fs.existsSync(f), `skills/${d} has no SKILL.md`); if (!fs.existsSync(f)) continue;
  const t = fs.readFileSync(f, "utf8"); const m = /^---\n([\s\S]*?)\n---\n/.exec(t); must(!!m, `skills/${d}: no frontmatter`);
  const desc = (/^description:\s*(.+)$/m.exec(m?.[1] || "") || [])[1] || ""; must(desc.length > 20 && desc.length <= 1536, `skills/${d}: description length ${desc.length}`);
  must(t.split("\n").length < 500, `skills/${d}: over 500 lines`);
}
// hooks: top-level "hooks", commands point inside the plugin root and exist
const hk = JSON.parse(fs.readFileSync(path.join(root, "hooks/hooks.json"), "utf8")); must(!!hk.hooks, "hooks.json needs a top-level hooks key");
for (const [ev, arr] of Object.entries(hk.hooks || {})) for (const g of arr) for (const h of g.hooks || []) {
  // exec form: `node` plus args[0] inside the plugin root (no dependence on the exec bit surviving the plugin cache copy)
  const exec = h.command === "node" && typeof h.args?.[0] === "string"; const c = String(exec ? h.args[0] : h.command || "");
  must(c.startsWith("${CLAUDE_PLUGIN_ROOT}/"), `${ev}: command must start with CLAUDE_PLUGIN_ROOT`);
  const f = path.join(root, c.replace("${CLAUDE_PLUGIN_ROOT}/", "")); must(fs.existsSync(f), `${ev}: ${c} does not exist`); if (fs.existsSync(f) && !exec) must((fs.statSync(f).mode & 0o111) !== 0, `${ev}: ${c} is not executable`);
}
for (const f of fs.readdirSync(path.join(root, "bin")).filter((n) => !/\.(lock|txt)$/.test(n))) must((fs.statSync(path.join(root, "bin", f)).mode & 0o111) !== 0, `bin/${f} is not executable`);
console.log(bad.length ? "PROBLEMS:\n- " + bad.join("\n- ") : `plugin layout valid: manifest ${man.name}@${man.version}, ${fs.readdirSync(path.join(root, "skills")).length} skills, ${Object.keys(hk.hooks).length} hook event(s), ${fs.readdirSync(path.join(root, "bin")).filter((n) => (fs.statSync(path.join(root, "bin", n)).mode & 0o111) !== 0 && fs.statSync(path.join(root, "bin", n)).isFile()).length} bin command(s)`);
process.exit(bad.length ? 1 : 0);
