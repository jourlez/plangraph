# Security policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open the repository's Security tab, choose Report a vulnerability, and describe the issue there. It is private to the maintainer until an advisory is published. This channel must be enabled in the repository settings (Settings, Code security, Private vulnerability reporting); if the button is missing, it is not enabled yet. Please do not put exploit details in a public issue.

## Response

Best effort, single maintainer, no response-time promise: report privately through GitHub private vulnerability reporting (above), not in a public issue.

## Supported versions

Only the latest release receives fixes. The package is distributed through git (a Claude Code marketplace) and is marked `private` in `package.json` so it cannot be published to npm by accident. Dependabot opens weekly update pull requests for the dev-only tools and the GitHub Actions.

## Status

- Verified in a live session (non-interactive, Claude Code 2.1.329): the plugin installs from the public GitHub repository with the `claude plugin` CLI in an isolated config, and sessions started with `claude -p --plugin-dir` show the session-start card, the skills and `plangraph` on the Bash PATH. Not exercised: the interactive `/plugin` menu, Claude Code releases after 2.1.329, and Windows. See the README, section Known limits.
- No security review by a third party has been done. The checks below were written by the author and are covered by the tests in `test/`.

## What is hardened (each has tests)

- Text from tickets, Jira, plans, findings and meetings is treated as untrusted: newlines are collapsed, angle brackets removed, length capped, and free text is fenced before it reaches output (`lib/sanitize.ts`).
- State files are written atomically and refuse symlink targets; paths are checked to stay inside the project root (`lib/fsafe.ts`).
- Git is only called with an argument list (no shell), with refs and paths checked first (`lib/gitsafe.ts`).
- Reads of repository-controlled files are size-capped and only for regular files.
- The SQLite index is opened only when its schema is exactly the one `plangraph build` writes (no view, trigger or extra object or column), since a committed `plangraph.sqlite` can carry a matching fingerprint; anything else is refused with `plangraph build` as the fix.
- Jira access is read-only (`lib/jira.ts`): https only, a fixed host rule, a read-only method and path allowlist, no redirects followed. A Jira credential is read from your environment, 1Password or keychain; it is never written to a file, logged or accepted as an argument.
- Companion-tool detection reads files only and starts no process. `plangraph integrations` spawns nothing. `plangraph doctor` spawns `uv --version` (solver runtime check) and runs git with an argument list (tracked-index and merge-driver checks; `--fix` also writes git config).
- Commands named in project config are no longer executed (removed; see CHANGELOG.md).

## Trust boundaries

- The environment is the trust root. `PLANGRAPH_CONFIG_DIR` (where the user-level config and Jira bindings live), `JIRA_BASE_URL`, `PLANGRAPH_JIRA_DC_HOSTS` (the Data Center allowlist) and `PLANGRAPH_JIRA_SITES` (the site pin list) redirect where plangraph looks for its config and which Jira hosts it trusts with your credentials. Whoever sets them decides that. A repository's committed `.claude/settings.json` can set environment variables for a session, but such a repository can already set hooks that run as you, so trusting the repository's settings is the boundary, not plangraph.
- In the scoped mode (a scoped API token, the default), requests go to `api.atlassian.com/ex/jira/<cloud_id>` with your generic credentials (`JIRA_EMAIL` and `JIRA_API_TOKEN`, or their 1Password or keychain source), and the `cloud_id` can come from a committed project config. A repository can therefore choose which Cloud site your token is presented for. The request still goes only to Atlassian's API host, where Atlassian's gateway terminates it and checks the token (informational).
- Jira Data Center hosts are trusted only when they are listed in your user-level allowlist (`PLANGRAPH_JIRA_DC_HOSTS`). The plugin manifest's `network.hosts` (`.claude-plugin/plugin.json`) lists no Data Center host, so a Claude Code setup that enforces that list blocks Data Center access until you allow the host yourself.
- The per-user data directory (`CLAUDE_PLUGIN_DATA`, else `~/.cache/plangraph`) holds the merge-driver shim and the Node compile cache. Both are used only when the directory is a real directory owned by you and not writable by others; the compile cache directory inside it must also have no group or world bits, and anything else means no cache, silently. Node's default shared cache directory (`os.tmpdir()/node-compile-cache`) is never used unless you set `NODE_COMPILE_CACHE` yourself: it accepts entries any local user can plant.
- The solver's `uv run` fallback (an older uv) passes an absolute `--python` found by `uv python find` run from the plugin's `bin` directory, so a `.venv` or `.python-version` committed in the working directory never chooses the interpreter; with none found it exits 3 and installs nothing.
- The solver's Python fallback (no uv) runs every Python call in isolated mode (`python -I`), so a repository's `ortools.py`, `venv/` or `pip.py` in the working directory is never imported.

## Limits you should know

- Hooks and the commands in `bin/` run as you, unsandboxed, with your permissions. The session hook runs `bin/plangraph card --if-present` at session start. Read the code before you install it.
- `plangraph init` writes a git merge driver into the repository's local git config. Git then runs that driver, through a small shell shim in a data directory, at merge time. Whoever can write that directory or `bin/plangraph-merge` can run code as you at the next merge. The shim code refuses a data directory that is a symlink, owned by someone else or writable by others, but it checks only the final path components.
- Accepted limit (owner, 0.3.0): when `PLANGRAPH_SOLVE_SCRIPT` overrides the solver script and the uv preparation fails, `bin/plangraph-solve-run` installs OR-Tools with `uv run --with ortools==<exact version>` instead of from the hashed lock. The override is a developer and test variable that only the user sets, the version is pinned exactly, and the normal path always installs from `bin/plangraph-solve.lock` with hashes.
- Checks that "nothing is written" or "a path is inside the root" cannot remove every race between the check and the write (time of check to time of use).
- The first run of the solver downloads pinned Python packages (see docs/SOLVER.md). They are version-pinned and, on the pip path, hash-verified; the packages themselves are not audited here.
- CI secret scanning uses `gitleaks/gitleaks-action` v2 (pinned by SHA in `.github/workflows/ci.yml`). Per that action's README, repositories owned by an organization need a `GITLEAKS_LICENSE` secret (a free licence is available; user-owned repositories need none), and the action sends the licence key, the repository name and the repository owner to its licence-validation service (keygen.sh); your code is not sent. This repository's workflow passes no licence, so move it to an organization only after adding that secret or replacing the scanner.
- Redaction of the Jira API token in messages and logs (`lib/jira.ts`, decision D11) is a best effort with design limits. It does not catch: a case-changed piece of the token shorter than 16 characters; a case-changed token shorter than 12 characters; a case-changed derived form (for example a lowercased base64 of the token); a piece shorter than 16 characters of a token split by percent-encoding or JSON escaping.
- A Jira tenant alias (`"tenant": "work"` in `config.json`, defined in `~/.config/plangraph/jira-sites.json`, docs/JIRA.md) resolves only for a repository approved by `plangraph doctor --fix --alias NAME`, which asks you to type the alias host in an interactive terminal. That check stops an agent that follows a printed hint in a hostile repository. It does not stop a prompt-injected agent that has shell access: it can fake a terminal (`script(1)`) or edit `jira-sites.json` directly. Only you should approve aliases; the host is shown so a wrong request is visible. The approval is keyed by the clone's path, so another repository cloned at the same path inherits it.
- `plangraph doctor --fix --alias NAME` refuses inside Claude Code (`CLAUDECODE` or any `CLAUDE_CODE_*` variable) and reads the typed host from `/dev/tty`. A pty-capable agent that clears those variables can still drive the prompt. Add a permission deny rule for `Bash(plangraph doctor --fix*)` and approve aliases only in your own terminal.
- Heal consent (`plangraph.heal`) can be granted by an agent that can run `plangraph init` or `plangraph doctor --fix`. Impact is low: the repair points at the plugin's own shim in a private data directory.
- Alias approval is keyed by the git common directory (its real path), not by the remote or the repository identity.
- CI runs `npx --yes @anthropic-ai/claude-code@2.1.329`: a pinned version without an integrity hash (decision D16).
- Windows is not supported (the merge driver shim is POSIX shell).
