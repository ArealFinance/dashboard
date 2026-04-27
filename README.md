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

### IDL regeneration (R57 — Layer 10 critical path)

`src/lib/idl/native-dex.json` currently lacks the 9 Layer 9 Nexus
instructions (`initialize_nexus`, `update_nexus_manager`, `nexus_swap`,
`nexus_add_liquidity`, `nexus_remove_liquidity`, `nexus_deposit`,
`nexus_record_deposit`, `nexus_withdraw_profits`, `nexus_claim_rewards`)
plus `claim_lp_fees`. The bootstrap reads this IDL via arlex-client; until
it is regenerated, the bootstrap's `phaseNexus` records the missing ix in
`init_skipped[]` and Substep 13 E2E for Nexus paths is gated.

Regen procedure:

```bash
# In the contracts/ submodule:
cd contracts
cargo build-sbf

# Use the Arlex IDL extractor (or anchor idl parse equivalent) to dump the
# updated native-dex IDL JSON and replace the dashboard copy:
arlex idl extract \
  --program native-dex \
  --output ../dashboard/src/lib/idl/native-dex.json
```

After regen:

1. `npm run build` in `dashboard/`.
2. Re-run `scripts/e2e-bootstrap.sh` and verify `init_skipped[]` no longer
   contains `DEX::initialize_nexus`.
3. Remove the `ixExists` precondition skip in `scripts/lib/bootstrap-init.ts`
   `phaseNexus` (R57 closure step 3).

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
