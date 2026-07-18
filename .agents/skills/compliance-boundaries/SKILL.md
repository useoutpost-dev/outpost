---
name: compliance-boundaries
description: Anthropic ToS boundaries for Outpost. MUST be checked for any feature touching accounts, auth, hosting, or billing.
---

# Compliance Boundaries

## The line
- SELF-HOSTED Outpost, user's own infra, user's own Codex subscription/API key: OK.
- Outpost-owned HOSTED service brokering other users' SUBSCRIPTION OAuth: NOT OK,
  at any price, even "platform fee only".
- Hosted multi-tenant version: API-key based or metered billing through our own API
  account only. Separate product, separate repo, not in core.

## Feature review questions (all must be "no")
1. Does credential material for someone other than the instance owner touch infra we run?
2. Does any flow encourage sharing one subscription across people?
3. Does the platform sit between a third party's subscription and Anthropic?

## Naming
- Product name: "Outpost". Anthropic marks only descriptively: "Outpost — for Codex".
  Never "Codex Outpost" in public branding.

## Process
- `security-auditor` enforces this file. Any BLOCK here overrides feature priority.
- Terms change. Before monetizing: human re-reads current Anthropic usage policy.
