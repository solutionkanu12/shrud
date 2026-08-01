// SPDX-License-Identifier: GPL-3.0-or-later
pragma solidity 0.8.36;

/**
 * @title ShrudDecodedValue
 * @notice Reads a gateway-decrypted plaintext at its natural width.
 *
 * THE DEFECT THIS EXISTS TO PREVENT — delta D-12. `INoxCompute.validateDecryptionProof` returns
 * `bytes memory` holding the plaintext at the type's NATURAL width, not ABI-padded to 32 bytes. A
 * published `euint16` comes back as exactly two bytes and a published `ebool` as one.
 * `abi.decode(result, (uint256))` on either reverts with no reason string at all — the failure names
 * nothing, points nowhere, and looks like a gateway outage rather than a decoding mistake.
 *
 * `Nox.publicDecrypt`'s own typed overloads check `result.length` per type and are the preferred
 * path wherever the encrypted type is known at the call site. This library is for the places that
 * receive raw `bytes` from a verification helper and must normalise before comparing.
 */
library ShrudDecodedValue {
    error UnexpectedWidth(uint256 length);
    error ValueTooWide(uint256 length);
    error NotABoolean(uint8 raw);

    /// @dev Normalises 1, 2, 4, 8, 16 or 32 bytes of big-endian plaintext into a `uint256`.
    function toUint(bytes memory raw) internal pure returns (uint256 value) {
        uint256 length = raw.length;
        if (length == 0 || length > 32) revert ValueTooWide(length);
        for (uint256 i = 0; i < length; ++i) {
            value = (value << 8) | uint8(raw[i]);
        }
    }

    /// @dev A published `ebool` is exactly one byte and is exactly 0x00 or 0x01.
    function toBool(bytes memory raw) internal pure returns (bool) {
        if (raw.length != 1) revert UnexpectedWidth(raw.length);
        uint8 b = uint8(raw[0]);
        if (b > 1) revert NotABoolean(b);
        return b == 1;
    }

    /// @dev A published `euint16` is exactly two bytes.
    function toUint16(bytes memory raw) internal pure returns (uint16) {
        if (raw.length != 2) revert UnexpectedWidth(raw.length);
        return uint16((uint256(uint8(raw[0])) << 8) | uint256(uint8(raw[1])));
    }
}
