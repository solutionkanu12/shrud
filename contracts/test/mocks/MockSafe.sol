// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {ISafe, SafeEnum} from "../../interfaces/ISafe.sol";

/**
 * @title MockSafe
 * @notice A Safe 1.5.0 stand-in for the Foundry suite. Deliberately NOT a Safe.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT THIS IS FOR, AND WHAT IT IS EXPLICITLY NOT EVIDENCE OF
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * It exists to make the module guard's allowlist and the intent book's state machine fuzzable at
 * thousands of runs, which needs a Safe whose owner set and threshold a test can set in one call.
 *
 * It is **not** evidence that shrud works with Safe. It reimplements `checkSignatures` as a stub,
 * so a test passing here says nothing about signature packing, EIP-1271 owners, approved hashes, or
 * the `executor` semantics that delta D-2 turns on. Those are proven in `test/fork/SafeInterface.t.sol`
 * against the REAL Safe 1.5.0 singleton on a Sepolia fork, and nowhere else.
 *
 * The split is deliberate and is the same one this repository draws everywhere: mocks for shrud's
 * own logic, real contracts for anything on the protocol path.
 */
contract MockSafe is ISafe {
    address[] private _owners;
    uint256 private _threshold;
    mapping(address => bool) private _isOwner;
    mapping(address => bool) private _modules;
    mapping(address => mapping(bytes32 => uint256)) private _approvedHashes;
    address private _moduleGuard;
    uint256 private _nonce;
    string private _version = "1.5.0";

    /// @dev When true, `checkSignatures` reverts. Lets a test assert the refusal path.
    bool public refuseSignatures;

    /// @dev Records every module call, so a guard test can assert what actually reached the Safe.
    struct ModuleCall {
        address to;
        uint256 value;
        bytes data;
        SafeEnum.Operation operation;
    }

    ModuleCall[] public moduleCalls;

    error CheckSignaturesRefused();

    constructor(address[] memory owners_, uint256 threshold_) {
        _owners = owners_;
        _threshold = threshold_;
        for (uint256 i = 0; i < owners_.length; ++i) {
            _isOwner[owners_[i]] = true;
        }
    }

    // --- test controls ---------------------------------------------------------------------

    function setOwners(address[] calldata owners_, uint256 threshold_) external {
        for (uint256 i = 0; i < _owners.length; ++i) {
            _isOwner[_owners[i]] = false;
        }
        _owners = owners_;
        _threshold = threshold_;
        for (uint256 i = 0; i < owners_.length; ++i) {
            _isOwner[owners_[i]] = true;
        }
    }

    function setVersion(string calldata version_) external {
        _version = version_;
    }

    function setRefuseSignatures(bool refuse) external {
        refuseSignatures = refuse;
    }

    function moduleCallCount() external view returns (uint256) {
        return moduleCalls.length;
    }

    // --- ISafe -----------------------------------------------------------------------------

    function checkSignatures(address, bytes32, bytes memory) external view override {
        if (refuseSignatures) revert CheckSignaturesRefused();
    }

    function checkNSignatures(address, bytes32, bytes memory, uint256) external view override {
        if (refuseSignatures) revert CheckSignaturesRefused();
    }

    function approvedHashes(address owner, bytes32 h) external view override returns (uint256) {
        return _approvedHashes[owner][h];
    }

    function domainSeparator() external view override returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(this)));
    }

    function getOwners() external view override returns (address[] memory) {
        return _owners;
    }

    function getThreshold() external view override returns (uint256) {
        return _threshold;
    }

    function isOwner(address owner) external view override returns (bool) {
        return _isOwner[owner];
    }

    /**
     * @dev Mirrors the real Safe in the one behaviour that matters here: it calls the module guard
     *      before and after, and it does NOT revert when the inner call fails — it returns `false`.
     *      A mock that reverted on failure would hide exactly the defect
     *      `ShrudModuleGuard.checkAfterModuleExecution` exists to convert into a revert.
     */
    function execTransactionFromModule(
        address to,
        uint256 value,
        bytes memory data,
        SafeEnum.Operation operation
    ) public override returns (bool success) {
        bytes32 guardHash;
        address guard = _moduleGuard;
        if (guard != address(0)) {
            guardHash = IMockModuleGuard(guard).checkModuleTransaction(
                to, value, data, operation, msg.sender
            );
        }

        moduleCalls.push(ModuleCall({to: to, value: value, data: data, operation: operation}));

        if (operation == SafeEnum.Operation.Call) {
            (success,) = to.call{value: value}(data);
        } else {
            (success,) = to.delegatecall(data);
        }

        if (guard != address(0)) {
            IMockModuleGuard(guard).checkAfterModuleExecution(guardHash, success);
        }
    }

    function execTransactionFromModuleReturnData(
        address to,
        uint256 value,
        bytes memory data,
        SafeEnum.Operation operation
    ) external override returns (bool success, bytes memory returnData) {
        success = execTransactionFromModule(to, value, data, operation);
        returnData = "";
    }

    function isModuleEnabled(address module) external view override returns (bool) {
        return _modules[module];
    }

    function enableModule(address module) external {
        _modules[module] = true;
    }

    function disableModule(address module) external {
        _modules[module] = false;
    }

    function getModulesPaginated(address, uint256)
        external
        pure
        override
        returns (address[] memory array, address next)
    {
        array = new address[](0);
        next = address(0);
    }

    function setModuleGuard(address moduleGuard_) external override {
        _moduleGuard = moduleGuard_;
    }

    function VERSION() external view override returns (string memory) {
        return _version;
    }

    function nonce() external view override returns (uint256) {
        return _nonce;
    }

    /// @dev Answers the module-guard slot read the same way a real Safe does.
    function getStorageAt(uint256 offset, uint256 length) external view override returns (bytes memory) {
        bytes32 slot = 0xb104e0b93118902c651344349b610029d694cfdec91c589c91ebafbcd0289947;
        if (bytes32(offset) == slot && length == 1) {
            return abi.encode(_moduleGuard);
        }
        return new bytes(length * 32);
    }
}

interface IMockModuleGuard {
    function checkModuleTransaction(
        address to,
        uint256 value,
        bytes memory data,
        SafeEnum.Operation operation,
        address module
    ) external returns (bytes32);

    function checkAfterModuleExecution(bytes32 txHash, bool success) external;
}
