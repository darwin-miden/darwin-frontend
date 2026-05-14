# darwin-frontend

Next.js 15 frontend for [Darwin Protocol](https://github.com/darwin-miden) at `darwin.xyz`. Ships with Milestone 3 of the Darwin x Miden grant.

## Status

Scaffold only. The `src/app/page.tsx` currently renders a "coming soon" placeholder; the production UI (basket browser, deposit/redeem flow, portfolio dashboard, client-side proving via the Miden Web SDK) lands as part of M3.

## Layout

```
darwin-frontend/
├── package.json
├── tsconfig.json
├── next.config.js
└── src/
    ├── app/
    │   ├── layout.tsx
    │   └── page.tsx
    └── lib/
```

## Develop

```bash
npm install
npm run dev          # local server at http://localhost:3000
npm run type-check
npm run lint
npm run build
```

## License

MIT.
