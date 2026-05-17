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
    return [
      {
        source: "/(.*)",
        headers: [
          { key: "Cross-Origin-Opener-Policy", value: "same-origin" },
          { key: "Cross-Origin-Embedder-Policy", value: "require-corp" },
        ],
      },
    ];
  },
};

export default nextConfig;
