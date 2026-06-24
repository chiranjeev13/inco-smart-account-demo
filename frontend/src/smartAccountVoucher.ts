/**
 * Smart Account + EOA Voucher Decryption Flow
 *
 * This module demonstrates how to decrypt Inco handles when:
 * - The handle is owned by a Smart Account (ERC-4337, Safe, etc.)
 * - Decryption needs to happen via an EOA (for covalidator compatibility)
 *
 * The voucher system bridges smart accounts to EOA-based decryption.
 */

import { Lightning, generateXwingKeypair } from "@inco/lightning-js/lite";
import { type HexString } from "@inco/lightning-js";
import { generatePrivateKey, privateKeyToAccount, type PrivateKeyAccount } from "viem/accounts";
import { type WalletClient, pad, toHex, bytesToHex, type PublicClient } from "viem";

// ─── Constants ──────────────────────────────────────────────────

/** Default session verifier contract on Base Sepolia */
export const DEFAULT_SESSION_VERIFIER = "0xc34569efc25901bdd6b652164a2c8a7228b23005" as const;

/** Default voucher expiry: 1 hour */
export const DEFAULT_EXPIRY_MS = 3600000;

// ─── Types ──────────────────────────────────────────────────────

export type IncoInstance = Awaited<ReturnType<typeof Lightning.baseSepoliaTestnet>>;

export interface VoucherSession {
  /** The ephemeral EOA that will perform decryption */
  ephemeralAccount: PrivateKeyAccount;
  /** The voucher authorizing the EOA */
  voucher: any; // Voucher type from SDK
  /** X-Wing keypair for reencryption */
  reencryptKeypair: Awaited<ReturnType<typeof generateXwingKeypair>>;
  /** When the voucher expires */
  expiresAt: Date;
}

export interface DecryptResult {
  handle: HexString;
  value: bigint | boolean;
  signatures: `0x${string}`[];
  attestation: {
    handle: HexString;
    value: `0x${string}`;
  };
}

// ─── Core Functions ─────────────────────────────────────────────

/**
 * Initialize Lightning SDK singleton
 */
let _zapPromise: Promise<IncoInstance> | null = null;

export async function getZap(network: "testnet" | "mainnet" | "local" = "mainnet"): Promise<IncoInstance> {
  if (!_zapPromise) {
    switch (network) {
      case "testnet":
        _zapPromise = Lightning.baseSepoliaTestnet();
        break;
      case "local":
        _zapPromise = Lightning.localNode("mainnet");
        break;
      default:
        _zapPromise = Lightning.baseMainnet();
    }
  }
  return _zapPromise;
}

/**
 * Create a voucher session from a Smart Account
 *
 * The smart account signs a voucher that authorizes an ephemeral EOA
 * to decrypt handles on its behalf.
 *
 * @param smartAccountWalletClient - Wallet client for the smart account (viem supports smart accounts)
 * @param expiryMs - How long the voucher is valid (default: 1 hour)
 * @param sessionVerifier - Session verifier contract address
 * @returns VoucherSession containing ephemeral EOA, voucher, and keypair
 *
 * @example
 * ```typescript
 * // Using with a smart account (e.g., Safe, ERC-4337)
 * const session = await createVoucherSession(
 *   smartAccountWalletClient,
 *   3600000, // 1 hour
 * );
 * ```
 */
export async function createVoucherSession(
  smartAccountWalletClient: WalletClient,
  expiryMs: number = DEFAULT_EXPIRY_MS,
  sessionVerifier: `0x${string}` = DEFAULT_SESSION_VERIFIER,
): Promise<VoucherSession> {
  const zap = await getZap();

  // 1. Generate ephemeral EOA for decryption
  const ephemeralAccount = privateKeyToAccount(generatePrivateKey());

  // 2. Generate X-Wing keypair for reencryption (post-quantum)
  const reencryptKeypair = await generateXwingKeypair();

  // 3. Calculate expiry
  const expiresAt = new Date(Date.now() + expiryMs);

  // 4. Smart account signs voucher granting decryption rights to EOA
  const voucher = await zap.grantSessionKeyAllowanceVoucher(
    smartAccountWalletClient,
    ephemeralAccount.address,
    expiresAt,
    sessionVerifier,
  );

  return {
    ephemeralAccount,
    voucher,
    reencryptKeypair,
    expiresAt,
  };
}

/**
 * Decrypt handles using a voucher session
 *
 * The EOA uses the voucher to prove it's authorized to decrypt
 * handles owned by the smart account.
 *
 * @param session - VoucherSession from createVoucherSession
 * @param handles - Array of encrypted handle bytes32 values
 * @returns Array of decryption results with plaintexts and attestations
 *
 * @example
 * ```typescript
 * const results = await decryptWithVoucher(session, [balanceHandle]);
 * console.log("Balance:", results[0].value);
 * ```
 */
export async function decryptWithVoucher(
  session: VoucherSession,
  handles: HexString[],
): Promise<DecryptResult[]> {
  const zap = await getZap();

  // EOA decrypts using the voucher - no smart account signature needed
  const results = await zap.attestedDecryptWithVoucher(
    session.ephemeralAccount,
    session.voucher,
    handles,
    {
      reencryptPubKey: session.reencryptKeypair.encodePublicKey(),
      reencryptKeypair: session.reencryptKeypair,
    },
  );

  // Format results for on-chain submission
  return results.map((r: any) => ({
    handle: r.handle,
    value: r.plaintext.value,
    signatures: r.covalidatorSignatures.map((sig: Uint8Array) => bytesToHex(sig)),
    attestation: {
      handle: r.handle,
      value: pad(
        toHex(typeof r.plaintext.value === "boolean" ? (r.plaintext.value ? 1 : 0) : r.plaintext.value),
        { size: 32 },
      ),
    },
  }));
}

/**
 * Revoke all vouchers issued by a smart account
 *
 * Increments the session nonce, invalidating all previously issued vouchers.
 * Call this on logout or when the user wants to revoke delegated access.
 *
 * @param smartAccountWalletClient - Wallet client for the smart account
 */
export async function revokeAllVouchers(smartAccountWalletClient: WalletClient): Promise<void> {
  const zap = await getZap();
  await zap.updateActiveVouchersSessionNonce(smartAccountWalletClient);
}

/**
 * Check if a voucher session is still valid
 */
export function isSessionValid(session: VoucherSession): boolean {
  return new Date() < session.expiresAt;
}

// ─── Complete Example Flow ──────────────────────────────────────

/**
 * Example: Complete smart account -> EOA decryption flow
 *
 * This demonstrates the full pattern for decrypting a handle
 * when the owner is a smart account.
 */
export async function exampleSmartAccountDecrypt(
  smartAccountWalletClient: WalletClient,
  encryptedHandle: HexString,
): Promise<bigint | boolean> {
  // Step 1: Create voucher session (smart account signs once)
  console.log("Creating voucher session...");
  const session = await createVoucherSession(smartAccountWalletClient);
  console.log("Voucher granted to EOA:", session.ephemeralAccount.address);
  console.log("Expires at:", session.expiresAt.toISOString());

  // Step 2: EOA decrypts using voucher (no more signatures needed)
  console.log("Decrypting with voucher...");
  const results = await decryptWithVoucher(session, [encryptedHandle]);

  console.log("Decrypted value:", results[0].value);
  return results[0].value;
}

// ─── Contract Interaction Helpers ───────────────────────────────

/**
 * Format decryption result for submitting attestation on-chain
 */
export function formatForContract(result: DecryptResult): {
  decryption: { handle: HexString; value: `0x${string}` };
  signatures: `0x${string}`[];
} {
  return {
    decryption: result.attestation,
    signatures: result.signatures,
  };
}

/**
 * Get the Inco fee for ciphertext operations
 */
export async function getFee(publicClient: PublicClient): Promise<bigint> {
  const zap = await getZap();

  const fee = await publicClient.readContract({
    address: zap.executorAddress as `0x${string}`,
    abi: [
      {
        inputs: [],
        name: "getFee",
        outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
        stateMutability: "pure",
        type: "function",
      },
    ],
    functionName: "getFee",
  });

  return fee as bigint;
}
