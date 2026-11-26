# Embedded graph engines vs SQLite for plangraph query layer (research date 2026-11-26)

Tags: [verified: URL] = I fetched/ran it. [measured] = I ran it locally. [claimed/unverified] = from memory or secondary source.

## 0. Bottom line
Stay on SQLite as primary store. Add a thin in-memory adjacency layer (plain JS arrays/Map, optionally graphology) for BFS, shortest path, critical path. No engine switch is justified at 100k nodes / 500k edges. Every alternative either adds a native binary, is abandoned, or is a server.

## 1. Local measurements (node 24.18.0, node:sqlite, in-memory DB, macOS arm64) [measured]
Synthetic graph: 100k nodes, 500k edges, 4 relation types, avg out-degree 5, forward-local edges. Script: a one-off local script, not kept (one run; indicative, not a rigorous benchmark).

| Operation | Result |
|---|---|
| Bulk insert 100k nodes + 500k edges + 2 covering indexes | 547 ms |
| Recursive CTE, one relation (`blocks`), closure 69 nodes | 0.1 ms |
| Recursive CTE, all relations, full closure (97,899 nodes), `UNION` on id only | 130 ms |
| Reverse closure (97,734 nodes) | 141 ms |
| Recursive CTE carrying a depth column with `UNION`, shortest path 10 to 60000 | killed after about 55 s (min depth 45) |
| Load all 500k edges from SQLite into JS adjacency Map | 297 ms; heap about 197 MB, RSS about 398 MB |
| JS BFS full closure from memory | 21 ms |
| JS BFS shortest path (48 hops) | 20 ms |

Findings:
- Recursive CTEs are fast when the recursive row is just the node id. `UNION` dedups on the whole row, so SQLite visits each node once [verified: https://www.sqlite.org/lang_with.html].
- Adding a depth column to the row breaks dedup, since (id, depth) pairs are distinct. This gave a path-enumeration blowup: about 55 s versus 20 ms in JS. This is the real SQLite weakness: shortest path, longest path and critical path cannot be expressed as a deduplicated BFS in one CTE. You enumerate paths or hand-roll level-by-level SQL.
- Sparse typed filters are cheap, because a covering index (src, rel, dst) is used.
- Memory for a full in-memory graph is about 200 MB heap on 500k edges with naive arrays of boxed values. A typed-array CSR layout would be far smaller (about 4 MB for 500k edges of int32 pairs plus offsets) [claimed/unverified; arithmetic only].
- SQLite docs: BFS/DFS order is set by `ORDER BY` in the recursive select. Without it, order is undefined [verified: https://www.sqlite.org/lang_with.html].

## 2. Engine-by-engine

### SQLite + recursive CTE + JSON1 (current)
- Built into Node: `node:sqlite` is stability 1.2 "release candidate" as of v25.7.0 (added v22.5.0, no flag since v22.13/v23.4) [verified: https://nodejs.org/api/sqlite.html]. Zero install, zero native build, public-domain code, very stable file format [claimed/unverified: sqlite.org file-format guarantee through 2050].
- Extension loading is possible only with `allowExtension: true` in the constructor [verified: https://nodejs.org/api/sqlite.html]. Not needed.
- Weakness is shortest/critical path (above). Everything else is fine at this size.
- Concurrency: one writer, many readers (WAL) [claimed/unverified]. Fine for a CLI.

### DuckDB + DuckPGQ
- DuckDB Node client `@duckdb/node-api` 2.0.1-r.1 (updated 2026-11-20), MIT; native binaries ship as optional per-platform packages: linux x64/arm64 (glibc and musl), darwin x64/arm64, win32 x64/arm64 [verified: npm view @duckdb/node-api, @duckdb/node-bindings]. One platform binary is about 66 MB unpacked [verified: npm view @duckdb/node-bindings-darwin-arm64 dist.unpackedSize = 66,000,883].
- DuckPGQ: community extension from CWI, MIT, repo pushed 2026-11-26. It is a research project; "some features may still be under development". Compatibility matrix lists DuckDB 1.5.5, 1.5.6, 2.0.0, 2.0.1; from 2.0 you must opt in with `SET active_grammar_extensions = ['duckpgq']` [verified: https://duckdb.org/community_extensions/extensions/duckpgq]. Docs warn graph-algorithm functions may fail with a `csr_cte does not exist` error, and one DuckDB docs page says to use v1.4.4 [verified via search: https://duckdb.org/docs/1.4/guides/sql_features/graph_queries.html]. Docs pages conflict on version support.
- The extension is downloaded at runtime with `INSTALL duckpgq FROM community` (network needed on first use) [verified via search, same docs].
- Query language: SQL/PGQ (`MATCH`, `ANY SHORTEST`). Gives shortest path and CSR-based algorithms. DuckDB is columnar/OLAP and is optimized for scans and joins, not point lookups [claimed/unverified].
- Would it improve this case? Shortest path syntax, yes. Cost: 66 MB binary, runtime extension download, version-pinning risk, research-grade extension. Reject.

### Kuzu
- Verified: repo archived by owner on 2025-10-10, read-only; last release v0.11.3; README says team is "working on something new"; MIT [verified: https://github.com/kuzudb/kuzu]. npm `kuzu` 0.11.3 last modified 2025-10-10, unpacked size about 525 MB [verified: npm view kuzu].
- Apple acquisition: reported as agreed 2025-10-09 and disclosed in an EU filing, reported Feb 2026 [verified via search: https://macdailynews.com/2026/02/12/apple-acquires-graph-database-maker-kuzu, https://www.theregister.com/2025/10/14/kuzudb_abandoned/]. I did not open those articles.
- Forks: LadybugDB (github.com/LadybugDB/ladybug, MIT, pushed 2026-11-26, v0.23.0 on 2026-11-25, npm `@ladybugdb/core` 0.23.0, per-platform optional deps for linux x64/arm64, darwin x64/arm64, win32 x64) [verified: gh api, npm view]. Also RyuGraph [claimed/unverified: search result only]. Pre-1.0, young fork, third-party maintainer; Cypher-based; on-disk format stability is unknown [claimed/unverified].
- Verdict: do not adopt. Upstream is dead. Fork is promising but pre-1.0 with unknown format stability and a native binary.

### CozoDB (Datalog)
- MPL-2.0; Node package `cozo-node` 0.7.6 last published 2023-12-11; GitHub last push 2024-12-04; latest release v0.7.6 2023-12-11 [verified: npm view cozo-node, gh api repos/cozodb/cozo]. README: versions before 1.0 promise no syntax/API/storage compatibility [verified: https://github.com/cozodb/cozo].
- Native binaries for Linux x64/arm64, macOS arm64/x64, Windows x64; backends in-memory, SQLite, RocksDB [verified: same README]. It has built-in shortest path and PageRank-style algorithms, and recursion is natural in Datalog.
- Verdict: effectively unmaintained for about 2 years. Reject.

### Oxigraph / RDF / SPARQL
- npm `oxigraph` 0.5.13 (2026-10-22), MIT OR Apache-2.0, WASM package (about 8.8 MB unpacked), so no native build [verified: npm view oxigraph; https://github.com/oxigraph/oxigraph]. Active.
- README says SPARQL evaluation "has not been optimized yet" [verified: https://github.com/oxigraph/oxigraph]. Property paths give reachability, but typed relations as RDF predicates plus relation-filtered path queries are clunky, and there is no shortest path in standard SPARQL [claimed/unverified].
- LLM evidence is poor for SPARQL: below 4% zero-shot in SM3-Text-to-Query write-up [claimed/unverified: secondary source https://towardsdatascience.com/can-llms-talk-sql-sparql-cypher-and-mongodb-query-language-mql-equally-well-a478f64cc769/; I could not confirm numbers in the paper abstract https://arxiv.org/abs/2411.05521].
- Verdict: reject. Works without a native build, but adds a worse language and a data-model rewrite.

### TypeDB
- Server repo is MPL-2.0 (driver is Apache-2.0); it ships as a server with drivers (typedb-driver npm 2.29.7, 2026-08-03) [verified: https://github.com/typedb/typedb, npm view typedb-driver]. Not embeddable in-process from the pages I read (the page does not say explicitly). TypeQL is strongly typed. Server process plus JVM-free Rust binary [claimed/unverified]. Reject: server.

### SQLite graph extensions
- agentflare-ai/sqlite-graph: MIT, 290 stars, last push 2025-12-12 [verified: gh api]. Native loadable extension, so it needs per-platform builds, plus `allowExtension`. Alpha-quality, low adoption [claimed/unverified]. No evidence of better traversal than a CTE. Reject. (Other options, such as sqlite-graph from other authors or simple_graph, were not evaluated.)

### In-memory JS graph libs (graphology, plain CSR)
- graphology 0.26.0 (2025-01-26), MIT, pure JS, repo pushed 2026-11-10; standard library has shortest-path (Dijkstra, unweighted BFS), traversal, DAG utilities as separate packages [verified: npm view graphology, gh api; feature list claimed/unverified]. Zero native deps, so no install risk.
- Cost: the 500k-edge graph build from SQLite took about 300 ms plus about 200 MB heap with plain Maps [measured]. graphology's per-node/edge object overhead is likely higher, so a hand-rolled CSR built from `SELECT src,dst,rel` is leaner [claimed/unverified]. Cache invalidation: rebuild when the SQLite source hash changes.
- Benefit: BFS/shortest path in about 20 ms [measured] versus an unbounded CTE blowup. Also gives topological sort and longest-path DP trivially.

### Neo4j / Memgraph (baselines)
- Both are servers (Bolt protocol). Neo4j Community is GPLv3; Memgraph is BSL / enterprise tiers [claimed/unverified: not fetched]. Violates "no server" constraint. Reject. Not benchmarked.

## 3. Does a graph language or Datalog help LLM agents?
No direct, controlled evidence found that Cypher or Datalog beats SQL for agents on equivalent questions. What exists points the other way:
- SM3-Text-to-Query (NeurIPS 2024 benchmark): SQL is strongest of SQL/Cypher/SPARQL/MongoDB; about 40% zero-shot for large models; SPARQL below 4% [claimed/unverified: secondary summary at towardsdatascience link above].
- CypherBench (ACL 2025): GPT-4o 60.18%, Claude 3.5 Sonnet 61.58% execution accuracy; no model under 10B above 20%. The paper does not compare with SQL on the same data [verified: https://arxiv.org/html/2412.18702v2].
- Text2GQL-Bench (arXiv 2602.11745): strong LLMs at or below 4% zero-shot on ISO-GQL; 3-shot about 50% [claimed/unverified: from search snippet only].
- DatalogBench (arXiv 2609.37233, v1 2026-09-29, v2 2026-11-18): 136 tasks, six LLMs, exact match peaks 75.7% from direct prompting; two coding agents reach up to 86.8%; most direct-prompt failures are compile errors (undeclared helper predicates); remaining agent errors concentrate in recursive tasks [verified: https://arxiv.org/abs/2609.37233]. It does not compare with SQL. The agent gain came from compile-and-retry loops, which any language with good error messages would get.
- Implication: the effective lever is not the language. It is giving the agent a closed vocabulary: pre-built commands/views with parameters (blockers, path, impact) and a schema listing, so the agent rarely writes raw queries. Raw SQL stays a fallback, with a read-only connection.

## 4. Deciding numbers
- 500k edges, 100k nodes: SQLite full closure 130 ms, in-memory BFS 21 ms, edge load 300 ms [measured]. Both are well under a CLI latency budget. The cost of the engine switch (66 MB to 525 MB native binaries, per-OS builds, pre-1.0 formats, one dead upstream) buys nothing the in-memory layer does not.
- Only failure found: path enumeration with a depth column (55 s+). Fixed by doing BFS/shortest/critical path in JS, not in a CTE.
- Rule of thumb: keep recursive CTEs for single-relation or id-only closure, where they dedup (0.1 ms to 130 ms). Route anything needing depth, shortest path, longest path or critical path to the JS layer built from `select src,dst,rel from edges`.

## 5. Recommendation
1. Keep SQLite (`node:sqlite`) as the query/index store. Zero-install on Node 24 is the deciding property.
2. Add an in-memory graph layer, lazily built per command from SQLite and keyed on the source hash. Use CSR typed arrays or graphology. Implement relation-filtered BFS, shortest path, topological order and critical path (longest path DP on the blocks DAG) there.
3. Token-bounded output is a rendering concern (depth cap, node cap, summary counts), independent of engine.
4. Revisit only if: graph exceeds about 1M edges, or LadybugDB hits 1.0 with a documented format guarantee, or DuckPGQ leaves "research project" status. None applies today.

## Caveats
Benchmark is synthetic, single run, one machine, random-local edge distribution, in-memory SQLite (a file DB adds page-cache cost). Neo4j/Memgraph licenses and sqlite file-format guarantee not fetched. Cozo and DuckPGQ were not benchmarked.
