// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

import {Nox, ebool, euint256} from "@iexec-nox/nox-protocol-contracts/contracts/sdk/Nox.sol";

import {ShrudHandleIsolation} from "../base/ShrudHandleIsolation.sol";
import {ISafe} from "../interfaces/ISafe.sol";
import {ShrudPauseController} from "../recovery/ShrudPauseController.sol";

/**
 * @title ShrudCapsuleFactory
 * @notice Frozen selective disclosure. A dated snapshot, not a key to the treasury.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE WHOLE DESIGN FOLLOWS FROM ONE FACT: NOX HAS NO `removeViewer`
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * Verified against `sdk/Nox.sol` 0.2.4 — there is no `removeViewer`, no `removeAdmin`, and no way
 * to un-set `allowPublicDecryption`. `disallowTransient` is the only revocation that exists, and it
 * only undoes a grant that would have expired at the end of the transaction anyway.
 *
 * So the obvious design — grant the auditor viewer rights on the Safe's live balance handle, revoke
 * when the engagement ends — is not merely bad practice. It is **impossible to undo**. The auditor
 * would hold that grant for as long as the handle exists, which for a balance handle means until
 * the next operation replaces it, and for a historical handle means forever.
 *
 * PRD section 3.2.9 states the consequence as a non-goal: shrud does not grant auditors revocable
 * access to live handles, because access to an existing handle is permanent.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * WHAT A CAPSULE ACTUALLY IS
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * A capsule COPIES each selected value into a FRESH handle and grants the viewer that copy. The
 * copy has the same plaintext and a different lineage. The viewer can decrypt the snapshot forever
 * — that is the point of a signed report — and learns nothing about the treasury afterwards,
 * because every subsequent value lives in handles they hold no grant on.
 *
 * The copy is made by `_isolate` under a domain that mixes in the RECIPIENT. That last part is not
 * decoration: two capsules over the same balance, issued to two different auditors, would otherwise
 * be byte-identical handles — one handle, one ACL entry, two auditors, and each of them able to
 * decrypt anything the other was ever shown. Handles are deterministic in their operands (delta
 * D-5), so this is the default outcome and not an edge case.
 *
 * ════════════════════════════════════════════════════════════════════════════════════════════
 * THE WORDS THE INTERFACE IS ALLOWED TO USE
 * ════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `archive` hides a capsule from default navigation. It does NOT revoke anything and cannot. The
 * interface must say "live access ended", "future snapshots disabled", or "this historical snapshot
 * remains available" — never "revoked", and never "access removed". PRD section 20.9 is explicit,
 * and a product that says "revoked" about a permanent grant has told its user something false about
 * their own confidentiality.
 */
contract ShrudCapsuleFactory is ShrudHandleIsolation {
    /// @notice The reviewed report shapes. PRD section 9.14.
    enum CapsuleSchema {
        None,
        ProofOfReserves,
        BoardAllocationReport,
        TaxPeriodSettlementStatement,
        CounterpartySolvencyReport,
        InternalCrossReceipt,
        SingleResidualSettlementReceipt,
        PooledPositionOwnershipReport
    }

    enum CapsuleStatus {
        None,
        Available,
        Archived
    }

    struct Capsule {
        CapsuleSchema schema;
        CapsuleStatus status;
        address issuingSafe;
        address module;
        address viewer;
        /// The epoch or position the snapshot was taken over. Public, and part of the evidence.
        bytes32 subjectId;
        uint64 snapshotBlock;
        uint64 snapshotTimestamp;
        /// The fresh handles. Never the live ones.
        bytes32[] fields;
        /// Human-readable field names, so a report is legible without the issuing app.
        string[] fieldNames;
    }

    mapping(bytes32 capsuleId => Capsule) private _capsules;
    mapping(address safe => bytes32[]) private _capsulesOfSafe;
    mapping(address viewer => bytes32[]) private _capsulesForViewer;
    mapping(address module => bool) private _registeredModules;

    address public immutable moduleFactory;

    event CapsuleCreated(
        bytes32 indexed capsuleId,
        address indexed issuingSafe,
        address indexed viewer,
        CapsuleSchema schema,
        bytes32 subjectId,
        uint256 fieldCount
    );
    event CapsuleArchived(bytes32 indexed capsuleId);

    error NotARegisteredModule(address caller);
    error ViewerIsZero();
    error ViewerIsTheIssuingSafe(address viewer);
    error SchemaIsNone();
    error FieldCountMismatch(uint256 handles, uint256 names);
    error NoFields();
    error TooManyFields(uint256 supplied, uint256 maximum);
    error CapsuleAlreadyExists(bytes32 capsuleId);
    error CapsuleUnknown(bytes32 capsuleId);
    error NotTheIssuingModule(address caller, address expected);

    /// @notice Bounded so one capsule cannot become an unbounded live-state export.
    uint256 public constant MAX_FIELDS = 24;

    constructor(address moduleFactory_, ShrudPauseController pauseController_)
        ShrudHandleIsolation(pauseController_)
    {
        moduleFactory = moduleFactory_;
    }

    /// @notice Capsules never hand a transient handle to anyone. The allowlist is empty on purpose.
    function isReviewedTransientRecipient(address) public pure override returns (bool) {
        return false;
    }

    /**
     * @notice Creates one frozen capsule.
     *
     * @dev CALLED BY THE ISSUING SAFE'S MODULE, WHICH HAS ALREADY CHECKED THE SAFE'S THRESHOLD.
     *      Disclosure is a treasury decision, not an operational one — a single owner must not be
     *      able to hand a counterparty a solvency report. The module performs the `checkSignatures`;
     *      this contract's job is to make the copy correctly.
     *
     * @param liveHandles the values being snapshotted. These are the LIVE handles; they are copied
     *        and the copies are what the viewer is granted. The live handles are never granted.
     */
    function createCapsule(
        address issuingSafe,
        address viewer,
        CapsuleSchema schema,
        bytes32 subjectId,
        euint256[] calldata liveHandles,
        string[] calldata fieldNames
    ) external returns (bytes32 capsuleId) {
        pauseController.requireLive(ShrudPauseController.Activity.Disclose);
        if (!_registeredModules[msg.sender]) revert NotARegisteredModule(msg.sender);
        if (viewer == address(0)) revert ViewerIsZero();
        // A capsule to the Safe itself is a no-op that looks like a disclosure. The Safe's own
        // owners already hold every live handle.
        if (viewer == issuingSafe) revert ViewerIsTheIssuingSafe(viewer);
        if (schema == CapsuleSchema.None) revert SchemaIsNone();
        if (liveHandles.length == 0) revert NoFields();
        if (liveHandles.length > MAX_FIELDS) revert TooManyFields(liveHandles.length, MAX_FIELDS);
        if (liveHandles.length != fieldNames.length) {
            revert FieldCountMismatch(liveHandles.length, fieldNames.length);
        }

        capsuleId = keccak256(
            abi.encode(
                block.chainid, address(this), issuingSafe, viewer, schema, subjectId, block.number
            )
        );
        if (_capsules[capsuleId].status != CapsuleStatus.None) revert CapsuleAlreadyExists(capsuleId);

        // The epoch condition anchors the copies to THIS capsule. `_buildEpochCondition` requires a
        // confidential anchor and reverts on a public handle — so a capsule over a value that was
        // never confidential fails here rather than producing a snapshot that discloses nothing and
        // claims to.
        ebool condition = _buildEpochCondition(capsuleId, liveHandles[0]);

        bytes32[] memory copies = new bytes32[](liveHandles.length);
        for (uint256 i = 0; i < liveHandles.length; ++i) {
            // The recipient is mixed into the isolation domain. Without it, two capsules over the
            // same balance issued to two auditors are ONE handle with ONE ACL entry — see the
            // header. `uint256(uint160(viewer))` and the index together make the domain unique per
            // (capsule, viewer, field).
            bytes32 domain = keccak256(
                abi.encode(isolationDomain(capsuleId, ROLE_CAPSULE_FIELD, i), viewer)
            );
            euint256 copy = _isolate(liveHandles[i], condition, domain);

            // The exact grant: this contract, the issuing Safe's module, and the chosen viewer.
            // Nothing else, ever, and none of it revocable.
            Nox.allowThis(copy);
            Nox.addViewer(copy, viewer);
            copies[i] = euint256.unwrap(copy);
        }

        Capsule storage capsule = _capsules[capsuleId];
        capsule.schema = schema;
        capsule.status = CapsuleStatus.Available;
        capsule.issuingSafe = issuingSafe;
        capsule.module = msg.sender;
        capsule.viewer = viewer;
        capsule.subjectId = subjectId;
        capsule.snapshotBlock = uint64(block.number);
        capsule.snapshotTimestamp = uint64(block.timestamp);
        capsule.fields = copies;
        for (uint256 i = 0; i < fieldNames.length; ++i) {
            capsule.fieldNames.push(fieldNames[i]);
        }

        _capsulesOfSafe[issuingSafe].push(capsuleId);
        _capsulesForViewer[viewer].push(capsuleId);

        emit CapsuleCreated(capsuleId, issuingSafe, viewer, schema, subjectId, copies.length);
    }

    /**
     * @notice Hides a capsule from default navigation.
     *
     * @dev NOT REVOCATION. The viewer's grant on the snapshot handles is untouched and cannot be
     *      touched. This changes one boolean in a listing. The event name, the status name and every
     *      string the interface renders must reflect that — see the contract header.
     */
    function archiveCapsule(bytes32 capsuleId) external {
        Capsule storage capsule = _capsules[capsuleId];
        if (capsule.status == CapsuleStatus.None) revert CapsuleUnknown(capsuleId);
        if (msg.sender != capsule.module) revert NotTheIssuingModule(msg.sender, capsule.module);
        capsule.status = CapsuleStatus.Archived;
        emit CapsuleArchived(capsuleId);
    }

    /// @notice Registers a Safe-bound module as an issuer. Called once by the module factory.
    function registerModule(address module) external {
        if (msg.sender != moduleFactory) revert NotARegisteredModule(msg.sender);
        _registeredModules[module] = true;
    }

    // -------------------------------------------------------------------------------------------
    // Reads
    // -------------------------------------------------------------------------------------------

    function capsuleOf(bytes32 capsuleId) external view returns (Capsule memory) {
        return _capsules[capsuleId];
    }

    function capsulesOfSafe(address safe) external view returns (bytes32[] memory) {
        return _capsulesOfSafe[safe];
    }

    function capsulesForViewer(address viewer) external view returns (bytes32[] memory) {
        return _capsulesForViewer[viewer];
    }

    function isRegisteredModule(address module) external view returns (bool) {
        return _registeredModules[module];
    }

    /**
     * @notice Whether `viewer` can decrypt a given capsule field, read from the chain.
     *
     * @dev Reads NoxCompute directly rather than an indexer. An authorisation answer that depends on
     *      a subgraph being up is an authorisation answer that is sometimes wrong, and the direction
     *      it is wrong in — "you cannot read this" when you can — is the one that misleads a user
     *      about their own confidentiality.
     */
    function canViewerDecrypt(bytes32 capsuleId, uint256 fieldIndex, address viewer)
        external
        view
        returns (bool)
    {
        Capsule storage capsule = _capsules[capsuleId];
        if (capsule.status == CapsuleStatus.None) revert CapsuleUnknown(capsuleId);
        return Nox.isViewer(euint256.wrap(capsule.fields[fieldIndex]), viewer);
    }
}
