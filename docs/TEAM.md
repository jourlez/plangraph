# Working in a team

This is the path for a second person who joins a repository that already uses plangraph. The plan is plain text in git, so a teammate needs the plugin, one command per clone, and their own Jira credentials. Nothing else.

## 1. Install the plugin (project scope)

Install for the project, so the install is tied to this repository and not to your whole user:

```bash
claude plugin marketplace add jourlez/plangraph
claude plugin install plangraph@plangraph-marketplace --scope project
```

Restart Claude Code. See the README, section Installation, for the other scopes and for a local path.

## 2. Nothing to wire per clone

The plan is a directory of small text files (one file per ticket, person, sprint, and so on). Stock git merges them: there is no merge driver and no `.gitattributes` entry, so a fresh clone, the GitHub merge button, CI and an agent sandbox all behave alike. After a merge, run `plangraph check`: it lists any conflicted or inconsistent file with its file and line.

`plangraph doctor` exits 0 when the data format and Node are fine.

## 3. Jira credentials are per person and never committed

Each person puts their own Jira token in their own environment, 1Password or keychain. Nothing about a credential goes into the repository, into `.plangraph/config.json` or into a pull request. Tenant fields in committed config are treated as untrusted. Setup, token scopes and rotation are in [JIRA.md](JIRA.md).

## 4. What to commit

Commit:
- the plan files (`nodes/`, `events/`, `runs/`, `schedules/`, `meta.jsonl`), `config.json` and `format.json`.

Never commit `plangraph.sqlite` (nor its journal files) or `cache/`. They are derived: `plangraph build` recreates it from the text. `plangraph init` adds the ignore lines to the plan directory's `.gitignore`. Never commit a Jira token, an email address or a keychain export.

## 5. Upgrade together

Everyone on the repository runs the same plugin version. Update before pulling a change that touches `.plangraph/`:

```bash
claude plugin marketplace update plangraph-marketplace
claude plugin update plangraph@plangraph-marketplace
plangraph doctor
```

Then restart Claude Code. An older reader of a newer data format refuses it rather than guessing, and one teammate on the old version means a plain text merge for that person.

## 6. Pin a release by tag

From v0.3.0 on, releases are annotated tags named `vX.Y.Z` on `main`. To install exactly one release, check out the tag and add the clone as a local marketplace:

```bash
git clone --branch v0.3.0 https://github.com/jourlez/plangraph.git
claude plugin marketplace add ./plangraph
claude plugin install plangraph@plangraph-marketplace --scope project
```

The GitHub marketplace source follows the default branch. To move to another release later, check out the new tag in that clone and run `claude plugin marketplace update plangraph-marketplace`.

## 7. When a merge conflicts

1. Run `plangraph check`: it names every conflicted file with its file and line (`CONFLICT_MARKERS`).
2. Run `plangraph resolve`: when every conflicting hunk of a file only adds or removes lines of a collection field (links, cross references), it keeps both sides, sorted. A conflict on a scalar field (an owner, a status) is left in the file and reported with the file and field: open it, keep one side, and remove the markers.
3. Run `plangraph check` and `plangraph verify`: they catch an invalid file or a broken dependency before you commit.
4. Run `plangraph build` to refresh the index, then commit the plan files.
