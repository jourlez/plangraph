# SDD ledger — plan: docs/superpowers/plans/2026-11-20-widget-export.md
Preflight: Task 3 consumes formatRow/HEADER (Task 1) and streamWidgets (Task 2): names and types agree. Clean.
Task 1: complete (commits a1b2c3d..b2c3d4e, review clean)
Task 1: minor (deferred): HEADER is not exported as a frozen constant
Task 2: fix round 1/5 (1 addressed, 0 open — limit off by one; commits b2c3d4e..c3d4e5f)
Task 2: complete (commits b2c3d4e..c3d4e5f, review clean)
Task 3: fix round 1/5 (0 addressed, 1 open — 413 body is JSON not plain text; commits c3d4e5f..d4e5f6a)
Ruling: plain-text 413 body per spec Constraints — spec names the code, not a JSON shape — a client parsing JSON would break
Task 9: complete (commits d4e5f6a..e5f6a7b, review clean)
