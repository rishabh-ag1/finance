# Finance App

Entelechy Labs finance app (Bloc). Same stack and layout as Bloc's `crm/`: `backend/` (Express 5 + Prisma, Postgres schema `finance`) and `frontend/` (React 19 + Vite). Standing rules for building it: `CLAUDE.md`. What it does: `docs/`.

## First-time setup (Windows, local Postgres)

1. **Postgres 17 running on port 5432.** Create two empty databases, for example with pgAdmin: `entelechy_finance` (the app) and `entelechy_finance_test` (wiped by the tests).
2. **Backend settings**: `backend/.env` was created from `.env.example` with a generated `JWT_SECRET` and a first password in `SEED_ADMIN_PASSWORD`. Replace `CHANGE_ME` in `DATABASE_URL` and `DATABASE_URL_TEST` with your Postgres password.
3. **Database and first users**:
   ```bash
   cd finance/backend
   npm install
   npm run db:sync
   npm run db:seed
   ```
4. **Run**, in two terminals:
   ```bash
   cd finance/backend && npm run dev     # http://localhost:3100
   cd finance/frontend && npm run dev    # http://localhost:5174
   ```
   (`frontend/.env` holds `VITE_API_URL=http://localhost:3100/api`.)
5. Sign in as rishabh@ or arnav@blocinsects.com with the `SEED_ADMIN_PASSWORD` from `backend/.env`, then change it on **Your account**.

## Tests

```bash
cd finance/backend && npm test
```
Business rules (`tests/rules/BR-xx.test.ts`) and acceptance checks A1-A12 (`tests/acceptance/`). Database tests run only when `DATABASE_URL_TEST` is set.

## Spec ↔ Google Sheet

`npm install` here (in `finance/`), then `npm run spec:check` (dry run), `npm run spec:sync`, `npm run spec:pull-answers`. The pre-commit hook (`.githooks/` at the repo root) is enabled with `npm run hooks:install`.
