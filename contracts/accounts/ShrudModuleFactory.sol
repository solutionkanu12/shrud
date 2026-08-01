// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {ShrudAssetRegistry} from "../assets/ShrudAssetRegistry.sol";
import {IShrudClearingVault} from "../interfaces/IShrudClearingVault.sol";
import {ISafe} from "../interfaces/ISafe.sol";
import {ShrudIntentBook} from "../intents/ShrudIntentBook.sol";
import {ShrudCapsuleFactory} from "../disclosure/ShrudCapsuleFactory.sol";
import {ShrudPauseController} from "../recovery/ShrudPauseController.sol";
import {ShrudSafeModule} from "./ShrudSafeModule.sol";
import {ShrudSafeIntrospection} from "./ShrudSafeIntrospection.sol";

/**
 * @title ShrudModuleFactory
 * @notice Deploys exactly one immutable module — and with it one guard — per Safe.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHY CREATE2, AND WHAT IT BUYS THAT A PLAIN `new` DOES NOT
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The dangerous moment in installing a Safe module is the moment the owners sign `enableModule`.
 * At that point they are granting a contract unlimited authority over the Safe, and the only
 * defence is having reviewed the exact contract first.
 *
 * With CREATE2 the module's address is a pure function of (this factory, the salt, the creation
 * code). So `predictAddresses(safe)` answers "what will I be enabling?" BEFORE anything is
 * deployed, and the answer can be checked against a build of this repository. `ShrudSafeModule`'s
 * bindings are all constructor immutables, so the creation code determines the entire behaviour —
 * there is no post-deployment initialisation step whose outcome the address does not cover.
 *
 * The salt is `keccak256(chainId, safe)`. Including the chain id means the same Safe address on two
 * chains gets two module addresses, so a signature or a review from one chain never transfers.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * ONE MODULE PER SAFE, ENFORCED IN TWO PLACES
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * The salt makes redeployment impossible — CREATE2 to an occupied address reverts. The registry
 * below makes it *legible*: `moduleOf(safe)` is the single answer to "which module governs this
 * Safe", so an indexer, the verifier and the app never have to guess. PRD section 9.1 requires that
 * a module cannot be reused across accounts; the Safe is in the salt AND is a constructor immutable
 * of the module, so a module deployed for one Safe cannot serve another even if somebody enabled it
 * there.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * NO UPGRADE AUTHORITY EXISTS
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * There is no proxy, no admin, no implementation slot and no owner on this factory. PRD section 9.1
 * requires the launch deployment to carry no hidden upgrade authority, and the way to satisfy that
 * requirement is not to document restraint but to have nothing to restrain. Fixing a defect means
 * deploying a new factory and a new module, and every Safe deciding for itself whether to migrate.
 */
contract ShrudModuleFactory {
    using ShrudSafeIntrospection for ISafe;

    // The clearing core this factory binds every module to. Immutable: a factory that could
    // repoint its modules at a different vault would be an upgrade authority wearing a hat.
    ShrudIntentBook public immutable intentBook;
    ShrudAssetRegistry public immutable assetRegistry;
    IShrudClearingVault public immutable clearingVault;
    address public immutable clearingEngine;
    address public immutable capsuleFactory;
    ShrudPauseController public immutable pauseController;

    mapping(address safe => address module) private _moduleOf;
    address[] private _allSafes;

    event ModuleDeployed(
        address indexed safe, address indexed module, address indexed moduleGuard, bytes32 salt
    );

    error ModuleAlreadyDeployed(address safe, address module);
    error SafeIsNotAContract(address safe);
    error DeployedAddressMismatch(address predicted, address actual);

    constructor(
        ShrudIntentBook intentBook_,
        ShrudAssetRegistry assetRegistry_,
        IShrudClearingVault clearingVault_,
        address clearingEngine_,
        address capsuleFactory_,
        ShrudPauseController pauseController_
    ) {
        intentBook = intentBook_;
        assetRegistry = assetRegistry_;
        clearingVault = clearingVault_;
        clearingEngine = clearingEngine_;
        capsuleFactory = capsuleFactory_;
        pauseController = pauseController_;
    }

    // -------------------------------------------------------------------------------------------
    // Deployment
    // -------------------------------------------------------------------------------------------

    /**
     * @notice Deploys the bound module and its guard for `safe`.
     *
     * @dev Permissionless. Deployment grants no authority: a deployed module can do nothing at all
     *      until the Safe's own owners sign `enableModule` and `setModuleGuard`. Making it
     *      permissionless means a treasury can review the deployed bytecode at the predicted address
     *      before signing anything, rather than signing a deployment and a grant together.
     *
     *      THE VERSION CHECK IS HERE AND NOT ONLY IN THE APP. Delta D-1: `setModuleGuard` does not
     *      exist before Safe 1.5.0, so on 1.4.1 the second half of the installation would silently
     *      never happen and the module would run with no boundary. A user interface that warns is
     *      not the same as a contract that refuses.
     */
    function deployModule(ISafe safe) external returns (address module, address moduleGuard) {
        if (address(safe).code.length == 0) revert SafeIsNotAContract(address(safe));

        address existing = _moduleOf[address(safe)];
        if (existing != address(0)) revert ModuleAlreadyDeployed(address(safe), existing);

        safe.requireSupportedVersion();

        (address predictedModule,) = predictAddresses(safe);

        ShrudSafeModule deployed = new ShrudSafeModule{salt: saltFor(safe)}(
            safe, intentBook, assetRegistry, clearingVault, clearingEngine, capsuleFactory, pauseController
        );
        module = address(deployed);
        if (module != predictedModule) revert DeployedAddressMismatch(predictedModule, module);

        moduleGuard = deployed.moduleGuard();

        _moduleOf[address(safe)] = module;
        _allSafes.push(address(safe));

        // The capsule factory only accepts issuers this factory deployed. Registering here rather
        // than in a separate transaction means there is no window in which a module exists and
        // cannot disclose, and no manual step that could be forgotten for one Safe out of four.
        ShrudCapsuleFactory(capsuleFactory).registerModule(module);
        intentBook.authoriseModule(module);

        emit ModuleDeployed(address(safe), module, moduleGuard, saltFor(safe));
    }

    // -------------------------------------------------------------------------------------------
    // Prediction — the review surface
    // -------------------------------------------------------------------------------------------

    function saltFor(ISafe safe) public view returns (bytes32) {
        return keccak256(abi.encode(block.chainid, address(safe)));
    }

    /**
     * @notice The addresses `deployModule(safe)` will produce, computable before it is called.
     *
     * @dev The guard's address is CREATE from the module at nonce 1 — the module's constructor
     *      deploys it as its first and only creation, so `keccak256(rlp([module, 1]))[12:]` is
     *      exact. Both are checked against reality inside `deployModule`, so a change to the
     *      creation code that broke this prediction would fail the deployment loudly instead of
     *      quietly making the review surface wrong.
     */
    function predictAddresses(ISafe safe)
        public
        view
        returns (address module, address moduleGuard)
    {
        bytes32 initCodeHash = keccak256(moduleCreationCode(safe));
        module = address(
            uint160(
                uint256(keccak256(abi.encodePacked(bytes1(0xff), address(this), saltFor(safe), initCodeHash)))
            )
        );
        moduleGuard = _create1(module, 1);
    }

    /// @notice The exact creation code, so a reviewer can rebuild it and compare hashes.
    function moduleCreationCode(ISafe safe) public view returns (bytes memory) {
        return abi.encodePacked(
            type(ShrudSafeModule).creationCode,
            abi.encode(
                safe,
                intentBook,
                assetRegistry,
                clearingVault,
                clearingEngine,
                capsuleFactory,
                pauseController
            )
        );
    }

    // -------------------------------------------------------------------------------------------
    // Registry reads
    // -------------------------------------------------------------------------------------------

    function moduleOf(address safe) external view returns (address) {
        return _moduleOf[safe];
    }

    function allSafes() external view returns (address[] memory) {
        return _allSafes;
    }

    function safeCount() external view returns (uint256) {
        return _allSafes.length;
    }

    /**
     * @notice True when `safe` has a module deployed, enabled, and guarded by that module's guard.
     *
     * @dev All three, because any two without the third is a broken installation that looks fine.
     *      A deployed-but-not-enabled module does nothing. An enabled module with no guard has
     *      unlimited authority over the Safe. A guard installed without the module enabled guards
     *      nothing. The onboarding flow shows this as one verdict rather than three checkboxes.
     */
    function isFullyInstalled(ISafe safe) external view returns (bool) {
        address module = _moduleOf[address(safe)];
        if (module == address(0)) return false;
        if (!safe.isModuleEnabled(module)) return false;
        return safe.moduleGuardOf() == ShrudSafeModule(module).moduleGuard();
    }

    /// @dev The address a contract creates at a given nonce. Only nonces 1..127 are needed here.
    function _create1(address deployer, uint8 nonce) private pure returns (address) {
        return address(
            uint160(uint256(keccak256(abi.encodePacked(bytes2(0xd694), deployer, bytes1(nonce)))))
        );
    }
}
