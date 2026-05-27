# darwin-frontend

Next.js 15 frontend for [Darwin Protocol](https://github.com/darwin-miden).
Public surface lives at `darwin.xyz` (DNS pending); the doc site
[`darwin-miden.github.io/darwin-docs`](https://darwin-miden.github.io/darwin-docs/)
walks through the full UX with the live tx hashes captured during
verification.

## What it does

The app is the user-facing entry point to Darwin's confidential
basket protocol on Miden. Routes a reviewer will hit:

| Route | Purpose |
|---|---|
| `/` | landing |
| `/baskets` | browser — DCC, DAG, DCO listed |
| `/baskets/[symbol]` | basket detail: live NAV via Pragma, 30-day history chart, deposit panel with two tabs (1Click + Miden-native) |
| `/portfolio` | the wallet-aware surface: positions, on-chain reads, redeem button, Bali bridge (L1↔L2), bridge claim, self-custody |
| `/flows` | flow A/B/C narrative for the proposal |
| `/api/prices` | Pragma testnet prices, 15s warm cache, per-pair CoinGecko fallback for clearly-broken publishers |
| `/api/nav` | basket target NAV — Σ weight × price (the "<200ms NAV calc" claim, p99 = 24 ms measured) |
| `/api/nav-history` | 30-day NAV curve per basket |

## The user-visible bridge surface

Three deposit modes (inbound) and two outbound stages, all live
on testnet:

- **`OneClickDepositPanel`** — 1Click via relay v2 (broker UX,
  ~70s round-trip)
- **`MidenDepositPanel`** — direct P2ID note from MidenFi wallet
- **`BaliDepositPanel`** — canonical AggLayer `bridgeAsset(76, …)`
  on Sepolia (~25-30 min, trustless)
- **`RedeemPanel`** — triggers the relay v2 worker's burn +
  canonical B2AGG outbound
- **`BaliClaimPanel`** — fetches the merkle proof, calls
  `claimAsset` on Sepolia to release the bridged ETH

## Develop

```bash
# .env.local should set DARWIN_PRAGMA_BIN pointing at the
# pragma_prices_json binary from darwin-protocol — without it
# the /api/prices route falls back to CoinGecko-only.
npm install
npx next dev -p 3010   # match the Playwright baseURL
```

Tests:

```bash
npx tsc --noEmit
npx playwright test
```

The Playwright suite is in `e2e/public-surface.spec.ts` and
covers landing, basket list, basket detail with NAV chart + live
NAV figure under 200 ms, portfolio scaffolding, and the
`/api/nav` + `/api/nav-history` endpoints. 10/10 expected.

## License

MIT.
