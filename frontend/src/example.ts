/**
 * Full Example: ERC-4337 Smart Account + EOA Voucher Decryption
 *
 * Uses permissionless.js for Safe smart account support.
 * The smart account owns encrypted handles, decryption is delegated to EOA via voucher.
 *
 * Run with: npx ts-node --transpile-only src/example.ts
 */

import {
  createPublicClient,
  createWalletClient,
  http,
  parseEther,
  encodeFunctionData,
  type Address,
} from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { toSafeSmartAccount } from "permissionless/accounts";
import { createSmartAccountClient, entryPoint07Address } from "permissionless";
import { createPimlicoClient } from "permissionless/clients/pimlico";
import { Lightning, generateXwingKeypair } from "@inco/lightning-js/lite";
import { handleTypes, type HexString } from "@inco/lightning-js";

// ─── Configuration ──────────────────────────────────────────────

// Owner private key (controls the smart account)
const OWNER_PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` ||
  "0x72d99c45e8580b3d1b9d18bfd7ace47a0bd79eb29e78ef79fad0c9f2c50cdd25";

// Pimlico API key (get free key at dashboard.pimlico.io)
const PIMLICO_API_KEY = process.env.PIMLICO_API_KEY || "";

// Deployed vault contract
const VAULT_CONTRACT = process.env.VAULT_CONTRACT as `0x${string}` || "0x..." as `0x${string}`;

// Session verifier for vouchers
const DEFAULT_SESSION_VERIFIER = "0xc34569efc25901bdd6b652164a2c8a7228b23005" as `0x${string}`;

// Vault ABI
const VAULT_ABI = [
  {
    inputs: [{ name: "encryptedAmount", type: "bytes" }],
    name: "deposit",
    outputs: [],
    stateMutability: "payable",
    type: "function",
  },
  {
    inputs: [{ name: "account", type: "address" }],
    name: "getBalanceHandle",
    outputs: [{ name: "", type: "bytes32" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      {
        components: [
          { name: "handle", type: "bytes32" },
          { name: "value", type: "bytes32" },
        ],
        name: "decryption",
        type: "tuple",
      },
      { name: "signatures", type: "bytes[]" },
    ],
    name: "submitDecryption",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

// ─── Main ───────────────────────────────────────────────────────

async function main() {
  console.log("=".repeat(60));
  console.log("Inco Smart Account Demo (ERC-4337 Safe)");
  console.log("=".repeat(60));

  // ─── Setup Clients ────────────────────────────────────────────

  const publicClient = createPublicClient({
    chain: base,
    transport: http(),
  });

  const ownerAccount = privateKeyToAccount(OWNER_PRIVATE_KEY as `0x${string}`);
  console.log("\nOwner EOA:", ownerAccount.address);

  // Owner wallet client (for signing vouchers)
  const ownerWalletClient = createWalletClient({
    account: ownerAccount,
    chain: base,
    transport: http(),
  });

  // ─── Create Safe Smart Account ────────────────────────────────

  console.log("\n--- Creating Safe Smart Account ---");

  const safeAccount = await toSafeSmartAccount({
    client: publicClient,
    owners: [ownerAccount],
    version: "1.4.1",
    entryPoint: {
      address: entryPoint07Address,
      version: "0.7",
    },
  });

  const smartAccountAddress = safeAccount.address;
  console.log("Safe Smart Account:", smartAccountAddress);

  // Check deployment status
  const code = await publicClient.getCode({ address: smartAccountAddress });
  const isDeployed = code && code !== "0x";
  console.log("Deployed:", isDeployed ? "Yes" : "No (counterfactual)");

  // ─── Initialize Inco SDK ──────────────────────────────────────

  const zap = await Lightning.baseMainnet();
  console.log("\nInco SDK initialized for Base Mainnet");

  // ─── Create Ephemeral EOA for Decryption ──────────────────────

  console.log("\n--- Step 1: Create Ephemeral EOA ---");

  const ephemeralAccount = privateKeyToAccount(generatePrivateKey());
  console.log("Ephemeral EOA:", ephemeralAccount.address);

  // Generate X-Wing keypair (post-quantum reencryption)
  const reencryptKeypair = await generateXwingKeypair();
  console.log("X-Wing keypair generated");

  // ─── Smart Account Owner Grants Voucher ───────────────────────

  console.log("\n--- Step 2: Owner Signs Voucher ---");

  const expiresAt = new Date(Date.now() + 3600000); // 1 hour

  // The voucher is signed by the OWNER EOA
  // This grants the ephemeral EOA permission to decrypt handles
  // that were allowed to addresses the owner controls

  const voucher = await zap.grantSessionKeyAllowanceVoucher(
    ownerWalletClient,
    ephemeralAccount.address,
    expiresAt,
    DEFAULT_SESSION_VERIFIER,
  );

  console.log("✓ Voucher granted!");
  console.log("  Signed by:", ownerAccount.address);
  console.log("  Grantee:", ephemeralAccount.address);
  console.log("  Expires:", expiresAt.toISOString());

  // ─── Full Flow (if Pimlico API key provided) ──────────────────

  if (PIMLICO_API_KEY && VAULT_CONTRACT !== "0x...") {
    console.log("\n--- Step 3: Setup Pimlico Bundler ---");

    const pimlicoUrl = `https://api.pimlico.io/v2/base/rpc?apikey=${PIMLICO_API_KEY}`;

    const pimlicoClient = createPimlicoClient({
      transport: http(pimlicoUrl),
      entryPoint: {
        address: entryPoint07Address,
        version: "0.7",
      },
    });

    const smartAccountClient = createSmartAccountClient({
      account: safeAccount,
      chain: base,
      bundlerTransport: http(pimlicoUrl),
      paymaster: pimlicoClient,
      userOperation: {
        estimateFeesPerGas: async () => (await pimlicoClient.getUserOperationGasPrice()).fast,
      },
    });

    console.log("Pimlico client configured");

    // ─── Deposit to Vault ───────────────────────────────────────

    console.log("\n--- Step 4: Deposit (via UserOperation) ---");

    const depositAmount = parseEther("0.0001");

    // Encrypt for smart account address
    const ciphertext = await zap.encrypt(depositAmount, {
      accountAddress: smartAccountAddress,
      dappAddress: VAULT_CONTRACT,
      handleType: handleTypes.euint256,
    });

    console.log("Encrypted amount:", depositAmount.toString(), "wei");

    // Get Inco fee
    const fee = await publicClient.readContract({
      address: zap.executorAddress as `0x${string}`,
      abi: [{
        inputs: [],
        name: "getFee",
        outputs: [{ type: "uint256" }],
        stateMutability: "pure",
        type: "function",
      }],
      functionName: "getFee",
    }) as bigint;

    console.log("Inco fee:", fee.toString(), "wei");

    // Encode deposit call
    const depositData = encodeFunctionData({
      abi: VAULT_ABI,
      functionName: "deposit",
      args: [ciphertext as `0x${string}`],
    });

    // Send UserOperation via bundler
    const txHash = await smartAccountClient.sendTransaction({
      to: VAULT_CONTRACT,
      value: fee,
      data: depositData,
    });

    console.log("Tx hash:", txHash);

    // Wait for confirmation
    const receipt = await publicClient.waitForTransactionReceipt({ hash: txHash });
    console.log("Confirmed! Block:", receipt.blockNumber);

    // Wait for covalidator
    console.log("Waiting for covalidator...");
    await new Promise((r) => setTimeout(r, 5000));

    // ─── Get Handle & Decrypt ───────────────────────────────────

    console.log("\n--- Step 5: Get Balance Handle ---");

    const balanceHandle = await publicClient.readContract({
      address: VAULT_CONTRACT,
      abi: VAULT_ABI,
      functionName: "getBalanceHandle",
      args: [smartAccountAddress],
    });

    console.log("Balance handle:", balanceHandle);

    console.log("\n--- Step 6: EOA Decrypts with Voucher ---");

    const results = await zap.attestedDecryptWithVoucher(
      ephemeralAccount,
      voucher,
      [balanceHandle as HexString],
      {
        reencryptPubKey: reencryptKeypair.encodePublicKey(),
        reencryptKeypair,
      },
    );

    console.log("✓ Decrypted!");
    console.log("  Balance:", results[0].plaintext.value.toString(), "wei");

  } else {
    console.log("\n--- Voucher Ready ---");
    console.log("\nTo run full flow with smart account transactions:");
    console.log("  1. Get free Pimlico API key: https://dashboard.pimlico.io");
    console.log("  2. Deploy ConfidentialVault to Base Mainnet");
    console.log("  3. Run: PIMLICO_API_KEY=... VAULT_CONTRACT=0x... npx ts-node ...");
  }

  // ─── Summary ──────────────────────────────────────────────────

  console.log("\n" + "=".repeat(60));
  console.log("Demo Complete!");
  console.log("=".repeat(60));
  console.log("\nArchitecture:");
  console.log("┌─────────────────────────────────────────────────────────┐");
  console.log("│  Owner EOA          →  signs vouchers                   │");
  console.log("│  " + ownerAccount.address + "                 │");
  console.log("│         │                                               │");
  console.log("│         ↓ controls                                      │");
  console.log("│  Safe Smart Account →  owns encrypted handles           │");
  console.log("│  " + smartAccountAddress + "                 │");
  console.log("│         │                                               │");
  console.log("│         ↓ voucher grants decryption                     │");
  console.log("│  Ephemeral EOA      →  performs decryption              │");
  console.log("│  " + ephemeralAccount.address + "                 │");
  console.log("└─────────────────────────────────────────────────────────┘");
}

main().catch((err) => {
  console.error("\nError:", err.message || err);
  process.exit(1);
});
