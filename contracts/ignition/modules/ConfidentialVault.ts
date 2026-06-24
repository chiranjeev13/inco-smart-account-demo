import { buildModule } from "@nomicfoundation/hardhat-ignition/modules";

const ConfidentialVaultModule = buildModule("ConfidentialVault", (m) => {
  const vault = m.contract("ConfidentialVault");
  return { vault };
});

export default ConfidentialVaultModule;
