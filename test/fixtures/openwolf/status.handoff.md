---
description: session handoff, regenerate with /handoff when a quest finishes
budget_tokens: 1000
---
# STATUS — Example Shop

> Single source of truth for resuming work. Read this FIRST when starting a session.
> Last updated: 2031-04-02

---

## ✅ Done

- Checkout: webhook handler made idempotent (lib/pay/webhook.ts).
- SHOP-12 split into SHOP-12a and SHOP-12b.

## 🚀 Next quest

**Goal:** finish refund flow for SHOP-31.

### Open decisions
- Partial refunds in scope for SHOP-31? (ask product owner)

---

## Context

- Branch dev is 3 commits ahead of origin.
<!-- plangraph:card:begin -->
plangraph: sprint 4 | ready 6 | blocked 2 | stale 1 | open-items due 3 | plan a1b2c3d4
<!-- plangraph:card:end -->
