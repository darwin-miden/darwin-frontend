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
# Copy .env.example to .env.local — the defaults assume a local
# stack (relay on :8090, 1Click mock on :8080). Override the URLs
# for a hosted deployment.
cp .env.example .env.local

# (optional) build the pragma_prices_json binary so /api/prices
# can serve on-chain Pragma medians instead of falling back to
# CoinGecko. From the workspace parent of this repo:
#   cargo build --release --features pragma-live \
#     -p darwin-protocol-account --bin pragma_prices_json
# then set DARWIN_PRAGMA_BIN in .env.local to the absolute path.

npm install
npx next dev -p 3010   # match the Playwright baseURL
```

Tests:

```bash
npx tsc --noEmit
npx playwright test                              # default: public-surface
DARWIN_SCREENSHOT_OUT=/tmp/shots \
  npx playwright test e2e/screenshots.spec.ts    # opt-in docs refresh
npx playwright test e2e/debug-console.spec.ts    # opt-in console audit
```

The default Playwright suite is `e2e/public-surface.spec.ts` —
covers landing, basket list, basket detail with NAV chart + live
NAV under 200 ms, portfolio scaffolding, and `/api/nav` +
`/api/nav-history`. Wallet-required flows (deposit, redeem, Bali
claim) are out of scope here; they're exercised end-to-end via
the relay's stress harness in `darwin-relay/scripts/stress_test.sh`
and the manual demo scripts in `darwin-infra/scripts/`.

## License

MIT.
