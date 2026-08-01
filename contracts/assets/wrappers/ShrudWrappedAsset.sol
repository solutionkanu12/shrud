// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {IERC7984} from "@iexec-nox/nox-confidential-contracts/contracts/interfaces/IERC7984.sol";
import {ERC7984Base} from "@iexec-nox/nox-confidential-contracts/contracts/token/ERC7984Base.sol";
import {ERC20ToERC7984Wrapper} from
    "@iexec-nox/nox-confidential-contracts/contracts/token/extensions/ERC20ToERC7984Wrapper.sol";
import {IERC20} from "@openzeppelin/contracts/interfaces/IERC20.sol";

/**
 * @title ShrudWrappedAsset
 * @notice The official ERC-7984 wrapper for one registered underlying, with two bounds the
 *         maintained implementation deliberately leaves open.
 *
 * WHAT IS INHERITED AND WHY IT IS NOT REIMPLEMENTED. `ERC20ToERC7984Wrapper` from
 * `nox-confidential-contracts` 0.2.2 is the maintained wrap/unwrap implementation, and
 * PRD section 9.4 requires shrud's wrappers to inherit it rather than fork it. `wrap` mints 1:1
 * against a real `safeTransferFrom`, so the reserve is the contract's own ERC-20 balance and
 * `inferredTotalSupply()` is that balance — not a number this contract maintains and could get
 * wrong. `unwrap` is deliberately two-step: `_burn` produces a fresh handle, the handle is marked
 * publicly decryptable, and `finalizeUnwrap` pays out against the gateway's proof.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * BOUND 1 · A SUPPLY CEILING
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The base's `maxTotalSupply()` returns `type(uint256).max`, so `_checkConfidentialTotalSupply`
 * never reverts and the base is uncapped by default. shrud caps it at deployment. This is not
 * about scarcity: it bounds the blast radius of a defect in a system where a confidential balance
 * cannot be audited by summing it. If something goes wrong, the ceiling is the difference between
 * a bounded incident and an unbounded one.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * BOUND 2 · OPERATOR LIFETIME
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * THIS IS THE SHARPEST EDGE IN ERC-7984 AND IT IS EASY TO MISS. An operator has **no per-amount
 * allowance**. `isOperator(holder, spender)` is a boolean with an expiry, and `_unwrap` accepts
 * `from == msg.sender || isOperator(from, msg.sender)`. So an operator on a wrapper can unwrap a
 * holder's ENTIRE confidential balance to ANY address, in one call, with no further authorisation.
 *
 * The base accepts any `until`, including `type(uint48).max`. A Safe that grants shrud an
 * unbounded operator has handed over its whole balance permanently, and would find that out only
 * if something went wrong. `setOperator` here therefore refuses any `until` more than
 * `MAX_OPERATOR_LIFETIME` in the future — the Safe re-grants each session, and the app shows the
 * expiry with a countdown rather than burying it.
 *
 * The bound is enforced in the contract rather than in the interface because the interface is not
 * where a mistake gets made.
 */
contract ShrudWrappedAsset is ERC20ToERC7984Wrapper {
    /// @notice Thirty days. A shrud module's operator grant is re-issued per shielding session.
    uint48 public constant MAX_OPERATOR_LIFETIME = 30 days;

    uint256 private immutable _maxTotalSupply;

    event OperatorLifetimeRefused(address indexed holder, address indexed operator, uint48 until);

    error MaxTotalSupplyIsZero();
    error OperatorLifetimeTooLong(uint48 until, uint48 maximum);
    error OperatorIsNotAContract(address operator);

    constructor(
        string memory name_,
        string memory symbol_,
        string memory contractURI_,
        IERC20 underlying_,
        uint256 maxTotalSupply_
    ) ERC20ToERC7984Wrapper(name_, symbol_, contractURI_, underlying_) {
        if (maxTotalSupply_ == 0) revert MaxTotalSupplyIsZero();
        _maxTotalSupply = maxTotalSupply_;
    }

    /// @notice The ceiling `_checkConfidentialTotalSupply` measures every mint against.
    function maxTotalSupply() public view override returns (uint256) {
        return _maxTotalSupply;
    }

    /**
     * @notice Grants an operator, with a bounded lifetime and only to a contract.
     *
     * @dev TWO REFUSALS, EACH FOR A DIFFERENT REASON.
     *
     *      `until` is bounded because an unbounded operator grant on an ERC-7984 wrapper is
     *      equivalent to handing over the balance — see the contract header.
     *
     *      The operator must be a CONTRACT because shrud's operator is always the immutable
     *      Safe-bound module and never an EOA (PRD section 20.3). An EOA operator is a private key
     *      that can unwrap a treasury's whole confidential balance to itself, and no on-chain rule
     *      afterwards can constrain what it does. Refusing at the point of grant is the only place
     *      the constraint can bind.
     *
     *      Revocation is `setOperator(operator, 0)`, which is unaffected by either check: `until`
     *      of 0 is in the past, and revoking an EOA that was somehow granted must never be blocked
     *      by the contract check. Both are handled by the early return below.
     */
    function setOperator(address operator, uint48 until) public override(ERC7984Base, IERC7984) {
        if (until <= block.timestamp) {
            super.setOperator(operator, until);
            return;
        }

        uint48 maximum = uint48(block.timestamp) + MAX_OPERATOR_LIFETIME;
        if (until > maximum) {
            emit OperatorLifetimeRefused(msg.sender, operator, until);
            revert OperatorLifetimeTooLong(until, maximum);
        }
        if (operator.code.length == 0) revert OperatorIsNotAContract(operator);

        super.setOperator(operator, until);
    }
}
