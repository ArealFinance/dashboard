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
