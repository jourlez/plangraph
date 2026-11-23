# Security policy

## Reporting a vulnerability

Use GitHub private vulnerability reporting: open the repository's Security tab, choose Report a vulnerability, and describe the issue there. It is private to the maintainer until an advisory is published. This channel must be enabled in the repository settings (Settings, Code security, Private vulnerability reporting); if the button is missing, it is not enabled yet. Please do not put exploit details in a public issue.

## Status

- Verified in a live session (non-interactive, Claude Code 2.1.329): the plugin installs from the public GitHub repository with the `claude plugin` CLI in an isolated config, and sessions started with `claude -p --plugin-dir` show the session-start card, the skills and `brain` on the Bash PATH. Not exercised: the interactive `/plugin` menu, Claude Code releases after 2.1.329, and Windows. See the README, section Known limits.
- No security review by a third party has been done. The checks below were written by the author and are covered by the tests in `test/`.

## What is hardened (each has tests)

- Text from tickets, Jira, plans, findings and meetings is treated as untrusted: newlines are collapsed, angle brackets removed, length capped, and free text is fenced before it reaches output (`lib/sanitize.mjs`).
- State files are written atomically and refuse symlink targets; paths are checked to stay inside the project root (`lib/fsafe.mjs`).
- Git is only called with an argument list (no shell), with refs and paths checked first (`lib/gitsafe.mjs`).
- Reads of repository-controlled files are size-capped and only for regular files.
- The SQLite index is opened only when its schema is exactly the one `brain build` writes (no view, trigger or extra object or column), since a committed `brain.sqlite` can carry a matching fingerprint; anything else is refused with `brain build` as the fix.
- Jira access is read-only (`lib/jira.mjs`): https only, a fixed host rule, a read-only method and path allowlist, no redirects followed. A Jira credential is read from your environment, 1Password or keychain; it is never written to a file, logged or accepted as an argument.
- Companion-tool detection reads files only and starts no process. `brain integrations` spawns nothing. `brain doctor` spawns `uv --version` (solver runtime check) and runs git with an argument list (tracked-index and merge-driver checks; `--fix` also writes git config).
- Commands named in project config are no longer executed (removed; see CHANGELOG.md).

## Limits you should know

- Hooks and the commands in `bin/` run as you, unsandboxed, with your permissions. The session hook runs `bin/brain card --if-present` at session start. Read the code before you install it.
- `brain init` writes a git merge driver into the repository's local git config. Git then runs that driver, through a small shell shim in a data directory, at merge time. Whoever can write that directory or `bin/brain-merge` can run code as you at the next merge. The shim code refuses a data directory that is a symlink, owned by someone else or writable by others, but it checks only the final path components.
- Checks that "nothing is written" or "a path is inside the root" cannot remove every race between the check and the write (time of check to time of use).
- The first run of the solver downloads pinned Python packages (see docs/SOLVER.md). They are version-pinned and, on the pip path, hash-verified; the packages themselves are not audited here.
- CI secret scanning uses `gitleaks/gitleaks-action` v2 (pinned by SHA in `.github/workflows/ci.yml`). Per that action's README, repositories owned by an organization need a `GITLEAKS_LICENSE` secret (a free licence is available; user-owned repositories need none), and the action sends the licence key, the repository name and the repository owner to its licence-validation service (keygen.sh); your code is not sent. This repository's workflow passes no licence, so move it to an organization only after adding that secret or replacing the scanner.
- Windows is not supported (the merge driver shim is POSIX shell).
