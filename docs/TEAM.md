# Working in a team

This is the path for a second person who joins a repository that already uses plangraph. The plan is plain text in git, so a teammate needs the plugin, one command per clone, and their own Jira credentials. Nothing else.

## 1. Install the plugin (project scope)

Install for the project, so the install is tied to this repository and not to your whole user:

```bash
claude plugin marketplace add jourlez/plangraph
claude plugin install plangraph@plangraph-marketplace --scope project
```

Restart Claude Code. See the README, section Installation, for the other scopes and for a local path.

## 2. Run `plangraph doctor --fix` once per clone

```bash
plangraph doctor --fix
```

Why: the plan files in `.plangraph/*.jsonl` are merged record by record by a git merge driver. The repository carries only the `.gitattributes` line that asks for it. The driver itself lives in your local git config (`merge.plangraph-jsonl.*`), which git does not version. So every clone needs the driver wired once, or git falls back to a plain text merge of the JSONL files and conflicts appear where the driver would have merged cleanly.

Why it is a command you run and not something the plugin does on its own: the plugin never wires the merge driver into a clone you did not set up. Git runs a configured driver as you at every merge, so writing that setting is your consent to make, once, per clone. The session hook only repoints a driver you already wired (after a plugin update). `plangraph doctor` without `--fix` only reports.

`plangraph doctor` exits 0 when the merge driver, the data format and Node are fine.

## 3. Jira credentials are per person and never committed

Each person puts their own Jira token in their own environment, 1Password or keychain. Nothing about a credential goes into the repository, into `.plangraph/config.json` or into a pull request. Tenant fields in committed config are treated as untrusted. Setup, token scopes and rotation are in [JIRA.md](JIRA.md).

## 4. What to commit

Commit:
- the `.plangraph/*.jsonl` files (the plan), `config.json` and `format.json`;
- `.gitattributes` (it holds the `merge=plangraph-jsonl` line).

Never commit `plangraph.sqlite` (nor `*.sqlite-wal` or `*.sqlite-shm`). It is a derived index: `plangraph build` recreates it from the text. `plangraph init` adds the ignore lines to the plan directory's `.gitignore`. Never commit a Jira token, an email address or a keychain export.

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

1. Run `plangraph doctor`. A line `merge driver: ... is not set` means this clone was never wired (or the plugin moved): run `plangraph doctor --fix`, then redo the merge (`git merge --abort`, then merge again).
2. If the driver is wired and a conflict remains, the same record was changed in two different ways. Open the file named in the conflict, keep one side per record (one JSON object per line), and remove the markers.
3. Run `plangraph check` and `plangraph verify`: they catch an invalid line or a broken dependency before you commit.
4. Run `plangraph build` to refresh the index, then commit the `.jsonl` files.
