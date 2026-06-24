# Inco Smart Account + EOA Voucher Demo

Demonstrates decryption via EOA when the encrypted handle is owned by a **Smart Account** (ERC-4337, Safe, etc.).

## Architecture

```
Smart Account (handle owner)          EOA (decryptor)              Session Verifier Contract
─────────────────────────────         ────────────────             ─────────────────────────
1. Owns encrypted handle
   (contract calls e.allow(handle, smartAccount))

2. Signs voucher granting
   decryption rights to EOA ─────────>

                                      3. Creates X-Wing keypair
                                         for reencryption

                                      4. Calls attestedDecryptWithVoucher
                                         using ephemeral account

                                      5. Submits attestation ─────> 6. Verifies voucher
                                         on-chain (optional)           is valid & not expired
```

## Why This Pattern?

Smart accounts can't sign messages the same way EOAs do. The covalidator's attestation flow expects EOA signatures for decryption. The voucher system bridges this gap:

1. **Smart Account** issues a voucher (EIP-712 typed data signed by the smart account)
2. **Voucher** authorizes a specific EOA to decrypt handles on behalf of the smart account
3. **Session Verifier** contract validates the voucher hasn't expired and wasn't revoked

## Key Components

### Default Session Verifier
```
0xc34569efc25901bdd6b652164a2c8a7228b23005  (Base Sepolia)
```

### Voucher Fields
- `grantee`: The EOA address authorized to decrypt
- `expiresAt`: Timestamp when voucher becomes invalid
- `sessionVerifier`: Contract that validates the voucher

## Installation

```bash
# Install dependencies
npm install

# Contracts
cd contracts && npm install

# Frontend
cd frontend && npm install
```

## Usage

### 1. Deploy the Contract

```bash
cd contracts
npm run deploy:testnet
```

### 2. Smart Account Grants Voucher to EOA

```typescript
import { Lightning, generateXwingKeypair } from "@inco/lightning-js/lite";
import { generatePrivateKey, privateKeyToAccount } from "viem/accounts";

const zap = await Lightning.baseSepoliaTestnet();

// Smart account's wallet client (viem supports smart accounts)
const smartAccountWalletClient = /* your smart account wallet client */;

// Generate ephemeral EOA for decryption
const ephemeralEOA = privateKeyToAccount(generatePrivateKey());

// Smart account grants voucher (one-time signature)
const voucher = await zap.grantSessionKeyAllowanceVoucher(
  smartAccountWalletClient,  // Smart account signs this
  ephemeralEOA.address,       // EOA grantee
  new Date(Date.now() + 3600000), // 1 hour expiry
  "0xc34569efc25901bdd6b652164a2c8a7228b23005" // Session verifier
);
```

### 3. EOA Decrypts Using Voucher

```typescript
// EOA decrypts without needing smart account to sign again
const reencryptKeypair = await generateXwingKeypair();

const results = await zap.attestedDecryptWithVoucher(
  ephemeralEOA,           // EOA signs the decrypt request
  voucher,                // Voucher from smart account
  [encryptedHandle],      // Handle(s) to decrypt
  {
    reencryptPubKey: reencryptKeypair.encodePublicKey(),
    reencryptKeypair,
  }
);

console.log("Decrypted value:", results[0].plaintext.value);
```

### 4. (Optional) Submit Attestation On-Chain

```typescript
import { bytesToHex, pad, toHex } from "viem";

const result = results[0];
const signatures = result.covalidatorSignatures.map(sig => bytesToHex(sig));

await contractClient.write.submitDecryption([
  {
    handle: result.handle,
    value: pad(toHex(result.plaintext.value), { size: 32 }),
  },
  signatures,
]);
```

## File Structure

```
inco-smart-account-demo/
├── README.md
├── contracts/
│   ├── package.json
│   ├── hardhat.config.ts
│   └── src/
│       └── ConfidentialVault.sol    # Example contract
├── frontend/
│   ├── package.json
│   └── src/
│       ├── smartAccountVoucher.ts   # Core voucher flow
│       └── incoHelper.ts            # SDK utilities
└── package.json
```

## Smart Account Compatibility

This pattern works with any smart account that can:
1. Produce EIP-712 signatures (Safe, ERC-4337 accounts, etc.)
2. Use viem's wallet client interface

The SDK's `grantSessionKeyAllowanceVoucher` uses EIP-712 typed data, which smart accounts can sign via their signature schemes.

## Revoking Vouchers

To revoke all outstanding vouchers (e.g., on logout):

```typescript
await zap.updateActiveVouchersSessionNonce(smartAccountWalletClient);
```

This increments the session nonce, invalidating all previously issued vouchers.

## Networks

| Network | Chain ID | SDK Init |
|---------|----------|----------|
| Base Sepolia | 84532 | `Lightning.baseSepoliaTestnet()` |
| Base Mainnet | 8453 | `Lightning.baseMainnet()` |
| Local (Docker) | 31337 | `Lightning.localNode("mainnet")` |

## Dependencies

```json
{
  "@inco/lightning": "latest",
  "@inco/lightning-js": "latest",
  "viem": "^2.x"
}
```
