# Areal Finance — Dashboard

Admin and monitoring dashboard for the [Areal Finance](https://areal.finance) protocol. SvelteKit, TypeScript, `@sveltejs/adapter-static`. Serves the five on-chain programs:

- **Ownership Token** — projects, revenue destinations, treasury, governance
- **Futarchy** — proposals, approve/execute, config
- **RWT Engine** — vault, NAV, mint, admin swaps (`vault_swap`)
- **Native DEX** — pools (StandardCurve + concentrated), swap, LP
- **Yield Distribution** — distributors, accumulator, Merkle claims

Plus an **E2E scenario runner** at `/dev/e2e` that reproduces full end-to-end flows (persists state across pages, handles idempotent initialisation).

Production: **https://panel.areal.finance**

## Requirements

- Node.js ≥ 22.17
- npm ≥ 10

## Develop

```bash
npm install
npm run dev       # http://localhost:5173
```

## Build

```bash
npm run build     # → build/  (static, SPA fallback)
```

## Deploy

Static assets, so any static host works. Included script uses `rsync`:

```bash
cp .env.example .env
# edit DEPLOY_HOST, DEPLOY_PATH
bash scripts/deploy.sh
```

Nginx snippet for self-hosting:

```nginx
server {
    listen 80;
    server_name panel.example.com;
    root /var/www/panel.example.com;
    index index.html;

    location / {
        try_files $uri $uri.html $uri/ /index.html;
    }

    location /_app {
        expires 1y;
        add_header Cache-Control "public, immutable";
    }
}
```

## Layer 10 status (2026-04-29)

The dashboard ships frozen for Layer 10 — alongside the Layer 9 Nexus surfaces it
already exposed, the System Overview surface (Substep 9) and the master E2E
artifact viewer landed.

## System Overview (Layer 10 Substep 9)

The `/` route renders 8 sections in a single read-only operator dashboard:

1. **SystemHealth** — overall validator + RPC + bot fleet status (embeds the
   per-bot heartbeats from `BotHeartbeats`).
2. **AuthorityChain** — POSITIVE + NEGATIVE deployer-zero-authority audit
   verdicts per contract (OT, Futarchy, RWT, DEX, YD).
3. **TokenMetrics** — RWT / ARL OT / per-OT supply, NAV, treasury balance.
4. **RevenueFlowOverview** — distribute → convert → publish → claim pipeline
   throughput and last-success timestamps.
5. **DexPoolsOverview** — pool list, reserves, last shift_bins, last
   compound_yield.
6. **NexusOverview** — Nexus principal floor, manager pubkey, kill-switch
   indicator, last action.
7. **RecentEvents** — 2 s tick of program logs across the 5 contracts.
8. **Alerts** — staleness alerts (bot below `BOT_STALE_THRESHOLD_MS`,
   crank wallet below `LOW_SOL_THRESHOLD_LAMPORTS`).

Cards refresh on a 1 s tick (`PUBLIC_DASHBOARD_CARD_INTERVAL_MS`); the events
ticker refreshes at 2 s.

A master E2E artifact viewer lives at `/dev/master`. The static SPA cannot
spawn `tsx`, so the viewer is a paste-or-upload of `e2e-runner-*.json` files
from the `data/` directory of a deploy host. Operators copy the artifact into
the textarea or upload it; the viewer renders the same shape the runner
emits server-side.

### New env vars

| Variable | Purpose |
|---|---|
| `PUBLIC_DASHBOARD_BOT_STALE_THRESHOLD_MS` | Time-without-heartbeat before a bot row marks `stale` |
| `PUBLIC_DASHBOARD_LOW_SOL_THRESHOLD_LAMPORTS` | Crank wallet balance threshold for the Alerts card |
| `PUBLIC_DASHBOARD_CARD_INTERVAL_MS` | Card-tick cadence (default 1000) |

See `.env.example` for the full default set.

## Release checklist (Layer 9)

Before tagging a Layer 9 dashboard release, confirm the following env-driven
constants are populated for the target deployment:

| Variable | Purpose | Required by |
|---|---|---|
| `PUBLIC_USDC_MINT` | USDC mint addr for Nexus deposit / withdraw flows + convert path | `/nexus/`, `/layer8/convert/` |
| `PUBLIC_RWT_USDC_POOL` | Master RWT/USDC pool PDA — drives the convert-to-rwt route resolver | `/layer8/convert/` |
| `PUBLIC_NEXUS_MANAGER_BOT_URL` | Heartbeat endpoint for the nexus-manager bot panel (4th panel on `/bots/`) | `/bots/` |

The static build inlines these at compile time; changing them requires a
rebuild + redeploy.

> **Mainnet policy** (Substep 15 sec L-1 + SD-20): operator MUST override
> `PUBLIC_USDC_MINT` for mainnet deployments. Do **not** ship a build
> where this var resolves to the SD-20 devnet test-mint fallback —
> dashboard would silently route convert/deposit flows to a worthless
> mint. Same applies to `PUBLIC_RWT_USDC_POOL`: a canonical-PDA
> auto-derive is OK for devnet (per SD-21) but mainnet must pin the
> deployed master-pool address explicitly. CI release pipelines should
> assert `process.env.NETWORK !== 'mainnet' || PUBLIC_USDC_MINT !== <devnet>`
> before publishing.

## Dependencies

- IDL files are checked into `src/lib/idl/*.json` (copied from [ArealFinance/contracts](https://github.com/ArealFinance/contracts)).
- Uses [`@arlex/client`](https://github.com/ArealFinance/arlex/tree/main/client) for tx building and account decoding.
- Solana wallet adapter + Web3.js for wallet and RPC.

## Related

- **Contracts:** [ArealFinance/contracts](https://github.com/ArealFinance/contracts)
- **Off-chain services:** [ArealFinance/bots](https://github.com/ArealFinance/bots)
- **Framework:** [ArealFinance/arlex](https://github.com/ArealFinance/arlex)
- **Full protocol:** [ArealFinance/areal](https://github.com/ArealFinance/areal)

## License

Apache-2.0 — see [LICENSE](./LICENSE) and [NOTICE](./NOTICE).
