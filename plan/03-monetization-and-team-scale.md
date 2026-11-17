# Plan 03 — Team Scale, Deployment & Monetization Architecture

## 1. Deployment Strategy (Best Free & Edge Options)

### Primary Recommendation: Cloudflare Workers + D1/Turso (Best Free Production Option)
- **Quota**: 100,000 free requests/day, near-zero cold starts, global edge PoPs.
- **Why it fits TasteCaliber**: MCP coding agents hit `/mcp` multiple times per session. Cloudflare Workers isolates handle stateless Streamable HTTP JSON-RPC (`POST /mcp`) cleanly without paying for idle containers.
- **Storage Adapter Path**: Local `node:sqlite` for single-developer stdio/localhost -> Cloudflare D1 / Turso libSQL for multi-user remote HTTP.

### Alternative: Vercel Functions (Ideal for Next.js / Hobby Teams)
- Automatic preview deployments, instant rollbacks, free Hobby tier, paired with Neon/Turso for remote persistence.

### Local Hybrid Mode (Current Default)
- Dual transport: `npx tsx mcp-stdio.ts` (zero-latency local stdio) + `tsx server.ts` (`http://localhost:3000/mcp`) sharing WAL-mode SQLite (`data/taste.db`).

---

## 3. Open-Core Commercialization & Pricing Tiers

TasteCaliber sells **two measurable ROI pillars** to engineering leaders:
1. **20–30% lower coding agent LLM spend** (via budgeted context injection, verified micro-skills, and loop intervention).
2. **Senior-level consistency across every AI PR** (zero repeated review nitpicks across OpenCode, Claude Code, and Cursor).

| Tier | Price | Target | Capabilities |
| :--- | :--- | :--- | :--- |
| **Solo Local (Open Core)** | **$0** (Apache-2.0) | Individual devs | Local SQLite WAL, Stdio + HTTP MCP, `taste-1` classifier, BYO Ollama/NVIDIA NIM/OpenRouter, Micro-Skills & Economics telemetry |
| **Team Taste Hub** | **$19 / active dev / month** | Startups & Eng Teams (5–100 devs) | Hosted Cloudflare/Cloud remote MCP, shared Team Meta-RL aggregation, lead-engineer conflict resolution RBAC, GitHub PR Review Bot & CI Taste Gate |
| **Enterprise VPC** | **Custom ($1,500+/mo)** | Regulated Orgs (FinTech, HealthTech) | Self-hosted Kubernetes/Docker Helm chart, SSO/SAML, immutable SOC2 audit log of agent rule adherence, air-gapped NVIDIA NIM enterprise inference, curated compliance packs |

---

## 4. High-Leverage Team Expansion Milestones (Phase 3)
1. **Org & Repo Scoping (`org/repo` hierarchy)**:
   - Inherit `Org Policy -> Team Framework -> Repo Micro-Skills -> Personal Style`, resolving overrides deterministically.
2. **Team Meta-RL Aggregation**:
   - Weight reinforcement signals by contributor role (Staff/Maintainer approvals carry higher Bayesian weight than automated bot feedback).
3. **CI/CD Taste Gate & GitHub App**:
   - Run deterministic diff checks in GitHub Actions against enforced `taste.md` rules and auto-feed PR review comments back into TasteCaliber signals.
4. **Curated Rule & Micro-Skill Marketplace**:
   - Verified packs for HIPAA security hygiene, PCI-DSS logging redaction, Next.js App Router performance, and Drizzle/SQLite reliability (revenue-share or Pro bundle).
