"use client";

/**
 * The whole submission sequence, as one hook.
 *
 * It is four steps and they are shown individually rather than behind one spinner, because three of
 * them can fail for different reasons and a single "submitting…" gives the user nothing to act on:
 *
 *   1. open the epoch, if this is the first order in the window (permissionless)
 *   2. encrypt amount, action and limit against the Nox gateway  ← no transaction, but the slow part
 *   3. submitIntent   — writes the header and the three handles
 *   4. activateIntent — locks the funds against a Safe owner signature
 *
 * Step 3 without step 4 is an order that holds nothing and clears nothing, so the sequence does not
 * report success until the activation lands.
 */

import { useCallback, useState } from "react";
import { type Address, type Hex, parseUnits } from "viem";
import { usePublicClient, useSignTypedData, useWalletClient } from "wagmi";

import { CHAIN_ID, contractAddress } from "./deployment";
import { explainWriteError, safeModuleAbi } from "./onboarding";
import {
  BASE_WRAPPER,
  buildOrder,
  currentEpochId,
  EPOCH_STATUS,
  headerFor,
  intentBookAbi,
  INTENT_TYPES,
  intentDomain,
  ORDER_FAMILY,
  PRICE_SCALE,
  QUOTE_WRAPPER,
  SCHEMA_VERSION,
} from "./orders";

import clearingEngineArtifact from "../../../../artifacts/contracts/clearing/ShrudClearingEngine.sol/ShrudClearingEngine.json";

const clearingEngineAbi = clearingEngineArtifact.abi;

/** USDC is six decimals, WETH is eighteen. A buy spends USDC; a sell sells WETH. */
const INPUT_DECIMALS = { buy: 6, sell: 18 } as const;

export interface Step {
  readonly label: string;
  readonly done: boolean;
  readonly active: boolean;
  readonly hash?: Hex;
}

export function useSubmitOrder({ safe, module }: { safe: Address; module: Address }) {
  const publicClient = usePublicClient({ chainId: CHAIN_ID });
  const { data: walletClient } = useWalletClient({ chainId: CHAIN_ID });
  const { signTypedDataAsync } = useSignTypedData();

  const [steps, setSteps] = useState<Step[]>([]);
  const [busy, setBusy] = useState(false);
  const [stage, setStage] = useState("Working…");
  const [error, setError] = useState<string | undefined>();

  const run = useCallback(
    (input: { side: "buy" | "sell"; amount: string; limit: string }) => {
      void (async () => {
        if (publicClient === undefined || walletClient === undefined) return;
        setBusy(true);
        setError(undefined);

        const done: Step[] = [];
        const push = (label: string, hash?: Hex) => {
          done.push({ label, done: true, active: false, ...(hash === undefined ? {} : { hash }) });
          setSteps([...done]);
        };
        const working = (label: string) => {
          setStage(label);
          setSteps([...done, { label, done: false, active: true }]);
        };

        try {
          const epochId = currentEpochId();

          // ── 1 ── open the epoch if nobody has yet ────────────────────────────────────────────
          working("Checking the epoch");
          const record = (await publicClient.readContract({
            address: contractAddress("ShrudIntentBook"),
            abi: intentBookAbi,
            functionName: "epochOf",
            args: [epochId],
          })) as { status: number };

          if (record.status === EPOCH_STATUS.None) {
            working("Opening the epoch");
            const openHash = await walletClient.writeContract({
              address: contractAddress("ShrudClearingEngine"),
              abi: clearingEngineAbi,
              functionName: "openEpoch",
              args: [epochId, ORDER_FAMILY, BASE_WRAPPER(), QUOTE_WRAPPER()],
              chain: walletClient.chain,
              account: walletClient.account,
            });
            await publicClient.waitForTransactionReceipt({ hash: openHash });
            push("Epoch opened", openHash);
          } else {
            push("Epoch already open");
          }

          // ── 2 ── encrypt, which is the slow step and sends nothing ───────────────────────────
          working("Encrypting against the Nox gateway");
          const amountUnits = parseUnits(input.amount, INPUT_DECIMALS[input.side]);
          // The limit is quote units per WHOLE base unit, scaled — never per raw unit.
          const limitScaled = (parseUnits(input.limit, 6) * PRICE_SCALE) / 10n ** 6n;

          // Sequential per owner. The module reverts WrongNonce on anything else, and a timestamp
          // is the obvious wrong guess.
          const nonce = (await publicClient.readContract({
            address: module,
            abi: safeModuleAbi,
            functionName: "nextNonce",
            args: [walletClient.account.address],
          })) as bigint;

          const built = await buildOrder({
            walletClient,
            publicClient,
            safe,
            module,
            side: input.side,
            amount: amountUnits,
            limit: limitScaled,
            epochId,
            expirySeconds: 3600,
            nonce,
          });
          push("Amount, side and limit encrypted");

          // ── 3 ── submitIntent ───────────────────────────────────────────────────────────────
          working("Submitting the order");
          const header = headerFor(built);
          const [amountIn, actionIn, limitIn] = built.inputs;
          if (amountIn === undefined || actionIn === undefined || limitIn === undefined) {
            throw new Error("the gateway returned fewer handles than the three fields require");
          }

          const submitHash = await walletClient.writeContract({
            address: module,
            abi: safeModuleAbi,
            functionName: "submitIntent",
            args: [
              header,
              amountIn.handle,
              amountIn.proof,
              actionIn.handle,
              actionIn.proof,
              limitIn.handle,
              limitIn.proof,
            ],
            chain: walletClient.chain,
            account: walletClient.account,
          });
          await publicClient.waitForTransactionReceipt({ hash: submitHash });
          push("Order submitted", submitHash);

          // ── 4 ── activate, which is what actually locks the funds ────────────────────────────
          working("Sign to activate");
          const signature = await signTypedDataAsync({
            domain: intentDomain(module),
            types: INTENT_TYPES,
            primaryType: "ShrudIntent",
            message: {
              safe,
              intentId: built.intentId,
              commitment: built.commitment,
              orderFamily: header.orderFamily,
              epochId: header.epochId,
              inputAsset: header.inputAsset,
              nonce: header.nonce,
              expiry: header.expiry,
              schemaVersion: SCHEMA_VERSION,
            },
          });

          working("Activating the order");
          const activateHash = await walletClient.writeContract({
            address: module,
            abi: safeModuleAbi,
            functionName: "activateIntent",
            args: [built.intentId, signature],
            chain: walletClient.chain,
            account: walletClient.account,
          });
          await publicClient.waitForTransactionReceipt({ hash: activateHash });
          push("Order active and funds locked", activateHash);
          setSteps([...done]);
        } catch (caught) {
          setError(explainWriteError(caught));
        } finally {
          setBusy(false);
        }
      })();
    },
    [publicClient, walletClient, signTypedDataAsync, safe, module],
  );

  return { run, steps, busy, stage, error };
}
