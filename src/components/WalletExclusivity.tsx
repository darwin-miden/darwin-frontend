"use client";

/**
 * Enforces one connected wallet at a time. The two rails (ETH self-custody and
 * native MidenFi) address different identities, so having both connected makes
 * the portfolio ambiguous — connecting one drops the other.
 *
 * The wallet that JUST connected wins: whichever transitioned false→true is
 * kept, and the one that was already connected is disconnected. Renders null;
 * mounted only under the MidenFi signer provider (so useMidenFiWallet is safe).
 */

import { useEffect, useRef } from "react";
import { useAccount, useDisconnect } from "wagmi";
import { useMidenFiWallet } from "@miden-sdk/miden-wallet-adapter-react";

export function WalletExclusivity() {
  const { isConnected: ethConnected } = useAccount();
  const { disconnect: disconnectEth } = useDisconnect();
  const { connected: midenConnected, disconnect: disconnectMiden } =
    useMidenFiWallet();

  const prev = useRef({ eth: false, miden: false });

  useEffect(() => {
    const p = prev.current;
    if (ethConnected && midenConnected) {
      if (!p.eth && p.miden) {
        // ETH just connected while Miden was already on → drop Miden.
        void disconnectMiden?.();
      } else if (!p.miden && p.eth) {
        // Miden just connected while ETH was already on → drop ETH.
        disconnectEth();
      } else {
        // Both appeared connected in the same tick (e.g. a reload with two
        // stale sessions) — keep ETH, the primary rail, and drop Miden.
        void disconnectMiden?.();
      }
    }
    prev.current = { eth: ethConnected, miden: midenConnected };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ethConnected, midenConnected]);

  return null;
}
