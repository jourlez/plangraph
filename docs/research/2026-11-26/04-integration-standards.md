# Integration standards research (fetched 2026-11-26)

Tags: [verified: URL] = read on page this session. [claimed/unverified] = memory, search snippet, or page truncated.

## 1. MCP spec and Claude Code consumption
- Latest revision 2026-07-28; previous 2025-11-25. A post-release changelog restores `_meta` on some types and bumps CIMD to draft-03 [verified: https://modelcontextprotocol.io/specification/draft/changelog].
- 2026-07-28 changes [verified: https://modelcontextprotocol.io/specification/2026-07-28/changelog]:
  - Stateless: no `initialize` handshake, no `Mcp-Session-Id`. Every request carries protocol version and client capabilities in `_meta`.
  - New required `server/discover` RPC for versions, capabilities, identity.
  - `subscriptions/listen` replaces GET stream and `resources/subscribe`.
  - Tasks moved out of core into extension `io.modelcontextprotocol/tasks` (`tasks/get`, `tasks/update`; `tasks/list` and `tasks/result` removed).
  - Elicitation/sampling/roots now ride Multi Round-Trip Requests (`resultType: "input_required"`, `inputResponses`, `requestState`).
  - `ttlMs` and `cacheScope` required on list/read/discover results.
  - `outputSchema` and `inputSchema` allow any JSON Schema 2020-12; `structuredContent` may be any JSON value.
  - Deprecated: Roots, Sampling, Logging, HTTP+SSE, Dynamic Client Registration (CIMD preferred). 12-month minimum deprecation window.
- 2025-11-25 added: URL-mode elicitation, experimental tasks, icons, OIDC discovery for auth servers, incremental scope consent via `WWW-Authenticate`, CIMD, tool-calling in sampling [verified: https://modelcontextprotocol.io/specification/2025-11-25/changelog].
- Tools: `outputSchema` plus `structuredContent`; servers MUST conform, clients SHOULD validate. Tools may return `resource_link`. Tool-list order SHOULD be deterministic. Clients MUST treat annotations as untrusted unless the server is trusted [verified: https://modelcontextprotocol.io/specification/2026-07-28/server/tools].
- `readOnlyHint` default false, `destructiveHint` default true, `idempotentHint` default false, `openWorldHint` default true; advisory only [claimed/unverified: recalled from earlier revisions; schema page truncated].
- Resource templates use RFC 6570 `uriTemplate` [claimed/unverified].
- Claude Code [verified: https://code.claude.com/docs/en/mcp]:
  - Tool search is on by default; only tool names and server instructions load at start. Server instructions guide discovery. `alwaysLoad: true` per server forces upfront load.
  - Upfront description limit 4,096 chars; deferred 16,384 chars.
  - Output: warning at 10,000 tokens; default cap 25,000 tokens (`MAX_MCP_OUTPUT_TOKENS`). Text over 50,000 chars is saved to a file. A tool may set `_meta["anthropic/maxResultSizeChars"]` up to 500,000.
  - Resources via @-mentions. `list_changed` refresh: all lists interactive, tools only in `-p`.
  - Plugin MCP servers bundled via `.mcp.json` or `plugin.json`; tool names `mcp__plugin_<plugin>_<server>__<tool>`; `${CLAUDE_PLUGIN_ROOT}` placeholders.
  - Scopes: local, project (`.mcp.json`), user. `claude -p` cannot run OAuth.

## 2. Existing vendor MCP servers
- Atlassian Rovo: `https://mcp.atlassian.com/v2/mcp`; OAuth 2.1 primary, optional API token. Covers Jira, JSM, Confluence, Bitbucket, Projects, Goals, Loom. v1 usage auto-moves to v2 on 2027-03-01 [verified: https://support.atlassian.com/atlassian-rovo-mcp-server/docs/getting-started-with-the-atlassian-remote-mcp-server/]. Tools seen in this session: getJiraIssue, searchJiraIssuesUsingJql, searchConfluence, getConfluenceContent, plus `discover` and `executeRead/Write/Destructive` tiers [verified: session tool list]. A GitHub issue reports `searchJiraIssuesUsingJql` never returns `nextPageToken` [claimed/unverified: search snippet, https://github.com/atlassian/atlassian-mcp-server/issues/118].
- GitHub: remote `https://api.githubcopilot.com/mcp/`, OAuth or PAT bearer. Toolsets (default: context, repos, issues, pull_requests, users; also actions, code_security, dependabot, projects...). `--read-only` skips all write tools [verified: https://github.com/github/github-mcp-server].
- Linear: `https://mcp.linear.app/mcp`; OAuth 2.1 or Bearer API key. Read-only via `/mcp/readonly`, `read` scope, or read-only API key [verified: https://linear.app/docs/mcp].
- Slack: `https://mcp.slack.com/mcp`; confidential OAuth, no DCR; directory-published or internal apps only; search, read channel/thread, canvases, lists; same rate limits as Web API; admins approve clients [verified: https://docs.slack.dev/ai/mcp-server].
- Notion: `https://mcp.notion.com/mcp`; OAuth, or MCP tokens on Business/Enterprise; tools notion-search, notion-query-data-sources, notion-create-pages, notion-update-page, notion-create-comment; SSE retires 2027-02-23 [verified: https://developers.notion.com/guides/mcp/get-started-with-mcp].
- Asana: `https://mcp.asana.com/v2/mcp`; OAuth; beta `/sse` shuts down 2026-05-11 (already past); tool list only via `tools/list` [verified: https://developers.asana.com/docs/using-asanas-mcp-server].
- Coexistence: vendor servers are interactive, per-user, token-heavy, and paginate poorly. A graph tool should ingest via REST/GraphQL with its own least-privilege token into a local store, and expose a few typed, bounded read tools. Let the agent call vendor MCP for writes and fresh single-item reads, joined by xref ids. [claimed/unverified: design judgment]

## 3. Sync APIs
- Jira Cloud:
  - `GET /rest/api/3/search/jql` replaces `/search`, which is removed. Pagination uses `nextPageToken`; there is no random access, no parallel paging, and tokens expire after 7 days. Only IDs return unless `fields` is set. Unbounded JQL gives 400. Eventually consistent; `reconcileIssues` forces freshness. Totals come from a separate approximate-count endpoint [verified: https://community.developer.atlassian.com/t/rfc-61-evolving-search-capabilities-addressing-scalability-with-a-new-enhanced-search-api/83027; removal: claimed/unverified, https://confluence.atlassian.com/jirakb/run-jql-search-query-using-jira-cloud-rest-api-1289424308.html].
  - Community reports of looping or broken `nextPageToken` [claimed/unverified].
  - Cursor pattern: `updated >= "<watermark minus overlap>" ORDER BY updated ASC`. Overlap plus eventual consistency means upsert idempotently [claimed/unverified: design inference].
  - Bulk Fetch caps comments and changelogs at 20 per issue [verified: RFC-61 URL above]. Per-issue `GET /issue/{key}/changelog` is paginated. Changelog gaps for some transitions are reported [claimed/unverified: search snippet].
  - Issue links arrive in `fields.issuelinks`, with inward/outward link types [claimed/unverified].
  - Agile API `/rest/agile/1.0/board/{id}/sprint` and `/sprint/{id}/issue`; scope `read:sprint:jira-software`; sprint has state, startDate, endDate, completeDate, goal [verified: https://developer.atlassian.com/cloud/jira/software/rest/api-group-sprint/ (get-sprint only; board listing unverified)].
  - Rate limits, enforced from 2026-03-02 for Forge, Connect and OAuth 3LO apps: hourly points (default tier 65,000/hr), per-endpoint burst (100 rps GET), per-issue write limits. 429 with `Retry-After`; API-token traffic stays on burst limits [verified: https://developer.atlassian.com/cloud/jira/platform/rate-limiting/].
- GitHub:
  - REST: 5,000/hr per user; app installation 5,000-12,500; Actions `GITHUB_TOKEN` 1,000/hr/repo. Secondary: 100 concurrent, 900 points/min REST. Headers `x-ratelimit-*` [verified: https://docs.github.com/en/rest/using-the-rest-api/rate-limits-for-the-rest-api].
  - Conditional requests: send `if-none-match` with saved `etag`; an authenticated 304 does not count against the primary limit. Same params every poll. Honor `x-poll-interval`. Follow Link headers [verified: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api].
  - GraphQL: 5,000 points/hr; `first`/`last` 1-100; 500,000 node cap; `rateLimit { cost remaining resetAt }` [verified: https://docs.github.com/en/graphql/overview/rate-limits-and-query-limits-for-the-graphql-api].
  - CODEOWNERS is read as a file at `.github/CODEOWNERS`, `CODEOWNERS` or `docs/CODEOWNERS`; checks via check-runs API; `gh api` and `gh pr list --json` wrap these [claimed/unverified].
- Linear GraphQL: Relay `first/after` pagination, 50 default; `orderBy: updatedAt`. API key 2,500 req/hr and 3,000,000 complexity/hr; OAuth 5,000 req/hr and 2,000,000 complexity; single query max 10,000 complexity; 429 `RATELIMITED` with `Retry-After`; Business 2x, Enterprise 5x [verified: https://linear.app/developers/rate-limiting, https://linear.app/developers/pagination]. `updatedAt` filter and `includeArchived` [claimed/unverified].
- Confluence v2: `limit` + `cursor`; next link in `Link` header and `_links.next` [verified: https://developer.atlassian.com/cloud/confluence/rest/v2/intro/]. Page version and body-format details [claimed/unverified].

## 4. Linked-data and cross-tool standards
- OSLC: Core 3.0 is an OASIS Standard; Change Management 3.0, Requirements 2.1, Quality 2.1, Architecture 3.0, Configuration Management 1.0, Tracked Resource Set 3.0 [verified: https://open-services.net/specifications/]. Link model is RDF properties between resource URIs with Resource Shapes [claimed/unverified]. Reuse: TRS change-log idea (creation/modification/deletion events) for incremental sync, and link-type vocabulary names. Do not adopt RDF.
- W3C PROV: PROV-DM/PROV-O Recommendations dated 2013-04-30 [verified: https://www.w3.org/TR/prov-overview/]. Entity/Activity/Agent with wasDerivedFrom, wasAttributedTo [claimed/unverified]. Reuse for edge provenance (source system, fetched_at, extractor).
- Backstage: entity ref `kind:namespace/name`; `uid` is explicitly not stable for external reference; well-known relations ownedBy/ownerOf, dependsOn/dependencyOf, partOf/hasPart, providesApi/consumesApi, parentOf/childOf, memberOf/hasMember, each with an inverse [verified: https://backstage.io/docs/features/software-catalog/descriptor-format/, https://backstage.io/docs/features/software-catalog/well-known-relations/]. Best direct template for typed, paired relations and owner resolution.
- OpenAPI 3.2.1 (2026-09-10): `operationId` uniqueness, Link Object [verified: https://spec.openapis.org/oas/latest.html (Link Object section not read)]. Use only to describe the plugin's JSON output.
- CycloneDX 1.7 (2025-10-21), ECMA-424; JSON/XML/protobuf; dependency graph including services [verified: https://cyclonedx.org/specification/overview/]. SPDX 3.0, ISO/IEC 5962 for 2.x [verified: https://spdx.dev/use/specifications/]. Relevant only if graph links tickets to components or SBOM nodes; use `bom-ref` as an xref scope [claimed/unverified].
- SCIM 2.0 (RFC 7643/7644): `id` is server-assigned, `externalId` client-supplied, `meta.lastModified`/`version`; filter, startIndex/count [verified: https://www.rfc-editor.org/rfc/rfc7644]. The `externalId` + `meta` pattern maps to xref `(sys, xid)`; use for person identity only.
- Reusable shape: node key `(sys, xid)` like SCIM `externalId` scoped by system; edge type names from Backstage with explicit inverses; per-edge provenance from PROV; incremental feed idea from OSLC TRS.

## 5. Agent-facing standards
- Agent Skills: `SKILL.md` with YAML `name` (<=64, lowercase/hyphen, matches directory) and `description` (<=1024); optional license, compatibility (<=500), metadata, experimental `allowed-tools`. Progressive disclosure: ~100 tokens metadata, <5,000 tokens body, body under 500 lines; dirs scripts/, references/, assets/ [verified: https://agentskills.io/specification].
- AGENTS.md: plain Markdown at repo root, no required fields; nearest file wins; stewarded by Agentic AI Foundation (Linux Foundation); 60k+ projects claimed [verified: https://agents.md/].
- A2A 1.0.0: bindings JSON-RPC, gRPC, HTTP+JSON; task states submitted/working/input-required/auth-required/completed/failed/canceled/rejected; joined Agentic AI Foundation [verified: https://a2a-protocol.org/latest/specification/ (Agent Card path and MCP relation not read)]. Peer-agent protocol; not needed for a data tool.
- Claude Code marketplaces: `.claude-plugin/marketplace.json` (name, owner, plugins[] with name+source). Sources: relative path, github, git-subdir, url, archive, npm, command; pin by ref/sha. Install `claude plugin marketplace add <owner>/<repo>` then `claude plugin install <name>@<marketplace>`. `claude plugin validate`. Admins can require a marketplace [verified: https://code.claude.com/docs/en/plugin-marketplaces].

## 6. Security for read-only integrations
- MCP: tokens must be audience-bound; servers MUST NOT accept tokens not issued to them (no passthrough); least-privilege progressive scopes; avoid wildcard scopes; SSRF block private ranges; per-client consent on proxies [verified: https://modelcontextprotocol.io/specification/2026-07-28/basic/security_best_practices].
- Claude Code: credentials in macOS Keychain, else 0600 file; `.mcp.json` env expansion `${VAR}`; project servers need approval; Anthropic does not audit MCP servers; guidance "avoid piping untrusted content directly to Claude" [verified: https://code.claude.com/docs/en/security, https://code.claude.com/docs/en/mcp].
- Vendor read-only levers: Linear `/mcp/readonly`, GitHub `--read-only`, read-only scopes (Slack `*:read`, Jira `read:*`) [verified: URLs in section 2].
- Prompt injection: ticket, comment and wiki text is attacker-influenced. Mitigation pattern: never inline raw text as instructions; return as data fields with provenance; fence and length-cap; strip control/markup; prefer IDs and structured fields over free text; OWASP LLM Top 10 2025 is the reference list [verified existence only: https://owasp.org/www-project-top-10-for-large-language-model-applications/; mitigation details claimed/unverified].
- Data minimization: fetch only needed `fields`; hash or drop emails and PII; store tokens outside the repo; local cache with 0600 and a TTL [claimed/unverified: design judgment].

## Implications for a project-graph plugin
1. Ship an MCP server (stdio, plugin-bundled) with few typed tools, `outputSchema` plus `structuredContent`, and `readOnlyHint: true`. Annotations are advisory, so also enforce read-only in code.
2. Write server `instructions` that lead with search keywords, since tool search reads only the first 4,096 chars upfront.
3. Keep results under 25,000 tokens; return IDs plus `resource_link`s; set `anthropic/maxResultSizeChars` only for deliberate bulk exports.
4. Identity `(sys, xid)` with system-scoped ids, like SCIM `externalId`; never use mutable keys (Backstage `uid` warning).
5. Typed relations with explicit inverses, seeded from Backstage (ownedBy, dependsOn, partOf) and Jira link types; add provenance per edge (source, fetched_at) from PROV.
6. Sync Jira via `search/jql` with `fields` set and an `updated` watermark with overlap; tolerate eventual consistency; fall back on `reconcileIssues`; never rely on totals; handle 429 `Retry-After`.
7. Sync GitHub with ETag and `if-none-match` (free 304s), Link-header pagination, `x-poll-interval`, and GraphQL for PR-plus-checks joins; Linear via `orderBy: updatedAt` and complexity headers.
8. Read-only tokens only (Linear read key, GitHub fine-grained read, Jira read scopes); keep in env or keychain, never in graph files; do not forward tokens to other servers.
9. Treat all tracker text as untrusted: fenced `untrusted_text` fields, length caps, no instruction-bearing summaries, a golden test with injection payloads.
10. Coexist, do not compete: vendor MCP for writes and live single-item reads; the graph answers cross-tool joins; publish through a marketplace entry plus an Agent Skill and an AGENTS.md snippet; skip OSLC/RDF/A2A.
