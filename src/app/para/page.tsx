"use client";

/**
 * /para — isolated Para wallet onboarding. Additive: the existing MetaMask
 * flow is untouched. The Para providers boot their own Miden WASM client, so
 * this route is excluded from the root MidenContextProvider (see Providers.tsx)
 * and the whole subtree is loaded ssr:false to keep WASM off the server.
 */

import dynamic from "next/dynamic";

const ParaApp = dynamic(() => import("../../components/para/ParaApp"), {
  ssr: false,
  loading: () => (
    <main className="flex min-h-[80vh] items-center justify-center text-white/50">
      Loading Para…
    </main>
  ),
});

export default function ParaPage() {
  return <ParaApp />;
}
