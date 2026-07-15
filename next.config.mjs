/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,

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
      // <script src> from other origins is still blocked.
      "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
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
      [
        "connect-src 'self' blob: data:",
        "https://ethereum-sepolia-rpc.publicnode.com",
        "https://ethereum-rpc.publicnode.com",
        "https://*.miden.io",
        "https://faucet.testnet.miden.io",
        "https://testnet-dev.epochprotocol.xyz",
        "https://miden-testnet-bridge.dev.eu-north-3.gateway.fm",
        "https://api.coingecko.com",
        "wss://relay.walletconnect.com",
        "https://*.walletconnect.com",
        "https://*.walletconnect.org",
        "https://*.reown.com",
      ].join(" "),
      "upgrade-insecure-requests",
    ].join("; ");

    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
          { key: "Content-Security-Policy", value: csp },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
          {
            key: "Strict-Transport-Security",
            value: "max-age=63072000; includeSubDomains; preload",
          },
        ],
      },
    ];
  },
};

export default nextConfig;
