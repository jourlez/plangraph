// Template for the Claude Code Workflow tool (needs the owner's explicit opt-in). Run `brain units --stale ... --out DIR` first.
// Replace DIR and the list of unit ids; the briefs live in the plugin (briefs/auditor.md, reverify.md).
// Cost preview: units x about 130,000 tokens (measured on a large project). To redo failed units, start a NEW run with just those ids:
// resuming reruns every call after the first failure.
export const meta = {
  name: 'brain-audit',
  description: 'Adversarially audit tickets prepared by `brain units`, then re-verify every non-READY or caveated verdict',
  phases: [{ title: 'Audit' }, { title: 'Reverify' }],
}
const DIR = '/ABSOLUTE/PATH/TO/UNITS'            // the --out folder of `brain units`
const BRIEF = '/ABSOLUTE/PATH/TO/open-brain/briefs'
const units = ['u001', 'u002']                   // ids from DIR/units.json
const AUDIT = { type: 'object', properties: { unit: { type: 'string' }, ready: { type: 'integer' }, blocked: { type: 'integer' }, external: { type: 'integer' }, unsure: { type: 'integer' }, needs_recheck: { type: 'integer' } }, required: ['unit', 'ready', 'blocked', 'external', 'unsure', 'needs_recheck'] }
const RV = { type: 'object', properties: { unit: { type: 'string' }, rechecked: { type: 'integer' }, confirmed_block: { type: 'integer' }, block_refuted: { type: 'integer' } }, required: ['unit', 'rechecked', 'confirmed_block', 'block_refuted'] }
phase('Audit')
const results = await pipeline(
  units,
  (u) => agent(`Read ${BRIEF}/auditor.md and follow it for unit ${u}; DIR is ${DIR}. Return the counts in the schema.`, { label: `audit ${u}`, phase: 'Audit', schema: AUDIT }),
  (a, u) => (a && (a.blocked || a.external || a.unsure || a.needs_recheck))
    ? agent(`Read ${BRIEF}/reverify.md and follow it for unit ${u}; DIR is ${DIR}. Return the counts in the schema.`, { label: `reverify ${u}`, phase: 'Reverify', schema: RV })
    : null,
)
return { units: units.length, completed: results.filter(Boolean).length }
