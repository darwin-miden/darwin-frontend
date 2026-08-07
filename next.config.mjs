/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

  // Optional separate build/dev output dir so `next dev` doesn't clobber the
  // live prod `.next` that launchd's `next start :3010` is serving. Unset in
  // prod (Vercel/launchd) → default `.next`.
  ...(process.env.DARWIN_BUILD_DISTDIR ? { distDir: process.env.DARWIN_BUILD_DISTDIR } : {}),

  // Operator-side (Mac :3010) low-memory build path. The CF tunnel serves
  // ONLY /api/* from the Mac (Vercel serves the public static pages), so on
  // the memory-constrained Mac we skip the RSS-heavy steps — SWC minify,
  // type-check, lint, webpack parallelism — that make a full `next build`
  // spike past jetsam's limit and get SIGKILL'd. Env-gated so Vercel (which
  // must minify + type-check the public build) is unaffected.
  ...(process.env.DARWIN_LOWMEM_BUILD
    ? {
        eslint: { ignoreDuringBuilds: true },
        typescript: { ignoreBuildErrors: true },
        experimental: { cpus: 1, workerThreads: false },
      }
    : {}),

  // The @miden-sdk/miden-sdk package ships large WASM blobs and
  // requires SharedArrayBuffer + Atomics for its multi-threaded prover.
  // We tell Next.js to load .wasm via async imports and set the
  // cross-origin isolation headers needed for SharedArrayBuffer.
  webpack: (config, { isServer }) => {
    config.experiments = {
      ...(config.experiments || {}),
      asyncWebAssembly: true,
      topLevelAwait: true,
      layers: true,
    };
    // Import .masm files as raw source strings so the confidential note scripts
    // can be compiled CLIENT-SIDE (via useCompile) — the first step of moving
    // note-building off the server.
    config.module = config.module || {};
    config.module.rules = config.module.rules || [];
    config.module.rules.push({ test: /\.masm$/, type: "asset/source" });
    // The @getpara SDK references a pile of OPTIONAL peer packages (account-
    // abstraction plugins, non-EVM wallet connectors, Farcaster, React-Native
    // storage, pino-pretty) that we don't install. Their Vite setup tree-shakes
    // these; webpack instead hard-fails "Module not found". Alias each to an
    // empty module so the bundle builds — the Para embedded flow never calls
    // them. NB: enabling MetaMask/Rabby login later means installing
    // @getpara/evm-wallet-connectors and dropping it from this list.
    const paraOptionalStubs = [
      "@farcaster/miniapp-sdk",
      "@farcaster/miniapp-wagmi-connector",
      "@getpara/aa-alchemy",
      "@getpara/aa-biconomy",
      "@getpara/aa-cdp",
      "@getpara/aa-gelato",
      "@getpara/aa-pimlico",
      "@getpara/aa-porto",
      "@getpara/aa-rhinestone",
      "@getpara/aa-safe",
      "@getpara/aa-thirdweb",
      "@getpara/aa-zerodev",
      "@getpara/cosmos-wallet-connectors",
      // @getpara/evm-wallet-connectors is now INSTALLED (MetaMask/Rabby login on
      // /para) — do NOT stub it.
      "@getpara/solana-wallet-connectors",
      "@react-native-async-storage/async-storage",
      "pino-pretty",
    ];
    config.resolve = config.resolve || {};
    config.resolve.alias = {
      ...(config.resolve.alias || {}),
      ...Object.fromEntries(paraOptionalStubs.map((m) => [m, false])),
    };
    // Server bundle has no use for the browser WASM SDK, mark it as
    // external so SSR doesn't try to load it.
    if (isServer) {
      config.externals = [
        ...(config.externals || []),
        "@miden-sdk/miden-sdk",
        "@miden-sdk/react",
        "@miden-sdk/miden-wallet-adapter-react",
        "@miden-sdk/miden-wallet-adapter-miden",
      ];
    }
    // Low-memory operator build: serialise webpack + drop minification so the
    // compile phase's peak RSS stays under jetsam's kill threshold.
    if (process.env.DARWIN_LOWMEM_BUILD) {
      config.parallelism = 1;
      config.optimization = {
        ...(config.optimization || {}),
        minimize: false,
      };
    }
    return config;
  },

  async headers() {
    // Content-Security-Policy. The derived Falcon key lives in the
    // browser, so the last line of defence against an injected script
    // (compromised dep, hostile extension, wallet adapter) exfiltrating
    // it is a tight connect-src: an attacker can inject, but can't POST
    // the key anywhere off this allowlist. The allowlist is every host
    // the app legitimately talks to — Sepolia/mainnet RPC (ENS), the
    // Miden testnet RPC + tx-prover + transport (*.miden.io), Epoch, the
    // bridge, CoinGecko, and WalletConnect (only if a projectId is set).
    // NOTE: if NEXT_PUBLIC_*_RPC_HTTP is overridden to a custom host,
    // add it here too or the browser will block it.
    const csp = [
      "default-src 'self'",
      "base-uri 'none'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "form-action 'self'",
      // 'wasm-unsafe-eval' for the Miden STARK prover; 'unsafe-inline'
      // for Next's hydration bootstrap (no nonce pipeline here). External
      // <script src> from other origins is still blocked. In DEV only,
      // 'unsafe-eval' is added because `next dev`'s React-Refresh/HMR wraps
      // modules in eval() — without it nothing hydrates locally. Production
      // builds emit no eval, so the shipped CSP stays strict (no unsafe-eval).
      `script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'${
        process.env.NODE_ENV === "development" ? " 'unsafe-eval'" : ""
      }`,
      "style-src 'self' 'unsafe-inline'",
      // No blanket `https:` on img-src: connect-src is the exfil
      // allowlist, but a blanket image host would let an injected script
      // beacon the browser-held Falcon key out via `new Image().src=...`.
      // The app loads zero external https images, so this costs nothing.
      "img-src 'self' data:",
      "font-src 'self' data:",
      // The prover spawns Web Workers from blob: URLs.
      "worker-src 'self' blob:",
      "child-src 'self' blob:",
      // Para renders its auth / MPC flow inside a cross-origin iframe served
      // from app.beta.getpara.com (prod: app.getpara.com). frame-src must allow
      // it or the /para login modal can't advance past the email step.
      "frame-src 'self' blob: https://*.getpara.com https://*.usecapsule.com",
      [
        "connect-src 'self' blob: data:",
        "https://ethereum-sepolia-rpc.publicnode.com",
        "https://ethereum-rpc.publicnode.com",
        "https://*.miden.io",
        "https://faucet.testnet.miden.io",
        "https://testnet-dev.epochprotocol.xyz",
        // The Epoch SDK hardcodes this thirdweb RPC for its Sepolia
        // contract reads (getForcedWithdrawalStatus etc.); without it the
        // browser blocks the read and every deposit fails "Failed to fetch".
        "https://11155111.rpc.thirdweb.com",
        "https://miden-testnet-bridge.dev.eu-north-3.gateway.fm",
        "https://api.coingecko.com",
        "wss://relay.walletconnect.com",
        "https://*.walletconnect.com",
        "https://*.walletconnect.org",
        "https://*.reown.com",
        // Para (getpara) embedded-wallet API + MPC network for the /para route.
        // usecapsule.com is Para's legacy domain still used by some endpoints.
        "https://*.getpara.com",
        "wss://*.getpara.com",
        "https://*.usecapsule.com",
        "wss://*.usecapsule.com",
      ].join(" "),
      "upgrade-insecure-requests",
    ].join("; ");

    return [
      {
        // Baseline security headers on every route.
        source: "/(.*)",
        headers: [
          // Content-Security-Policy is now set PER-REQUEST in src/middleware.ts (nonce-
          // based script-src, replacing 'unsafe-inline'). Setting it here too would emit a
          // duplicate/older header, so it's intentionally omitted from the static headers.
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
      {
        // Cross-origin isolation (COOP + COEP) — required by the Miden LOCAL
        // multi-threaded STARK prover's SharedArrayBuffer. Applied to every
        // route EXCEPT /para: Para's auth runs in a cross-origin iframe
        // (app.getpara.com/auth/otp) that is ERR_BLOCKED_BY_RESPONSE under COEP.
        // /para instead uses a REMOTE prover (see ParaProviders.tsx), so it
        // needs no SAB and can safely drop isolation. NB: reach /para via a full
        // page load — a client-side nav keeps the previous document's COEP.
        source: "/((?!para).*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          {
            key: "Cross-Origin-Embedder-Policy",
            // `require-corp` (prod) is broadest for SharedArrayBuffer, but it
            // blocks the cross-origin dev runtime (`next dev` HMR/react-refresh)
            // → blank page in dev. `credentialless` still enables SAB in
            // Chromium while letting the dev runtime load. Prod stays require-corp.
            value:
              process.env.NODE_ENV === "development"
                ? "credentialless"
                : "require-corp",
          },
        ],
      },
      {
        // /para gets NO COEP (Para's cross-origin auth iframe is blocked under
        // it) but DOES get COOP `same-origin-allow-popups`: Para's Google/X
        // OAuth opens a popup and monitors it via `window.closed`. With COOP
        // unset (default), that read is severed ("COOP would block the
        // window.closed call") → Para hangs on AwaitingAccountSetup → the Miden
        // account never finalizes. `same-origin-allow-popups` keeps the opener
        // ↔ popup relationship so the OAuth flow can complete.
        source: "/para",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin-allow-popups" },
        ],
      },
    ];
  },
};

export default nextConfig;
