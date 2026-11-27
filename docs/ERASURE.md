# Removing a person's data

plangraph keeps the plan as text in git, and git keeps everything. This page says what removing a person's data (a request to erase, or a name that should never have been committed) takes, what plangraph helps with, and what it cannot do.

## Why invalidate-not-delete does not cover erasure

plangraph's normal way to retire a fact is to invalidate it, not to delete it: a node gets a `valid_to` or `superseded_by`, a task gets a closing event, a decision becomes `deprecated`. That keeps the history honest and keeps readers working. It is the wrong tool for erasure for two reasons:

1. An invalidated node is still in the file, and the file is still in every commit that ever contained it. Marking a person's node `valid_to` changes today's reading of the plan, not what a clone, a fork or a backup holds.
2. Append-only events (`events/`), sealed runs (`runs/`) and immutable schedule versions (`schedules/`) are never edited by plangraph, by design. A name in `by`, `owner` or a note stays there until a person rewrites the file.

So erasure is two jobs: remove the data from the current tree (this tool helps), and remove it from history (git does, destructively, and only you can decide to).

## What the tool can do: `eraseNode`

`eraseNode(root, kind, id)` in `lib/store2/nodes.ts` computes an erase plan and changes nothing. `root` is the plan directory. It returns:

- `files`: the node file of that id, if there is one;
- `links`: every other node whose `links` or `xrefs` point at the id (file and relation);
- `events`: every line of a `.jsonl` file under `events/`, `runs/` and `schedules/` that contains the id as a JSON string (file and line number).

Run it from a checkout of the plugin, naming your plan directory:

```bash
node --input-type=module -e "
const { eraseNode } = await import('/path/to/plangraph/lib/store2/nodes.ts');
console.log(JSON.stringify(eraseNode('.plangraph', 'person', 'Ana'), null, 2));"
```

There is no `plangraph` command around it yet; it is a library function with a test (`test/store2-nodes.test.ts`). It is read-only, so running it is safe.

What it does not find: a name that sits in the value of a field of another node (for example the `v2_owner` of a ticket is a person's name, not a link), a name inside free text (a note, a summary, a requirement), or anything in `cache/`. Find those with a plain search of the working tree:

```bash
git grep -n -i -- 'the person' -- .plangraph docs
```

Also search generated documents (`docs/plangraph/`, which is git-ignored unless `docs.commit` is true; regenerate with `plangraph docs-build` after the plan is clean) and your Jira, GitHub and Confluence data, which plangraph only reads.

## Procedure for the current tree

1. Run `eraseNode` for the person's node id and for each tracker id (`jira:...`, `github:...`) you know, and the `git grep` above for the name and email.
2. Edit the files it lists. Replace the person in `owner` and `by` fields with a neutral value that still keeps the plan valid (for example another person, or an id such as `former-member`), delete the node file, and remove the `links` and `xrefs` lines that point to it. Event, run and schedule files are append-only for plangraph, not for you: you may rewrite a line by hand. Keep each file sorted and canonical; `plangraph fmt` rewrites what is not canonical.
3. Run `plangraph check`. A `DANGLING_LINK` means a link still points at the removed node.
4. Delete the local cache (`plangraph uninstall --yes` removes `cache/` and the index) and rebuild with `plangraph build`. The cache can hold tracker data (names, assignees) that was never committed but is on your disk.
5. Commit. This removes the person from the tree at that commit and every later one.

## History

Step 5 does not touch earlier commits. If the data must also leave history:

- **Rewrite history with a purpose-built tool**, for example `git filter-repo` (replace-text for a name or an email, path filters for a deleted file). It rewrites every commit id from the first affected one, so every collaborator must re-clone or hard-reset, open pull requests need to be re-created, and tags and releases that pointed at old commits need re-issuing.
- **Force-push** the rewritten branches and tags, then ask the hosting service to purge cached views and unreachable objects (a fork, a pull request ref or a cached commit page can still serve the old data until it does). Anyone who already cloned or forked keeps a copy: a rewrite reduces exposure, it does not recall data.
- **Verify** on a fresh clone with `git log -S'the string' --all` and a search of `git rev-list --all`'s objects. Do this after the rewrite and again after the hosting service has purged.
- **Plan for the alternative**: if the repository is not yet public, or the data is small, publishing a fresh-history repository and keeping the old one private (see [docs/LAUNCH.md](LAUNCH.md)) is simpler than rewriting.
- Authors in commit metadata are not plan data. A person's name or email in `git log` stays in history until the rewrite; `.mailmap` hides it only in views that honor it.

## What is verified

`eraseNode` is tested for what it lists (`test/store2-nodes.test.ts`). The procedure above was not run against a real repository, no tool in plangraph rewrites git history, and no test checks that a person's name is gone from a tree after the steps. Treat the steps as a checklist to follow with your own verification, not as a guarantee. For a legal erasure obligation, involve whoever owns that obligation in your organization.
