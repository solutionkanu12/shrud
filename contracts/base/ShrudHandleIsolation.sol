// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {Nox, ebool, euint16, euint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

import {ShrudPauseController} from "../recovery/ShrudPauseController.sol";
import {ShrudConfidentialBase} from "./ShrudConfidentialBase.sol";

/**
 * @title ShrudHandleIsolation
 * @notice Handle isolation, in one place so it has exactly one implementation.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE PROBLEM, READ FROM SOURCE RATHER THAN INFERRED
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * From `modules/Compute.sol::_generateHandle` and `_generateHandleUniqueSeed`
 * (nox-protocol-contracts 0.2.4):
 *
 *     handle     = keccak256(abi.encode(operator, operands, noxCompute, uniqueSeed, outputIndex))
 *     uniqueSeed = 0                  if ANY operand is confidential   -> DETERMINISTIC
 *                = ++storageCounter   if EVERY operand is public       -> unpredictable
 *
 * So two logically distinct encrypted quantities computed identically from identical operands are
 * **one handle sharing one permanent ACL entry** — and there is no `removeAdmin` and no
 * `removeViewer`. Grant that handle to Safe A because it is A's allocation, and Safe B, whose
 * allocation happens to be arithmetically identical, has just been given A's handle. Or rather:
 * they were always the same handle, and the second grant was the disclosure.
 *
 * In a shrud clearing epoch this is the COMMON case, not a corner case. Sixteen candidate orders,
 * many of them round numbers, all classified and gated through the same three `select` calls
 * against the same epoch price: two treasuries submitting 10,000 USDC to buy WETH at the same
 * hidden limit produce byte-identical intermediates at every stage.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE RULE
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * It is not "avoid collisions" — that is neither achievable nor necessary. It is:
 *
 *     NEVER GRANT A SAFE, A VIEWER OR THE PUBLIC A HANDLE THAT SOMETHING ELSE COULD EQUAL.
 *
 * Intermediates collide freely and harmlessly because nobody is ever granted one. Every handle that
 * crosses a boundary is isolated first: a Safe's lock result, its internal-cross allocation, its
 * residual contribution, its final allocation, its position share, every capsule field, and each of
 * the four values a residual publishes.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHY AN EPOCH CONDITION AND NOT SIMPLY `select(eq(v,v), v, tag)`
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The obvious isolation is `select(eq(v, v), v, tag)`, and for `euint256` it works: the tag carries
 * a full 256-bit domain hash, so distinctness is as strong as keccak.
 *
 * It does NOT work for `euint16`. A 16-bit tag has 65,536 values, so two epochs' `meetsEpochFloor`
 * handles could coincide, and a decryption proof issued for one epoch would then bind to the other.
 * Both values are public either way so nothing leaks — but the graph binding would be weaker than
 * it claims, and a binding that is weaker than it claims is exactly the defect this file exists to
 * prevent.
 *
 * Threading a per-epoch confidential condition makes distinctness hold on two independent axes: the
 * condition separates epochs, the tag separates roles and subjects. It also makes the unique seed
 * deterministic regardless of the value's own attributes, which is what lets an off-chain verifier
 * predict the handle and check the binding instead of taking it on trust.
 */
abstract contract ShrudHandleIsolation is ShrudConfidentialBase {
    /**
     * @dev Bit 0 of a handle's attribute byte. Set by every NoxCompute `_executeOperation` output;
     *      cleared by `wrapAsPublicHandle`, which is what `Nox.toEuint16/toEuint256/toEbool`
     *      compile to. Read from `utils/HandleUtils.sol::ATTR_IS_UNIQUE_HANDLE`.
     */
    bytes1 private constant ATTR_IS_UNIQUE_HANDLE = 0x01;

    // Domain roles. Distinct roles mean distinct tags mean distinct handles.
    bytes32 internal constant ROLE_EPOCH_SALT = keccak256("shrud.isolation.epochSalt");
    bytes32 internal constant ROLE_LOCKED = keccak256("shrud.intent.lockedAmount");
    bytes32 internal constant ROLE_LOCK_SUCCESS = keccak256("shrud.intent.lockSuccess");
    bytes32 internal constant ROLE_ELIGIBILITY = keccak256("shrud.intent.priceEligible");
    bytes32 internal constant ROLE_INCLUSION = keccak256("shrud.intent.privateInclusion");
    bytes32 internal constant ROLE_CROSS_IN = keccak256("shrud.intent.internalCrossInput");
    bytes32 internal constant ROLE_CROSS_OUT = keccak256("shrud.intent.internalCrossOutput");
    bytes32 internal constant ROLE_RESIDUAL_CONTRIB = keccak256("shrud.intent.residualContribution");
    bytes32 internal constant ROLE_EXTERNAL_ALLOC = keccak256("shrud.intent.externalAllocation");
    bytes32 internal constant ROLE_FINAL_ALLOC = keccak256("shrud.intent.finalAllocation");
    bytes32 internal constant ROLE_REFUND = keccak256("shrud.intent.confidentialRefund");
    bytes32 internal constant ROLE_OUTCOME = keccak256("shrud.intent.privateOutcomeCode");
    bytes32 internal constant ROLE_POSITION_SHARE = keccak256("shrud.position.share");
    bytes32 internal constant ROLE_PENDING_WITHDRAWAL = keccak256("shrud.position.pendingWithdrawal");
    bytes32 internal constant ROLE_RESIDUAL_DIRECTION = keccak256("shrud.epoch.residualDirection");
    bytes32 internal constant ROLE_RESIDUAL_INPUT = keccak256("shrud.epoch.residualAggregateInput");
    bytes32 internal constant ROLE_RESIDUAL_MINIMUM = keccak256("shrud.epoch.residualAggregateMinimum");
    bytes32 internal constant ROLE_EPOCH_FLOOR = keccak256("shrud.epoch.meetsEpochFloor");
    bytes32 internal constant ROLE_RESIDUAL_FLOOR = keccak256("shrud.epoch.meetsResidualFloor");
    bytes32 internal constant ROLE_SUPPLY_FLOOR = keccak256("shrud.epoch.meetsSupplyFloor");
    bytes32 internal constant ROLE_CAPSULE_FIELD = keccak256("shrud.capsule.field");

    error HandleIsNotConfidential(bytes32 handle);

    constructor(ShrudPauseController pauseController_) ShrudConfidentialBase(pauseController_) {}

    /**
     * @notice The domain a handle is isolated under.
     * @dev Every field that could distinguish two logically different quantities is here. Two calls
     *      agree only when the chain, the contract, the epoch, the role and the subject all agree.
     * @param subject the per-role discriminator: an intent id, a Safe address cast to uint256, a
     *        candidate index, or a capsule field index. Never a private value.
     */
    function isolationDomain(bytes32 epochId, bytes32 role, uint256 subject)
        public
        view
        returns (bytes32)
    {
        return keccak256(abi.encode(block.chainid, address(this), epochId, role, subject));
    }

    /**
     * @dev Rejects a public handle.
     *
     * NOT DECORATION. A public handle bypasses every ACL gate in NoxCompute —
     * `HandleUtils.isPublicHandle`'s own security note says so in those words: `_isAllowed` always
     * returns true, `isViewer` always returns true, `isPubliclyDecryptable` always returns true. And
     * an all-public operand set makes the output handle depend on a storage counter, which is
     * unpredictable off chain and so unverifiable.
     *
     * Reaching this state means a stage ran out of order or an unset slot was read. Both are public
     * scheduling faults that disclose nothing confidential, so a public revert is the right signal.
     */
    function _requireConfidential(bytes32 handle) internal pure {
        if (handle[6] & ATTR_IS_UNIQUE_HANDLE == 0) revert HandleIsNotConfidential(handle);
    }

    /**
     * @notice Builds the per-epoch confidential condition every isolation in this epoch uses.
     * @param anchor any confidential handle belonging to this epoch — in practice the first
     *        candidate's locked amount, which the caller has just proved it holds a grant on.
     *
     * @dev Cost: `toEuint256` + `add` + `eq`, three NoxCompute calls, paid ONCE per epoch and never
     *      per candidate. The result is encrypted `true` and unique to this epoch.
     */
    function _buildEpochCondition(bytes32 epochId, euint256 anchor) internal returns (ebool) {
        _requireConfidential(euint256.unwrap(anchor));
        euint256 salted =
            Nox.add(anchor, Nox.toEuint256(uint256(isolationDomain(epochId, ROLE_EPOCH_SALT, 0))));
        return Nox.eq(salted, salted);
    }

    /**
     * @notice Returns a handle with the same value and a lineage nothing else can share.
     *
     * @dev `select`'s operands are `[epochCondition, value, tag]`:
     *      - `epochCondition` is encrypted `true` and unique to this epoch, so the result is always
     *        `value` and `tag` is never taken;
     *      - `tag` is `toEuint256(domain)` — deterministic in a domain carrying the role and the
     *        subject, and its plaintext is a hash unrelated to anything private;
     *      - the condition is confidential, so the unique seed is 0 and the handle is reproducible
     *        off chain, which is what makes the binding checkable rather than decorative.
     *
     *      Two Safes' numerically identical allocations therefore remain two handles with two ACL
     *      entries. Cost: `toEuint256` + `select`, two NoxCompute calls per handle that crosses a
     *      boundary. Never paid per intermediate.
     */
    function _isolate(euint256 value, ebool epochCondition, bytes32 domain)
        internal
        returns (euint256)
    {
        _requireConfidential(euint256.unwrap(value));
        return Nox.select(epochCondition, value, Nox.toEuint256(uint256(domain)));
    }

    /// @dev The `euint16` form. The tag necessarily truncates to 16 bits, which is exactly why the
    ///      epoch condition carries epoch separation rather than the tag.
    function _isolate16(euint16 value, ebool epochCondition, bytes32 domain)
        internal
        returns (euint16)
    {
        _requireConfidential(euint16.unwrap(value));
        return Nox.select(epochCondition, value, Nox.toEuint16(uint16(uint256(domain))));
    }

    /**
     * @dev The `ebool` form, for the two floor booleans an epoch publishes.
     *
     * `select` has no `ebool` overload (delta D-3), so a boolean is isolated by carrying it through
     * `euint256` and comparing back. Three tags are derived from the domain and are pairwise
     * distinct by construction:
     *
     *     trueTag  = domain | 1      (always odd)
     *     falseTag = domain & ~1     (always even, so never equal to trueTag)
     *     isolationTag = keccak256(domain)
     *
     * Cost: four `toEuint256`, two `select` and one `eq` — seven NoxCompute calls. Paid exactly
     * twice per epoch, for `meetsEpochFloor` and `meetsResidualFloor`, and never per candidate.
     * These are the only two `ebool`s shrud ever publishes, so the price buys the property that
     * matters most: a decryption proof for one epoch's floor cannot bind to another's.
     */
    function _isolateBool(ebool value, ebool epochCondition, bytes32 domain) internal returns (ebool) {
        _requireConfidential(ebool.unwrap(value));

        euint256 trueTag = Nox.toEuint256(uint256(domain) | 1);
        euint256 falseTag = Nox.toEuint256(uint256(domain) & ~uint256(1));
        euint256 isolationTag = Nox.toEuint256(uint256(keccak256(abi.encode(domain))));

        euint256 indicator = Nox.select(value, trueTag, falseTag);
        euint256 isolated = Nox.select(epochCondition, indicator, isolationTag);
        return Nox.eq(isolated, trueTag);
    }
}
