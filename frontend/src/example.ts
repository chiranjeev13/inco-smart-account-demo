/**
 * Full Example: Smart Account Deposit + EOA Decrypt
 *
 * Run with: npx ts-node src/example.ts
 */

import { createWalletClient, createPublicClient, http, parseEther } from "viem";
import { base } from "viem/chains";
import { privateKeyToAccount } from "viem/accounts";
import { Lightning } from "@inco/lightning-js/lite";
import { handleTypes, type HexString } from "@inco/lightning-js";

import {
  createVoucherSession,
  decryptWithVoucher,
  formatForContract,
  getFee,
  DEFAULT_SESSION_VERIFIER,
} from "./smartAccountVoucher";

// ─── Configuration ──────────────────────────────────────────────

// Deployed contract address on Base Mainnet
// TODO: Deploy to mainnet and update this address
const VAULT_CONTRACT = "0x..." as `0x${string}`;

// Private key for demo - use env var in production
const SMART_ACCOUNT_PRIVATE_KEY = process.env.PRIVATE_KEY as `0x${string}` || "0x...";

// Vault contract ABI (minimal for this example)
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
  // Initialize clients
  // NOTE: In production with a real smart account (Safe, ERC-4337),
  // you'd use the smart account's wallet client here
  const account = privateKeyToAccount(SMART_ACCOUNT_PRIVATE_KEY);

  const walletClient = createWalletClient({
    account,
    chain: base,
    transport: http(),
  });

  const publicClient = createPublicClient({
    chain: base,
    transport: http(),
  });

  const zap = await Lightning.baseMainnet();

  console.log("Smart Account Address:", account.address);

  // ─── Step 1: Deposit (Smart Account encrypts and deposits) ────

  console.log("\n--- Step 1: Deposit ---");

  // Encrypt the deposit amount
  const depositAmount = parseEther("0.001"); // 0.001 ETH
  const ciphertext = await zap.encrypt(depositAmount, {
    accountAddress: account.address,
    dappAddress: VAULT_CONTRACT,
    handleType: handleTypes.euint256,
  });

  // Get fee
  const fee = await getFee(publicClient);
  console.log("Inco fee:", fee.toString(), "wei");

  // Deposit to vault
  const depositTx = await walletClient.writeContract({
    address: VAULT_CONTRACT,
    abi: VAULT_ABI,
    functionName: "deposit",
    args: [ciphertext as `0x${string}`],
    value: fee,
  });

  console.log("Deposit tx:", depositTx);

  // Wait for tx confirmation
  await publicClient.waitForTransactionReceipt({ hash: depositTx });
  console.log("Deposit confirmed!");

  // Wait for covalidator to process (give it a few seconds)
  console.log("Waiting for covalidator...");
  await new Promise((resolve) => setTimeout(resolve, 5000));

  // ─── Step 2: Get Balance Handle ───────────────────────────────

  console.log("\n--- Step 2: Get Balance Handle ---");

  const balanceHandle = await publicClient.readContract({
    address: VAULT_CONTRACT,
    abi: VAULT_ABI,
    functionName: "getBalanceHandle",
    args: [account.address],
  });

  console.log("Balance handle:", balanceHandle);

  // ─── Step 3: Create Voucher Session ───────────────────────────

  console.log("\n--- Step 3: Create Voucher Session ---");

  // Smart account creates a voucher for an ephemeral EOA
  // In production with a real smart account, the smart account signs this
  const session = await createVoucherSession(
    walletClient,
    3600000, // 1 hour expiry
    DEFAULT_SESSION_VERIFIER,
  );

  console.log("Ephemeral EOA:", session.ephemeralAccount.address);
  console.log("Voucher expires:", session.expiresAt.toISOString());

  // ─── Step 4: EOA Decrypts Using Voucher ───────────────────────

  console.log("\n--- Step 4: Decrypt with Voucher ---");

  // The EOA can now decrypt without the smart account signing again
  const results = await decryptWithVoucher(session, [balanceHandle as HexString]);

  console.log("Decrypted balance:", results[0].value.toString(), "wei");

  // ─── Step 5: (Optional) Submit Attestation On-Chain ───────────

  console.log("\n--- Step 5: Submit Attestation On-Chain ---");

  const { decryption, signatures } = formatForContract(results[0]);

  const submitTx = await walletClient.writeContract({
    address: VAULT_CONTRACT,
    abi: VAULT_ABI,
    functionName: "submitDecryption",
    args: [decryption, signatures],
  });

  console.log("Submit attestation tx:", submitTx);
  await publicClient.waitForTransactionReceipt({ hash: submitTx });
  console.log("Attestation verified on-chain!");

  // ─── Done ─────────────────────────────────────────────────────

  console.log("\n--- Complete! ---");
  console.log("Successfully demonstrated:");
  console.log("1. Smart account deposited encrypted amount");
  console.log("2. Smart account issued voucher to ephemeral EOA");
  console.log("3. EOA decrypted balance using voucher");
  console.log("4. Attestation submitted and verified on-chain");
}

main().catch(console.error);
