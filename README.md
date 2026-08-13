# Polymesh Staking Analytics

**<https://f-obrien.github.io/polymesh-staking-analytics/>**

Staking analytics for the [Polymesh](https://polymesh.network/) blockchain: what
the network pays, how every operator is performing, and what one address has
actually earned.

A community project. Not affiliated with Polymesh Labs, and not financial
advice.

---

## What it does

- **Network** — return after commission, inflation against the fixed yearly
  reward, stake, participation and decentralisation, over the chain's whole
  history.
- **Operators** — every validator, with three return figures that each say which
  period they cover, plus commission, self-stake, steadiness, reliability and
  block production measured against what the authorship lottery predicts.
- **My staking** — paste any address, or connect a wallet. Bonded and unbonding
  amounts, which operators the stake is actually behind, every payout it has
  received, and whether the choice of operators has been worth anything.
- **Calculator** — projected rewards for an amount and an operator, based on
  that operator's measured history rather than a headline rate.
- **Slashing** — every offence the chain has reported, what it cost, and what a
  penalty would cost if one were applied.

Read-only throughout. Nothing here asks you to sign a transaction.

## How it works

The site is a static export served from GitHub Pages. It reads pre-computed
JSON rather than pulling the chain's history into every visitor's browser, which
is what makes a five-year range load in a few kilobytes.

| Tier | Source | Freshness |
| --- | --- | --- |
| Era history | `data` branch, one immutable file per 32 eras | daily, when an era completes |
| Snapshot | `latest.json` | every 15 minutes |
| Derived | computed in the browser from the two above | instant |
| Live | optional WebSocket to a public RPC node | per block, opt-in |

Two scheduled workflows write to the orphan `data` branch and trigger a
redeploy. Chunk URLs carry a content hash, so a completed era's data is cached
permanently and a revised one can never be served under the old name.

Every figure comes from public chain data or the public indexer. The
[methodology page](https://f-obrien.github.io/polymesh-staking-analytics/about/)
sets out each formula, including the reward curve constants, the inflation cap
and how the commission-weighted average is taken.

## Running it locally

Requires Node 22 or later.

```bash
npm ci
npm run fixtures   # synthetic data, if you have no ingested data yet
npm run dev        # http://localhost:3005/polymesh-staking-analytics/
```

`public/data` is gitignored. `npm run fixtures` writes a deterministic synthetic
dataset there; it refuses to overwrite real ingested data. To work against
mainnet instead, check out the `data` branch into that directory:

```bash
git clone --branch data --single-branch \
  https://github.com/F-OBrien/polymesh-staking-analytics.git public/data
```

### Checks

```bash
npm run format:check && npm run check && npm run knip && npm run build && npm run budget && npm run assert:lazy
```

`check` is typecheck, lint and tests. `budget` enforces a 200 KB gzipped
per-route JavaScript limit, and `assert:lazy` proves the Polkadot stack is not
loaded until a wallet is connected — both read `out/`, so they need a build
first.

### Data pipeline

```bash
npm run ingest:era        # the completed era, plus latest.json and the rollup
npm run ingest:latest     # the 15-minute snapshot only
npm run ingest:offences   # reported offences, from the indexer
npm run ingest:backfill   # history older than the chain's retention window
```

`scripts/probe/` holds read-only scripts that check assumptions against live
mainnet. Every one of them has found a bug that code review did not — if you
write anything chain-facing here, run it against the chain before believing it.

## Documentation

- [`docs/REBUILD-DESIGN.md`](docs/REBUILD-DESIGN.md) — the design contract:
  audiences, information architecture, chart catalogue, data tiers, budgets.
- [`docs/STATUS.md`](docs/STATUS.md) — working notes: what is done, what is
  outstanding, and the mistakes worth not repeating.

## Stack

Next.js (App Router, `output: export`), TypeScript in strict mode, Tailwind,
TanStack Query, Zod, and charts rendered as SVG from d3 submodules — no chart
library.

## Licence

[Apache-2.0](LICENSE).

Chosen over MIT for two things it adds: an express patent grant, and a
requirement that modified files say they have been changed. This is a dashboard
people may use to decide where to stake, so a fork being identifiable as a fork
matters more here than the extra paragraph costs.

Nothing in the licence conveys rights in the Polymesh name or marks. This is a
community project and is not affiliated with Polymesh Labs.
