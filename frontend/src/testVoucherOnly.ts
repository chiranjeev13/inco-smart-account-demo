/**
 * Test: Voucher Flow Only (No Contract Deployment Needed)
 *
 * This script tests just the voucher creation and decryption flow
 * using an existing handle or a test encryption.
 *
 * Run with: npx ts-node --transpile-only src/testVoucherOnly.ts
 */

import { createWalletClient, createPublicClient, http } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { Lightning, generateXwingKeypair } from "@inco/lightning-js/lite";
import { handleTypes, type HexString } from "@inco/lightning-js";

// ─── Configuration ──────────────────────────────────────────────

const PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` ||
  "0x72d99c45e8580b3d1b9d18bfd7ace47a0bd79eb29e78ef79fad0c9f2c50cdd25" as `0x${string}`;

const DEFAULT_SESSION_VERIFIER = "0xc34569efc25901bdd6b652164a2c8a7228b23005" as `0x${string}`;

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log("Inco Voucher System Test (7702 Smart Account)");
  console.log("=".repeat(60));

  // Setup signer (controls the 7702 smart account)
  const signerAccount = privateKeyToAccount(PRIVATE_KEY);
  const smartAccountAddress = signerAccount.address;

  console.log("\nSmart Account:", smartAccountAddress);

  // Check 7702 delegation
  const publicClient = createPublicClient({
    chain: base,
    transport: http(),
  });

  const code = await publicClient.getCode({ address: smartAccountAddress });
  if (code && code.startsWith("0xef0100")) {
    const delegationTarget = "0x" + code.slice(8);
    console.log("7702 Delegation:", delegationTarget);
  } else {
    console.log("No 7702 delegation (regular EOA)");
  }

  // Create wallet client
  const walletClient = createWalletClient({
    account: signerAccount,
    chain: base,
    transport: http(),
  });

  // Initialize Inco
  const zap = await Lightning.baseMainnet();
  console.log("\nInco SDK initialized");

  // ─── Step 1: Create Ephemeral EOA ─────────────────────────────

  console.log("\n--- Step 1: Create Ephemeral EOA ---");

  const ephemeralPrivateKey = generatePrivateKey();
  const ephemeralAccount = privateKeyToAccount(ephemeralPrivateKey);

  console.log("Ephemeral EOA:", ephemeralAccount.address);

  // ─── Step 2: Generate X-Wing Keypair ──────────────────────────

  console.log("\n--- Step 2: Generate X-Wing Keypair (Post-Quantum) ---");

  const reencryptKeypair = await generateXwingKeypair();
  console.log("X-Wing keypair generated");

  // ─── Step 3: Smart Account Grants Voucher ─────────────────────

  console.log("\n--- Step 3: Smart Account Grants Voucher ---");
  console.log("Signing voucher (EIP-712 typed data)...");

  const expiresAt = new Date(Date.now() + 3600000); // 1 hour

  try {
    const voucher = await zap.grantSessionKeyAllowanceVoucher(
      walletClient,
      ephemeralAccount.address,
      expiresAt,
      DEFAULT_SESSION_VERIFIER,
    );

    console.log("✓ Voucher granted!");
    console.log("  Grantee:", ephemeralAccount.address);
    console.log("  Expires:", expiresAt.toISOString());
    console.log("  Session Verifier:", DEFAULT_SESSION_VERIFIER);

    // ─── Step 4: Test Decryption (if we have a handle) ──────────

    console.log("\n--- Step 4: Voucher Ready for Decryption ---");
    console.log("\nThe ephemeral EOA can now decrypt any handle allowed to:");
    console.log("  ", smartAccountAddress);
    console.log("\nTo test decryption, provide a handle via environment variable:");
    console.log("  HANDLE=0x... npx ts-node --transpile-only src/testVoucherOnly.ts");

    const testHandle = process.env.HANDLE as HexString;
    if (testHandle) {
      console.log("\n--- Attempting Decryption ---");
      console.log("Handle:", testHandle);

      const results = await zap.attestedDecryptWithVoucher(
        ephemeralAccount,
        voucher,
        [testHandle],
        {
          reencryptPubKey: reencryptKeypair.encodePublicKey(),
          reencryptKeypair,
        },
      );

      console.log("✓ Decrypted!");
      console.log("  Value:", results[0].plaintext.value.toString());
    }

    // ─── Summary ────────────────────────────────────────────────

    console.log("\n" + "=".repeat(60));
    console.log("Voucher Test Complete!");
    console.log("=".repeat(60));
    console.log("\nKey Points:");
    console.log("1. Smart account (signer) signed EIP-712 voucher");
    console.log("2. Voucher authorizes ephemeral EOA for 1 hour");
    console.log("3. EOA can decrypt without smart account signing again");
    console.log("4. Works with 7702-upgraded EOAs as smart accounts");

  } catch (err: any) {
    console.error("\n❌ Error:", err.message || err);
    if (err.message?.includes("User rejected")) {
      console.log("\nNote: For automated testing, ensure the wallet client can sign.");
    }
    throw err;
  }
}

main().catch((err) => {
  process.exit(1);
});
