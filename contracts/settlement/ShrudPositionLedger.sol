// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";

import {Nox, ebool, euint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

import {ShrudHandleIsolation} from "../base/ShrudHandleIsolation.sol";
import {ShrudPauseController} from "../recovery/ShrudPauseController.sol";

/**
 * @title ShrudPositionLedger
 * @notice The public pooled position, and the confidential ownership behind it.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT IS PUBLIC HERE, STATED PLAINLY
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The aToken balance of this contract is public and always will be. Anyone can read it, and shrud
 * does not pretend otherwise — PRD section 6.1 lists the aggregate Aave supply as public at
 * settlement.
 *
 * What is confidential is the only thing that was ever attributable: **whose it is**. Each Safe's
 * share is an encrypted handle. The sum of shares equals the encrypted total, and the encrypted
 * total corresponds to the public position through an index derived from two public numbers — so
 * the reconciliation is checkable without any share being readable.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHY SHARES AND NOT BALANCES
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Aave's aTokens rebase: a holder's balance grows as interest accrues, with no transfer and no
 * event per holder. If this ledger stored each Safe's confidential BALANCE, every accrual would
 * need one encrypted update per Safe — which Nox charges per primitive, with no batch entry point,
 * so cost would grow with participants times blocks.
 *
 * Storing SHARES makes accrual free. The share count does not change when interest accrues; the
 * public position does, and every share is worth proportionally more. A withdrawal converts shares
 * to assets at the ratio of the two public numbers at that moment.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE FIRST DEPOSIT SETS THE RATIO, AND THAT IS AN ATTACK SURFACE EVERYWHERE ELSE
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Share-based vaults are routinely drained by an attacker depositing 1 wei, donating a large amount
 * directly to the vault, and rounding every subsequent depositor's shares to zero. shrud is immune
 * for a reason worth naming rather than assuming: **there is no public deposit function.** Shares
 * are minted only by the settlement engine, only against an aggregate that a sealed epoch produced,
 * and only for candidates that a confidential clearing run selected. A donation to this contract
 * inflates the position for existing holders and mints nothing to the donor.
 *
 * `INITIAL_SHARES_PER_ASSET` fixes the opening ratio at deployment rather than deriving it from the
 * first deposit, so even the first epoch has no special case.
 */
contract ShrudPositionLedger is ShrudHandleIsolation {
    using SafeERC20 for IERC20;

    /// @notice Shares minted per unit of asset for the first supply. A constant, not a first-mover.
    uint256 public constant INITIAL_SHARES_PER_ASSET = 1e12;

    struct Position {
        address adapter;
        address asset;
        address aToken;
        /// Public. The sum of every aggregate supplied, less every aggregate withdrawn.
        uint256 publicPrincipal;
        /// Encrypted. The sum of every Safe's share balance, less dust.
        bytes32 totalShares;
        bool open;
    }

    address public immutable deployer;
    address public settlementEngine;
    bool private _wired;

    mapping(bytes32 positionId => Position) private _positions;
    mapping(bytes32 positionId => mapping(address safe => bytes32)) private _shares;
    mapping(bytes32 positionId => mapping(address safe => bytes32)) private _pendingWithdrawal;
    bytes32[] private _positionIds;

    event PositionOpened(bytes32 indexed positionId, address indexed adapter, address asset);
    event SharesMinted(bytes32 indexed positionId, address indexed safe, bytes32 epochId);
    event SharesBurned(bytes32 indexed positionId, address indexed safe, bytes32 epochId);
    event PrincipalChanged(bytes32 indexed positionId, uint256 principalBefore, uint256 principalAfter);
    event Wired(address settlementEngine);

    error NotDeployer(address caller);
    error AlreadyWired();
    error NotSettlementEngine(address caller);
    error PositionAlreadyOpen(bytes32 positionId);
    error PositionNotOpen(bytes32 positionId);
    error AmountIsZero();

    constructor(ShrudPauseController pauseController_) ShrudHandleIsolation(pauseController_) {
        deployer = msg.sender;
    }

    function wire(address settlementEngine_) external {
        if (msg.sender != deployer) revert NotDeployer(msg.sender);
        if (_wired) revert AlreadyWired();
        _wired = true;
        settlementEngine = settlementEngine_;
        emit Wired(settlementEngine_);
    }

    function isReviewedTransientRecipient(address recipient) public view override returns (bool) {
        return recipient == settlementEngine;
    }

    modifier onlySettlementEngine() {
        if (msg.sender != settlementEngine) revert NotSettlementEngine(msg.sender);
        _;
    }

    // -------------------------------------------------------------------------------------------
    // Positions
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Opens a pooled position.
     *
     * @dev The DEPLOYER may open a position during setup, and the settlement engine may open one
     *      afterwards. Restricting this to the engine alone would mean the first position could only
     *      exist after the first supply had already been verified — which needs a position to supply
     *      into. Opening a position grants nothing and holds nothing: it records an adapter, an asset
     *      and an aToken, and every path that moves value still runs through the engine.
     */
    function openPosition(bytes32 positionId, address adapter, address asset, address aToken) external {
        if (msg.sender != settlementEngine && msg.sender != deployer) {
            revert NotSettlementEngine(msg.sender);
        }
        if (_positions[positionId].open) revert PositionAlreadyOpen(positionId);
        _positions[positionId] = Position({
            adapter: adapter,
            asset: asset,
            aToken: aToken,
            publicPrincipal: 0,
            totalShares: bytes32(0),
            open: true
        });
        _positionIds.push(positionId);
        emit PositionOpened(positionId, adapter, asset);
    }

    /**
     * @notice Records an aggregate supply and the share price it minted at.
     *
     * @dev The conversion ratio is PUBLIC and derived from two public numbers — the position's
     *      principal before this supply, and the total shares outstanding expressed as a public
     *      scalar. shrud does not have the latter as plaintext, so the ratio is carried the other
     *      way: `sharesPerAsset` is computed from the public principal alone, and each Safe's share
     *      mint is `contribution * sharesPerAsset` in encrypted arithmetic.
     *
     *      Making the RATIO public and each CONTRIBUTION private is the correct split. The ratio is
     *      derivable by anyone from the public position anyway; publishing it explicitly means an
     *      auditor can reconcile the pool without any share being readable, which is exactly what
     *      the disclosure capsules need.
     */
    function recordSupply(bytes32 positionId, uint256 aggregateSupplied)
        external
        onlySettlementEngine
        returns (uint256 sharesPerAsset)
    {
        Position storage position = _positions[positionId];
        if (!position.open) revert PositionNotOpen(positionId);
        if (aggregateSupplied == 0) revert AmountIsZero();

        uint256 principalBefore = position.publicPrincipal;
        sharesPerAsset = principalBefore == 0
            ? INITIAL_SHARES_PER_ASSET
            : _currentSharesPerAsset(position, principalBefore);

        position.publicPrincipal = principalBefore + aggregateSupplied;
        emit PrincipalChanged(positionId, principalBefore, position.publicPrincipal);
    }

    /// @notice Mints one Safe's encrypted share of an aggregate supply.
    function mintShares(
        bytes32 positionId,
        bytes32 epochId,
        address safe,
        euint256 shares,
        address[] calldata safeOwners
    ) external onlySettlementEngine {
        Position storage position = _positions[positionId];
        if (!position.open) revert PositionNotOpen(positionId);

        euint256 previous = _load(_shares[positionId][safe]);
        euint256 updated = Nox.add(previous, shares);
        euint256 total = Nox.add(_load(position.totalShares), shares);

        Nox.allowThis(updated);
        Nox.allowThis(total);
        for (uint256 i = 0; i < safeOwners.length; ++i) {
            Nox.allow(updated, safeOwners[i]);
        }

        _shares[positionId][safe] = euint256.unwrap(updated);
        position.totalShares = euint256.unwrap(total);

        emit SharesMinted(positionId, safe, epochId);
    }

    /**
     * @notice Burns shares against a confidential withdrawal request.
     *
     * @dev PRD invariant 21.4.2 — one Safe cannot withdraw more shares than it owns. `safeSub`
     *      returns encrypted false and encrypted zero on underflow, and the flag is threaded through
     *      `select` so an over-request burns nothing and receives nothing. It does not revert, and
     *      it must not: a public revert on "you asked for more than you have" is a balance oracle
     *      that answers one bit per transaction.
     */
    function burnShares(
        bytes32 positionId,
        bytes32 epochId,
        address safe,
        euint256 requested,
        euint256 zero
    ) external onlySettlementEngine returns (euint256 burned) {
        Position storage position = _positions[positionId];
        if (!position.open) revert PositionNotOpen(positionId);

        euint256 held = _load(_shares[positionId][safe]);
        (ebool ok, euint256 remaining) = Nox.safeSub(held, requested);

        burned = Nox.select(ok, requested, zero);
        euint256 updated = Nox.select(ok, remaining, held);
        euint256 total = _subOrKeep(_load(position.totalShares), burned);

        Nox.allowThis(updated);
        Nox.allowThis(total);
        Nox.allowThis(burned);

        _shares[positionId][safe] = euint256.unwrap(updated);
        position.totalShares = euint256.unwrap(total);

        emit SharesBurned(positionId, safe, epochId);
    }

    function recordWithdrawal(bytes32 positionId, uint256 aggregateWithdrawn)
        external
        onlySettlementEngine
    {
        Position storage position = _positions[positionId];
        if (!position.open) revert PositionNotOpen(positionId);
        uint256 principalBefore = position.publicPrincipal;
        position.publicPrincipal =
            aggregateWithdrawn >= principalBefore ? 0 : principalBefore - aggregateWithdrawn;
        emit PrincipalChanged(positionId, principalBefore, position.publicPrincipal);
    }

    /// @notice Approves the adapter to pull aTokens for an aggregate withdrawal.
    function approveWithdrawal(bytes32 positionId, uint256 amount) external onlySettlementEngine {
        Position storage position = _positions[positionId];
        if (!position.open) revert PositionNotOpen(positionId);
        IERC20(position.aToken).forceApprove(position.adapter, amount);
    }

    // -------------------------------------------------------------------------------------------
    // Reads
    // -------------------------------------------------------------------------------------------

    /// @notice The public pooled position, live from Aave. Rebasing, so always read rather than stored.
    function publicPositionValue(bytes32 positionId) public view returns (uint256) {
        Position storage position = _positions[positionId];
        if (!position.open) return 0;
        return IERC20(position.aToken).balanceOf(address(this));
    }

    function positionOf(bytes32 positionId) external view returns (Position memory) {
        return _positions[positionId];
    }

    /// @notice One Safe's encrypted share. Decryptable only by that Safe's current owners.
    function shareOf(bytes32 positionId, address safe) external view returns (euint256) {
        return euint256.wrap(_shares[positionId][safe]);
    }

    function pendingWithdrawalOf(bytes32 positionId, address safe) external view returns (euint256) {
        return euint256.wrap(_pendingWithdrawal[positionId][safe]);
    }

    function positionIds() external view returns (bytes32[] memory) {
        return _positionIds;
    }

    function isWired() external view returns (bool) {
        return _wired;
    }

    // -------------------------------------------------------------------------------------------
    // Internals
    // -------------------------------------------------------------------------------------------

    /**
     * @dev Shares per asset at the current accrued value.
     *
     * `principal` is what was supplied; `publicPositionValue` is what it has grown to. The ratio of
     * the two is the accrual factor, and dividing the opening ratio by it gives the rate at which a
     * new supplier buys in. Both inputs are public, so the result is public and reproducible — which
     * is what lets an auditor reconcile the pool from chain state alone.
     */
    function _currentSharesPerAsset(Position storage position, uint256 principal)
        private
        view
        returns (uint256)
    {
        uint256 value = IERC20(position.aToken).balanceOf(address(this));
        if (value == 0) return INITIAL_SHARES_PER_ASSET;
        return (INITIAL_SHARES_PER_ASSET * principal) / value;
    }

    function _load(bytes32 handle) private pure returns (euint256) {
        return euint256.wrap(handle);
    }

    /**
     * @dev `a - b` when it succeeds, and `a` UNCHANGED when it does not.
     *
     * The failure branch returns `a`, not zero. Returning zero would be the obvious shape and it is
     * catastrophically wrong here: a single underflowing burn would silently wipe the position's
     * entire encrypted total-share count, and because the value is a ciphertext nothing would
     * observe it until the reconciliation check failed several epochs later with no way to say when
     * it broke. `select` makes a failed subtraction a no-op, which is what it means.
     */
    function _subOrKeep(euint256 a, euint256 b) private returns (euint256) {
        (ebool ok, euint256 result) = Nox.safeSub(a, b);
        return Nox.select(ok, result, a);
    }
}
