import noxPlugin from "@iexec-nox/nox-hardhat-plugin";
import hardhatToolboxViem from "@nomicfoundation/hardhat-toolbox-viem";
import type { HardhatUserConfig } from "hardhat/config";

/**
 * shrud — one compilation unit, one compiler, one artifact per contract.
 *
 * WHY HARDHAT AND NOT FOUNDRY FOR THE PROTOCOL BUILD.
 *
 * Every Nox primitive is an external call into the NoxCompute proxy whose result is computed off
 * chain by the KMS, ingestor and TDX runner. Foundry cannot drive that stack, and `vm.etch`-ing a
 * fake NoxCompute would be a mocked confidentiality path — which this repository forbids on the
 * protocol path (see docs/threat-model.md). `@iexec-nox/nox-hardhat-plugin` boots the real stack in
 * Docker, so every test under `test/integration` and `test/privacy` runs against real encrypted
 * handles and real gateway proofs.
 *
 * Foundry is still present, and is the right tool for what it is used for: `test/unit`,
 * `test/fuzz`, `test/invariants` and `test/fork` cover the deterministic, Nox-free contracts —
 * the registries, the guard, the price registry, the adapters and the plaintext clearing maths.
 * See foundry.toml, which scopes `src` to exactly those.
 *
 * WHY solc 0.8.36. `@iexec-nox/nox-protocol-contracts@0.2.4` declares `pragma solidity ^0.8.35`
 * across every source. 0.8.36 is the highest release satisfying it that the plugin's toolchain
 * resolves. Recorded in source-lock.json.
 *
 * WHY evmVersion "osaka". Ethereum Sepolia is on Osaka, so one artifact deploys to the local node
 * and to Sepolia unchanged. This is not cosmetic: solc emits CLZ (EIP-7939, opcode 0x1e) at Osaka,
 * and on an OP-chain node at Isthmus that opcode is INVALID — everything deploys, every constructor
 * runs, every view returns, and then one execution path dies with a bare `invalid opcode` naming
 * nothing about the cause. `test/integration/00-osaka.ts` runs first and catches it in milliseconds.
 */
const config: HardhatUserConfig = {
  plugins: [hardhatToolboxViem, noxPlugin],

  solidity: {
    profiles: {
      default: {
        compilers: [
          {
            version: "0.8.36",
            settings: {
              optimizer: { enabled: true, runs: 200 },
              viaIR: true,
              evmVersion: "osaka",
              metadata: { bytecodeHash: "none" },
            },
          },
        ],
        /**
         * THE CLEARING ENGINE OPTIMISES FOR SIZE, NOT PER-CALL GAS, AND ONLY BECAUSE IT HAS TO.
         *
         * `ShrudClearingEngine` carries the whole encrypted operation graph for a 16-candidate
         * epoch. At `runs: 200` it is over EIP-170's 24,576-byte runtime limit, and the local Nox
         * node would never say so: it allows unlimited contract size and cannot be made not to,
         * because NoxCompute itself exceeds the limit. `pnpm verify:contract-size` measures every
         * deployable artifact against EIP-170 outside the node, which is the only place that check
         * can live.
         *
         * `runs: 1` tells the optimiser to favour deployment size over per-call gas. That is the
         * correct trade for a contract deployed once whose hot loop is dominated by external calls
         * into NoxCompute rather than by local arithmetic.
         *
         * Scoped to these files deliberately. Changing the profile globally would alter the
         * bytecode of every other contract, including ones already deployed and verified.
         */
        overrides: {
          "contracts/clearing/ShrudClearingEngine.sol": {
            version: "0.8.36",
            settings: {
              optimizer: { enabled: true, runs: 1 },
              viaIR: true,
              evmVersion: "osaka",
              metadata: { bytecodeHash: "none" },
            },
          },
          "contracts/settlement/ShrudSettlementEngine.sol": {
            version: "0.8.36",
            settings: {
              optimizer: { enabled: true, runs: 1 },
              viaIR: true,
              evmVersion: "osaka",
              metadata: { bytecodeHash: "none" },
            },
          },
        },
      },
    },
  },

  networks: {
    /**
     * The Nox plugin's own node, overridden. Its `withInjectedNetworks` spreads user entries LAST,
     * so naming `noxHost` here replaces the plugin's default rather than sitting beside it.
     *
     * `chainType: "l1"` + `hardfork: "osaka"` — see the CLZ note above. The hardfork is stated
     * explicitly rather than left to EDR's "latest stable", so a future EDR that promotes a newer
     * fork cannot silently move the chain out from under a suite whose whole purpose is executing
     * the exact bytecode Sepolia will execute.
     *
     * `allowUnlimitedContractSize` stays true because it is the plugin's requirement, not ours:
     * with it false the node cannot deploy NoxCompute at all. EIP-170 is enforced by
     * `pnpm verify:contract-size` instead.
     *
     * `allowBlocksWithSameTimestamp` — a Hardhat node advances block.timestamp by at least a second
     * per mined block, and a full clearing epoch mines hundreds. Once the chain clock runs more
     * than `proofExpirationDuration` ahead of wall clock, every gateway proof looks expired to
     * `validateInputProof`, which compares a `createdAt` stamped from the GATEWAY's real clock
     * against `block.timestamp`. That failure appears only late in a full-suite run and is an
     * artefact of on-demand mining, not a product defect.
     */
    noxHost: {
      type: "edr-simulated",
      chainType: "l1",
      hardfork: "osaka",
      allowUnlimitedContractSize: true,
      allowBlocksWithSameTimestamp: true,
    },
  },

  paths: {
    sources: "./contracts",
    tests: { nodejs: "./test/integration" },
  },
};

export default config;
