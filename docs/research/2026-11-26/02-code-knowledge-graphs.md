# Representing a codebase/project for AI agents: state of the art (as of 2026-11-26)

Tag key: [verified: URL] = read in a fetched primary page/abstract. [claimed/unverified] = from search snippets, memory, or inference.

## 1. Comparison of approaches

**Aider repo map.** Tree-sitter parses files, finds definitions and references. Files are graph nodes, edges link files with dependencies. A ranking algorithm picks most-referenced identifiers. Budget `--map-tokens`, default 1k. [verified: https://aider.chat/2023/10/22/repomap.html (2023)] That page says nothing on caching or incremental update. PageRank use is [claimed/unverified] (cgraphy README mentions PageRank-style ranking, not Aider's page). No measured accuracy benefit on that page.

**SCIP / LSIF / LSP.** SCIP: language-agnostic Protobuf indexing protocol for go-to-definition, find-references, find-implementations; indexers for Java/Scala/Kotlin, TS/JS, Rust, C/C++, Ruby, Python, C#, Dart, PHP. [verified: https://github.com/sourcegraph/scip] SCIP beats LSIF: ~4x smaller gzipped, ~5x uncompressed, readable string symbol IDs; incremental indexing was "anticipated", not shipped, at post time. [verified: https://sourcegraph.com/blog/announcing-scip] Data model detail (documents/occurrences/symbols) [claimed/unverified]. Compiler-grade precision, but needs a build/type environment per language; LSP is live per-query, no persisted graph [claimed/unverified].

**Tree-sitter code graphs.** Syntactic, fast, 66+ languages, heuristic call resolution (no type resolution) [claimed/unverified]. See MCP servers below. CodeGraphContext can swap in SCIP indexers for C/C++ and C# instead of tree-sitter heuristics. [verified: https://github.com/CodeGraphContext/CodeGraphContext]

**Microsoft GraphRAG.** LLM extracts entities, relationships, claims from text units; Leiden hierarchical clustering; bottom-up community summaries; local, global, DRIFT, basic search. [verified: https://microsoft.github.io/graphrag/] Page gives no cost or incremental-update info. It targets prose corpora; LLM extraction per chunk is expensive and non-deterministic [claimed/unverified]. For code, deterministic parsers replace the LLM extraction step; code-specific graph-RAG: RepoGraph, CodexGraph, RANGER, KGCompass (see section 4).

**Sourcegraph / Cody.** Code graph (definitions, references, symbols, doc comments) feeds context retrieval; embeddings were "preferred", keyword search fallback; embeddings later limited to Free/Pro VS Code from 5.3, dropped for Enterprise. [verified via search snippets: https://sourcegraph.com/docs/cody/core-concepts/embeddings ; https://sourcegraph.com/docs/cody/core-concepts/code-graph] [claimed/unverified for current state; vendor docs, versioned]. Cody paper on context retrieval: https://arxiv.org/pdf/2408.05344 (not read).

**Cursor-style embeddings.** Merkle tree of file/folder hashes finds changed files (50k files ~3.2 MB of names+SHA-256); changed files split into syntactic chunks, embedded async, embeddings cached by chunk content; similar-index reuse via simhash cuts median time-to-first-query 7.87 s to 525 ms. [verified: https://cursor.com/blog/secure-codebase-indexing] Cursor docs now also describe a local "Instant Grep" index with no upload. [verified: https://cursor.com/docs/context/codebase-indexing] Cursor publishes no accuracy benchmark in these pages.

**Repomix / gitingest packing.** Whole repo into one XML/MD/JSON/text file; per-file and total token counts (default `o200k_base`); `--compress` uses tree-sitter to keep signatures, drops bodies (experimental); `--token-budget` fails CI when exceeded; respects .gitignore; Secretlint. [verified: https://github.com/yamadashy/repomix] No incrementality; cost = whole repo tokens, so scales linearly. gitingest: [claimed/unverified], same idea.

**Code-graph MCP servers (open source, current).**
- codebase-memory-mcp (DeusData, MIT): SQLite graph. Nodes: Function, Module, File, Folder, Project, Package, Route, Process, Resource, Image, Chart, EnvVar, ADR/doc sections. Edges: CALLS, IMPORTS, DEFINES, IMPLEMENTS, INHERITS, HTTP_CALLS, ASYNC_CALLS, EMITS, DEPLOYS, DEPENDS_ON, CONFIGURES, SIMILAR_TO, cross-repo. Background git watcher re-index; 17 tools incl. `search_graph`, `trace_path`, `get_architecture`, `detect_changes`, `manage_adr`; optional committed `.codebase-memory/graph.db.zst` team snapshot. [verified: https://github.com/DeusData/codebase-memory-mcp]
- CodeGraphContext (MIT): files, symbols, calls, inheritance, imports; FalkorDB Lite / KuzuDB / Neo4j backends; `cgc watch`; callers, complexity, dead-code analysis. [verified: https://github.com/CodeGraphContext/CodeGraphContext]
- CodeCompass: MCP server exposing dependency graphs (FastAPI repo study). [verified: https://arxiv.org/abs/2602.20048]
- Also seen, not read: brandyn-s/code-graph (SQLite, flags stale evidence when tree changed), @sdsrs/code-graph-mcp (call graph, HTTP route tracing), cgraphy (PageRank), knot, symgraph (Rust). [claimed/unverified: search snippets]
Pattern: all model code symbols first; only codebase-memory-mcp also models infra/deploy/ADR. None models owners, teams, or planning data [claimed/unverified, from what was read].

**Backstage catalog.** Kinds: Component, Template, API, Group, User, Resource, System, Domain, Location. Relations (from spec fields): ownedBy/ownerOf, partOf/hasPart, dependsOn/dependencyOf, providesApi/apiProvidedBy, consumesApi/apiConsumedBy, childOf/parentOf, hasMember/memberOf. `backstage.io/managed-by-location` annotation records source file. Descriptors are hand-written YAML (catalog-info.yaml). [verified: https://backstage.io/docs/features/software-catalog/descriptor-format] Good, small, stable vocabulary for people/ownership/system layers.

**Architecture as code (C4/Structurizr).** DSL: workspace, person, softwareSystem, container, component, `->` relationships with technology, views (systemContext, container, component, deployment, dynamic). [verified: https://docs.structurizr.com/dsl/language] Hand-authored; drifts from code unless generated or checked [claimed/unverified].

**SBOM.** CycloneDX 1.7 (2025-10-21), ECMA-424 (2025-12-10): components, services, dependencies (direct+transitive), vulnerabilities, formulation (build). [verified: https://cyclonedx.org/specification/overview/] SPDX 3.0.0 (Apr 2024), ISO/IEC 5962:2021; profiles Security, Build, Dataset, AI. [verified: https://spdx.dev/about/overview/] Good machine-generated source for dependency/tech-stack facts, but generated from lockfiles, so deriving directly from lockfiles is equivalent and cheaper [claimed/unverified].

**OpenTelemetry service graph.** Collector `servicegraph` connector pairs client/server, producer/consumer, DB-client spans into edges; emits `traces_service_graph_request_total`, latency histograms; needs all spans of a trace on one collector; 2s TTL/1000 items default; alpha stability. [verified: https://github.com/open-telemetry/opentelemetry-collector-contrib/blob/main/connector/servicegraphconnector/README.md] Runtime truth, requires instrumentation and live traffic; not derivable from repo alone.

## 2. Deterministic vs LLM facts

Cheap, deterministic [claimed/unverified, standard practice; schema facts cross-checked above where noted]:
- Manifests and lockfiles (package.json, pyproject, go.mod, Cargo.lock): language, frameworks, dependency graph, versions. SBOM tools emit these (CycloneDX above).
- CI files (.github/workflows, .gitlab-ci.yml): build/test/deploy commands, runners, required checks.
- Dockerfile/compose/Helm/Terraform: base images, ports, env vars, service topology (codebase-memory-mcp models Image, Chart, EnvVar, DEPLOYS). 
- CODEOWNERS: path to owner mapping (Backstage ownedBy equivalent).
- OpenAPI/proto/GraphQL schemas: API surface (Backstage API kind).
- Tests layout and commands: directory conventions, test config files.
- Git: churn, authorship, co-change.
- Tree-sitter: symbols, imports, approximate call edges.

Needs LLM (or human): purpose and intent of modules, design rationale, conventions not encoded in config, domain boundaries (System/Domain), ticket-to-code mapping, summaries, "why". Evidence supports caution: LLM-generated AGENTS.md-style context files lowered task success and raised cost >20%; human-written ones gave slight gains. [verified: https://arxiv.org/abs/2602.11988 (Feb 2026; search summary notes a later version softened to "no significant improvement")] Implication: LLM-written prose should be small, labeled, and never trusted over deterministic facts.

## 3. Freshness

- Content fingerprints per source file (SHA-256) plus a tree hash; reindex only mismatches. Cursor uses exactly this Merkle scheme, and caches embeddings by chunk content. [verified: https://cursor.com/blog/secure-codebase-indexing]
- Watchers re-index on change (codebase-memory-mcp, cgc watch). [verified, repos above]
- Committed snapshot artifact for team sharing (codebase-memory-mcp graph.db.zst). [verified]
- Stale-evidence flagging when working tree differs from index (code-graph). [claimed/unverified]
- Git hooks (post-commit/post-merge/post-checkout) for local; CI job to rebuild and fail on drift (Repomix `--token-budget` exit code is a CI pattern). [verified: repomix README]
- LLM-derived facts: store the input fingerprint; mark stale when input hash changes, regenerate lazily [claimed/unverified, design inference].

## 4. Does graph structure beat plain retrieval?

Evidence exists, mixed, mostly small or non-independent:
- CodeCompass (arXiv 2602.20048, Feb 2026): hidden-dependency tasks, graph 99.4% vs BM25 78.2% vs vanilla 76.2%. Caveats: one FastAPI repo, 30 tasks, 258 trials; 58% of graph-enabled trials made zero tool calls; needed prompt engineering. No figures for semantic/structural tasks in abstract. [verified: https://arxiv.org/abs/2602.20048]
- Codebase-Memory (arXiv 2603.27277, 2026): 31 repos; ~10x fewer tokens, 2.1x fewer tool calls, but answer quality 83% vs 92% for file-exploration agent. Graph-native queries (hubs, caller ranking) matched or beat explorer in 19/31 languages. [verified: https://arxiv.org/abs/2603.27277] Authored by the tool's own builders.
- RepoGraph (ICLR 2025): plug-in lifts SWE-bench-Lite by roughly 2 points (Agentless+GPT-4o ~27.3 to ~29.7); runtime 2-3 h for procedural, up to ~10 h for agent frameworks. [claimed/unverified: search snippet, garbled table; https://arxiv.org/abs/2410.14684]
- RANGER: graph+MCTS improves retrieval metrics on RepoBench cross-file retrieval. [claimed/unverified: https://arxiv.org/abs/2509.25257]
- CodexGraph (NAACL 2025), KGCompass (58.3% SWE-bench Lite): [claimed/unverified].
- No independent, large, head-to-head benchmark of graph vs grep-style agentic retrieval on end-to-end resolution found. Anthropic/Cursor/Aider publish none in the pages read. Gap is real: gains concentrate in hidden/structural dependencies and token savings, not in universal accuracy.

## 5. Implications for a project-graph plugin

1. Model project-level entities, not just symbols: reuse the Backstage vocabulary (Component, System, API, Resource, Group, User, Domain; ownedBy, partOf, dependsOn, providesApi, consumesApi). Code-graph MCP servers leave this layer empty.
2. Derive deterministically first: manifests, lockfiles, CI, Dockerfiles, CODEOWNERS, OpenAPI, test layout. Zero LLM tokens, reproducible.
3. Tag every fact with provenance: source file, fingerprint, extractor, confidence (derived vs LLM vs human).
4. Fingerprint inputs (file hash plus tree hash) and reindex only changed sources; invalidate LLM-derived facts when their input hash changes.
5. Keep LLM-written content minimal; evidence shows generated context files can hurt success and cost >20%.
6. Do not rebuild symbol graphs; ingest SCIP or integrate an existing tree-sitter MCP server if code-level queries are needed.
7. Answer with tight, bounded outputs (Aider-style budget, ~1k tokens) rather than dumping packed repos; make the budget a parameter.
8. Ensure agents actually call it: CodeCompass saw 58% zero-tool-call trials; ship skills/hook prompts that route questions to the graph.
9. Freshness plumbing: post-commit/post-merge hook for local, CI drift check, optional committed snapshot for team sharing.
10. Measure it: build a small own benchmark (tokens, tool calls, answer correctness vs grep baseline); no trustworthy public number exists to lean on.
