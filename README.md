# Entelechy Finance

Finance app for Entelechy Labs Private Limited (brand: Bloc). Everything lives in `finance/`, laid out like the Bloc monorepo (`crm/backend`, `crm/frontend`) so the folder can move into Bloc as `finance/` unchanged.

| Path | What |
|---|---|
| `finance/CLAUDE.md` | Standing instructions: stack, money/tax rules, spec-sync rule |
| `finance/docs/` | Spec, business rules, open questions, changelog, Phase 1 plan |
| `finance/backend/` | Express 5 + TypeScript + Prisma (Postgres schema `finance`) |
| `finance/frontend/` | React 19 + Vite 7 + Tailwind 4 + TanStack Query |
| `finance/data/fixtures/` | Real IDFC rows and Master Ledger, used by the acceptance checks |
| `finance/scripts/` | Spec ↔ Google Sheet sync |

Setup and commands: see `finance/README.md`.
