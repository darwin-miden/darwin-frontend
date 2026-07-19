/**
 * EIP-712 typed data proving control of the EVM address that owns an on-chain
 * backup slot. Used to authenticate writes to /api/backup-write: the browser
 * signs it once, the server recovers the signer and checks it maps to the
 * (suffix, prefix) slot being written.
 *
 * ISOMORPHIC + pure (no browser/Node APIs): the client signs it and the route
 * reconstructs the exact same struct to recover the address — they MUST agree
 * byte-for-byte, so this lives in one shared module.
 *
 * DISTINCT domain from both the wallet-derivation and the encrypted-backup-key
 * signatures, so this signature is a pure ownership proof: it never derives any
 * key, and forwarding it to the server leaks nothing beyond "this address
 * authorized backups" (the address→slot mapping is already public). It carries
 * no nonce, so it's deterministic and cacheable (one prompt per device); replay
 * protection reduces to TLS + the trusted operator host, which is acceptable on
 * testnet. A future hardening can add a server challenge for freshness.
 */
export function backupAuthTypedData(evmAddress: `0x${string}`) {
  return {
    domain: { name: "Darwin Backup Auth", version: "1" },
    types: {
      DarwinBackupAuth: [
        { name: "purpose", type: "string" },
        { name: "account", type: "address" },
      ],
    },
    primaryType: "DarwinBackupAuth" as const,
    message: {
      purpose: "Authorize on-chain encrypted backups of your Darwin wallet",
      account: evmAddress,
    },
  } as const;
}
