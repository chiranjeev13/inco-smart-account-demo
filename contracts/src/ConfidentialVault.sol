// SPDX-License-Identifier: MIT
pragma solidity ^0.8.30;

import {euint256, ebool, e, inco} from "@inco/lightning/src/Lib.sol";
import {DecryptionAttestation} from "@inco/lightning/src/lightning-parts/DecryptionAttester.types.sol";

/// @title ConfidentialVault
/// @notice A vault for confidential balances supporting both EOA and Smart Account owners.
/// @dev Smart accounts can own handles and delegate decryption to EOAs via the voucher system.
contract ConfidentialVault {
    using e for *;

    // ─── State ──────────────────────────────────────────────────

    /// @notice Encrypted balance per account (EOA or smart account)
    mapping(address => euint256) public balanceOf;

    /// @notice Track if a decryption attestation has been used
    mapping(bytes32 => bool) public usedAttestations;

    // ─── Events ─────────────────────────────────────────────────

    event Deposited(address indexed account, bytes32 indexed handleId);
    event Withdrawn(address indexed account, uint256 amount);
    event DecryptionSubmitted(address indexed account, bytes32 indexed handle);

    // ─── Errors ─────────────────────────────────────────────────

    error InsufficientFees();
    error InvalidAttestation();
    error HandleMismatch();
    error AttestationAlreadyUsed();

    // ─── Deposit (accepts encrypted amount) ─────────────────────

    /// @notice Deposit an encrypted amount into the vault
    /// @param encryptedAmount Ciphertext from @inco/lightning-js encrypt()
    /// @dev Works for both EOAs and smart accounts - msg.sender owns the handle
    function deposit(bytes memory encryptedAmount) external payable {
        if (msg.value < inco.getFee()) revert InsufficientFees();

        // Create encrypted value - msg.sender (EOA or smart account) is the owner
        euint256 amount = encryptedAmount.newEuint256(msg.sender);

        // Add to existing balance
        euint256 currentBalance = balanceOf[msg.sender];
        euint256 newBalance;

        if (euint256.unwrap(currentBalance) == bytes32(0)) {
            // First deposit
            newBalance = amount;
        } else {
            newBalance = currentBalance.add(amount);
        }

        balanceOf[msg.sender] = newBalance;

        // CRITICAL: Grant access
        newBalance.allow(msg.sender); // Owner can decrypt (or delegate via voucher)
        newBalance.allowThis(); // Contract can use in future txs

        emit Deposited(msg.sender, euint256.unwrap(newBalance));
    }

    // ─── Get Balance Handle ─────────────────────────────────────

    /// @notice Get the encrypted balance handle for an account
    /// @param account The account to query (EOA or smart account)
    /// @return The encrypted balance handle
    function getBalanceHandle(address account) external view returns (euint256) {
        return balanceOf[account];
    }

    // ─── Withdraw with Attestation ──────────────────────────────

    /// @notice Withdraw by submitting a decryption attestation
    /// @param decryption The decryption attestation from covalidator
    /// @param signatures Covalidator signatures
    /// @dev The attestation can come from an EOA using a voucher from a smart account
    function withdrawWithAttestation(
        DecryptionAttestation memory decryption,
        bytes[] memory signatures
    ) external {
        // 1. Check attestation hasn't been used
        bytes32 attestationId = keccak256(abi.encode(decryption.handle, decryption.value));
        if (usedAttestations[attestationId]) revert AttestationAlreadyUsed();

        // 2. Verify covalidator signatures
        if (!inco.incoVerifier().isValidDecryptionAttestation(decryption, signatures)) {
            revert InvalidAttestation();
        }

        // 3. Verify handle matches caller's balance
        if (euint256.unwrap(balanceOf[msg.sender]) != decryption.handle) {
            revert HandleMismatch();
        }

        // 4. Mark attestation as used
        usedAttestations[attestationId] = true;

        // 5. Process withdrawal
        uint256 amount = uint256(decryption.value);

        // Reset balance to zero (new handle)
        balanceOf[msg.sender] = uint256(0).asEuint256();
        balanceOf[msg.sender].allowThis();

        // Transfer ETH (assuming 1:1 for demo)
        (bool success, ) = msg.sender.call{value: amount}("");
        require(success, "Transfer failed");

        emit Withdrawn(msg.sender, amount);
    }

    // ─── Submit Decryption (no withdrawal) ──────────────────────

    /// @notice Submit a decryption attestation for verification only
    /// @dev Useful for proving balance without withdrawing
    function submitDecryption(
        DecryptionAttestation memory decryption,
        bytes[] memory signatures
    ) external {
        // Verify covalidator signatures
        if (!inco.incoVerifier().isValidDecryptionAttestation(decryption, signatures)) {
            revert InvalidAttestation();
        }

        // Verify handle matches caller's balance
        if (euint256.unwrap(balanceOf[msg.sender]) != decryption.handle) {
            revert HandleMismatch();
        }

        emit DecryptionSubmitted(msg.sender, decryption.handle);
    }

    // ─── Fund contract for withdrawals ──────────────────────────

    receive() external payable {}
}
