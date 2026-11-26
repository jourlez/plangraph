# Agent memory, local-first sync, and fact logs: fit for a git-shared project graph

Date of research: 2026-11-26. Tags: [verified: URL] = read in this session; [claimed/unverified] = search snippet, vendor claim, or memory.

## Bottom line

Do not move to a memory-system backend. Keep committed files. Steal the data-model ideas (validity intervals, provenance, invalidate-not-delete, stable IDs, append-only facts). The runtime machinery (LLM extraction, vector index, graph server) is the part that needs a server and an LLM on every write, and it fits a deterministic, reviewable, git-shared graph badly.

## 1. Agent memory and temporal KG systems

| System | Storage required | Update model |
|---|---|---|
| Graphiti/Zep | Neo4j 5.26, FalkorDB 1.1.2, or Neptune + OpenSearch; an embedded option is listed [verified: https://github.com/getzep/graphiti] | LLM-extracted facts. Works best with Structured Output LLMs; smaller models cause ingest failures [verified: https://github.com/getzep/graphiti] |
| Mem0 | Vector DB; Mem0g adds Neo4j [verified: https://arxiv.org/html/2504.19413] | LLM picks ADD/UPDATE/DELETE/NOOP per fact [verified: https://arxiv.org/html/2504.19413] |
| Cognee | Defaults SQLite + LanceDB + Ladybug, no server; default needs an OpenAI key or local Ollama [verified: https://docs.cognee.ai/getting-started/installation] | LLM extraction pipelines [claimed/unverified: architecture page did not state it] |
| Letta/MemGPT | Blocks persisted individually in a DB, compiled into the context window each call [verified: https://www.letta.com/blog/memory-blocks] | The agent edits blocks through tools (e.g. a rethink_memory tool); no benchmark in the post [verified: same URL] |
| MCP memory server | One JSONL file (`memory.jsonl`), whole graph rewritten atomically per write, lock file for multi-process; entities, relations, observations as strings [verified: https://raw.githubusercontent.com/modelcontextprotocol/servers/main/src/memory/README.md] | Deterministic tool calls by the agent. Deletes are real deletes; no timestamps or provenance in the described schema [verified: same URL] |
| LightRAG | Defaults: JSON KV, NanoVectorDB, NetworkX files, "for testing and evaluation, not production". Production: Postgres recommended [verified: https://github.com/HKUDS/LightRAG] | LLM extraction on every chunk; needs stronger LLMs than plain RAG; deletion rebuilds affected entities [verified: same URL] |
| GraphRAG | [claimed/unverified: parquet outputs plus LLM community summaries; not fetched] | LLM indexing |

### Graphiti/Zep temporal model (the part worth copying)
- Two timelines. T is when a fact held true in the world. T' is when the system ingested it (audit time) [verified: https://arxiv.org/html/2501.13956].
- Invalidation: an LLM compares a new edge with related existing edges. If they contradict and overlap in time, the older edge's end time is set to the new edge's start. The old edge is kept [verified: https://arxiv.org/html/2501.13956].
- Provenance: every entity and relationship traces back to the episodes that produced it [verified: https://github.com/getzep/graphiti].
- Entity resolution: embedding (1024-d) cosine match plus full-text candidates, then an LLM decides duplicates [verified: https://arxiv.org/html/2501.13956]. This needs an embedding model, an LLM and a search index. It is not deterministic.
- Graph construction uses predefined Cypher, not LLM-written queries [verified: https://arxiv.org/html/2501.13956].

### Reported results
- Zep, LongMemEval: gpt-4o 71.2% at 2.58 s with 1.6k context tokens, versus full-context 60.2% at 28.9 s with 115k tokens. gpt-4o-mini: 63.8% vs 55.4% [verified: https://arxiv.org/html/2501.13956]. DMR: Zep 94.8% vs MemGPT 93.4% (gpt-4-turbo); full conversation scored 94.4% [verified: same URL]. Note that on DMR the full-context baseline is almost as good. Authors are the vendor.
- Mem0 paper, LOCOMO LLM-judge: full-context 72.90%, Mem0g 68.44%, Mem0 66.88%, Zep 65.99%, OpenAI memory 52.90%. p95 latency 1.440 s for Mem0 vs 17.117 s for full-context. More than 90% token saving [verified: https://arxiv.org/html/2504.19413]. Mem0 footprint about 7k tokens per conversation, Mem0g about 14k, Zep over 600k [verified: same URL]. Mem0 is the vendor, and it is the one that ranks Zep lowest. A vendor dispute over these numbers exists [claimed/unverified].
- Reading: memory systems win on latency and tokens versus stuffing everything in context. Full-context still wins on accuracy in the Mem0 benchmark. For a project graph that is small and structured, the retrieval win comes from a compact, queryable index, not from LLM-built memory.

### What to take, what needs a server
- Take (no server): validity interval on facts; invalidate instead of delete; provenance (source id on each fact); stable entity IDs; observations as separate atomic facts (MCP memory model).
- Needs a server or an LLM: fuzzy entity resolution (embeddings + LLM), semantic edge-contradiction detection, vector search, community summaries. Make these optional, offline, advisory tools. Never in the write path.

## 2. Local-first sync and CRDTs

Question: does any give conflict-free merge for a graph of records shared through git without a sync server?

- Automerge: binary columnar change-history format; v3 kept the v2 file format and cut memory over 10x [verified: https://automerge.org/blog/automerge-3/]. Sync in git works only by committing a binary blob. Git cannot merge it; a custom merge driver is needed. Diffs are unreadable.
- Loro: 1.0 stabilised the format. Export modes: updates, snapshot, shallow snapshot. Shallow snapshot drops old history and rejects concurrent updates older than the start [claimed/unverified: search summary of https://www.loro.dev/changelog/v1.0.0-beta].
- Yjs: binary updates that are commutative and idempotent; tombstones with GC; persistence providers are databases or S3, and production users exist [verified: https://github.com/yjs/yjs]. Same git problem: a binary blob.
- cr-sqlite: history-free CRDT inside SQLite; per-column LWW/counter rules; sync through the `crsql_changes` table. Event-log mode is only planned for v2; releases not visible in the capture [verified: https://github.com/vlcn-io/cr-sqlite]. A SQLite file is binary in git; it would need an export.
- ElectricSQL and PowerSync: both need a running sync service in front of a server database (Postgres for Electric; Postgres, MongoDB, MySQL or SQL Server for PowerSync) [verified: search summary, https://powersync.com/blog/electricsql-vs-powersync; treat as claimed].
- Jazz: runs inside a backend with a `/jazz` route, SQLite store; Swift and Kotlin clients are experimental [verified: https://jazz.tools/docs]. The docs page does not describe the on-disk format.
- Verdict: none gives a text format that git merges by itself. CRDT libraries give strong merge, but the file is an opaque binary. Sync engines need a server. The CRDT idea that does transfer is: operations that are commutative and idempotent, with unique IDs. An append-only log of immutable records with unique IDs has these properties, in text.

## 3. Event sourcing and fact logs

- Datomic: a database is a set of immutable datoms (entity, attribute, value, transaction, assert/retract). A retraction is a datom, not a deletion. Excision is the one exception, for compliance or PII [verified via search summary: https://docs.datomic.com/whatis/data-model.html].
- XTDB 2: bitemporal (system time and valid time), columnar files in object storage, SQL. 2.x is early access, 1.x is stable [claimed/unverified: https://docs.xtdb.com/intro/what-is-xtdb]. Needs a running node and object store.
- Beads (agent issue tracker): hash-based IDs like `bd-a1b2` prevent merge collisions in multi-agent and multi-branch work. Its JSONL file is only an export; the source of truth is Dolt, with cell-level merge and sync via a git remote ref [verified: https://github.com/steveyegge/beads]. This is a direct data point: a git-adjacent agent tool tried JSONL in git and moved to a versioned SQL engine, which adds a binary dependency. [The reason for the move is not stated on the page.]
- Git merge behavior for a JSONL append log: git's built-in `merge=union` driver keeps lines from both sides with no conflict markers; line order may be arbitrary and the manual warns to verify [verified: https://git-scm.com/docs/gitattributes]. Custom merge drivers can be configured per path, but the driver is defined in git config, not in `.gitattributes`, so it is not committed. A plugin must install it.
- Fit for git:
  - Append-only lines with unique IDs merge cleanly under union, because two branches never edit the same line.
  - Invalidation is a new line (a tombstone or end-time record), so there is no in-place edit and no conflict.
  - Weak points: two branches that each invalidate the same fact with different reasons (resolve by "latest by id/time wins" at read time); edits of one fact on both sides (resolve by folding in order); log growth (needs compaction).
- Compaction: fold the log into a snapshot at a checkpoint, commit the snapshot, rotate old segments. Keep the rule that folding is deterministic and sorted by ID. Compaction itself creates conflicts if two people compact at once; do it in one place (a release or CI step), or write segments per author/session so files never collide. [Design inference; no source.]

## 4. What storage format agents handle best

- Anthropic, long-running agents post (2025-11-26): feature list is JSON because "the model is less likely to inappropriately change or overwrite JSON files compared to Markdown files" [verified: https://www.anthropic.com/engineering/effective-harnesses-for-long-running-agents]. The point is structured, rigidly-shaped state that the agent updates field by field.
- Aider benchmarks (2023-2024, GPT-era): putting source code inside JSON or function-call edits scored worse than plain text edit formats, due to quoting and escaping [verified via search summary: https://aider.chat/2024/08/14/code-in-json.html]. Authors said they would re-test on newer models; no recent result found. Caveat: this is about code inside JSON, not short structured records. Plangraph records are short fields, so the escaping problem is small.
- No source found comparing YAML vs JSON vs SQL for agent writes on recent models [claimed/unverified gap].
- Practical reading: agents are reliable at (a) appending a whole new JSON line, (b) running a CLI that validates and writes. They are least reliable at hand-editing the middle of a large file. So the agent should write through a tool/command that validates and appends, not edit the file.

## Ranked: 5 designs to adopt

1. Append-only JSONL fact log, one immutable record per line, unique collision-resistant ID per record (hash/ULID style, as Beads does), `merge=union` set at plugin install. Reason: git merges it without conflict, agents write whole new lines reliably, history is the audit trail.
2. Invalidate, never delete: a later record sets `invalid_at` / `superseded_by` with a reason. Fold at read time. Reason: Graphiti, Mem0g and Datomic all do it; it avoids edit conflicts; it keeps provenance.
3. Per-record provenance: `source` (agent/session/ticket/commit), `author`, `recorded_at`, and a separate `valid_from/valid_to` for the fact itself. Reason: Graphiti's T/T' split; cheap, deterministic, no server.
4. All writes through one validating CLI/tool (schema check, ID assignment, atomic append), with a derived index (SQLite or in-memory, gitignored) rebuilt from the log. Reason: Anthropic's JSON choice and agents' weakness at free-form edits; the index gives fast queries without committing a binary.
5. Deterministic entity resolution: canonical IDs plus alias records written explicitly (an `alias_of` fact), with a `doctor` command proposing merges by name similarity. Reason: gives the useful part of Graphiti's resolution with no embeddings or LLM in the write path.

## 3 designs to reject

1. A graph DB or vector DB server (Neo4j, FalkorDB, Postgres, Dolt server) as source of truth. Reason: server/binary dependency, not diffable or reviewable in PRs; Beads' move to Dolt shows the cost.
2. LLM-extracted facts in the write path (Mem0 ADD/UPDATE/DELETE, Graphiti ingest, LightRAG extraction). Reason: non-deterministic, cost on every write, schema-failure risk on small models [verified: https://github.com/getzep/graphiti]; two teammates' agents would extract different graphs from the same events; vendor accuracy numbers are self-reported and disputed.
3. CRDT binary documents (Automerge/Loro/Yjs) or sync engines (Electric, PowerSync, Jazz) as the store. Reason: opaque binary in git, a custom merge driver the team must install, history growth; sync engines need a server. Their only transferable idea (commutative, idempotent ops with unique IDs) is already captured by design 1.

## Gaps
- Could not read PDF tables; numbers come from arXiv HTML pages.
- No primary source on GraphRAG storage, Letta's database, or a recent JSON-vs-YAML agent write benchmark.
- Whether plangraph's current files already have IDs and timestamps was not checked here.
