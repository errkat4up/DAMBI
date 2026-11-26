// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Immutable, directly addressable policy bytes; no proxy or indexer.
/// @dev Publication authority is NOT a wallet's P-256 trust root. Consumers must
/// verify the original payload signature and compare its scope and sequence to
/// this record. This contract neither parses JSON nor authenticates P-256.
contract PolicyRegistry {
    uint256 public constant MAX_SEQUENCE = 9_007_199_254_740_991;
    // Technical storage/input ceiling, NOT an approved operating gas budget.
    uint256 public constant MAX_PAYLOAD_BYTES = 32_768;

    address public publisher;
    address public pendingPublisher;
    mapping(bytes32 => uint256) internal heads;

    struct Version {
        bytes32 digest; // SHA-256 of the exact payload bytes, not the envelope
        bytes payload;
        bytes signature; // P-256 P1363 r||s; verified by the consumer
        string keyId; // telemetry only
        bool revoked;
    }
    mapping(bytes32 => mapping(uint256 => Version)) private versions;

    // Missing and superseded are deliberately different from revoked.
    enum Status { Missing, Active, Superseded, Revoked }

    error Unauthorized();
    error InvalidAuthority();
    error InvalidVersion();
    error Conflict();
    error InvalidData();
    error NotActive();
    error MissingVersion();

    event PublisherProposed(address indexed current, address indexed proposed);
    event PublisherChanged(address indexed previous, address indexed current);
    event Published(bytes32 indexed scope, uint256 indexed sequence, bytes32 digest);
    event Revoked(bytes32 indexed scope, uint256 indexed sequence);

    constructor(address initialPublisher) {
        if (initialPublisher == address(0)) revert InvalidAuthority();
        publisher = initialPublisher;
    }

    modifier onlyPublisher() {
        if (msg.sender != publisher) revert Unauthorized();
        _;
    }

    /// Two-step transfer. A proposal grants no publication rights. Replacing or
    /// cancelling it immediately invalidates the old pending acceptance.
    function proposePublisher(address next) external onlyPublisher {
        if (next == address(0) || next == publisher) revert InvalidAuthority();
        pendingPublisher = next;
        emit PublisherProposed(publisher, next);
    }

    function cancelPublisherTransfer() external onlyPublisher {
        pendingPublisher = address(0);
        emit PublisherProposed(publisher, address(0));
    }

    function acceptPublisher() external {
        if (msg.sender != pendingPublisher || msg.sender == address(0)) revert Unauthorized();
        address previous = publisher;
        publisher = msg.sender;
        pendingPublisher = address(0);
        emit PublisherChanged(previous, msg.sender);
    }

    /// Scope encoding shared with the publisher. No packed-string ambiguity.
    function scopeId(string calldata env, string calldata profile) external view returns (bytes32) {
        return sha256(abi.encode(block.chainid, address(this), env, profile));
    }

    /// Monotonic high-water mark, including when its version has been revoked.
    function latest(bytes32 scope) external view returns (uint256) {
        return heads[scope];
    }

    /// sequence=0 resolves the head. One call supplies the head, status and all
    /// immutable bytes, including on a fresh consumer with no event history.
    function read(bytes32 scope, uint256 sequence) external view returns (
        uint256 head, Status status, bytes32 digest,
        bytes memory payload, bytes memory signature, string memory keyId
    ) {
        head = heads[scope];
        uint256 selected = sequence == 0 ? head : sequence;
        Version storage v = versions[scope][selected];
        if (v.payload.length == 0) status = Status.Missing;
        else if (v.revoked) status = Status.Revoked;
        else if (selected == head) status = Status.Active;
        else status = Status.Superseded;
        return (head, status, v.digest, v.payload, v.signature, v.keyId);
    }

    /// Compare-and-set publication. A rollback requires a NEW sequence and a
    /// newly signed payload. There is deliberately no activation/set-head API.
    function publish(
        bytes32 scope, uint256 expectedCurrent, uint256 sequence,
        bytes32 digest, bytes calldata payload, bytes calldata signature,
        string calldata keyId
    ) external onlyPublisher {
        if (sequence == 0 || sequence > MAX_SEQUENCE || expectedCurrent >= MAX_SEQUENCE
            || sequence != expectedCurrent + 1) revert InvalidVersion();
        if (scope == bytes32(0) || payload.length == 0 || payload.length > MAX_PAYLOAD_BYTES
            || signature.length != 64 || bytes(keyId).length > 256
            || sha256(payload) != digest) revert InvalidData();

        Version storage existing = versions[scope][sequence];
        if (existing.payload.length != 0) {
            // Safe retry of precisely the same active publication only. Neither
            // retrying a revoked record nor retrying history can reactivate it.
            if (existing.revoked || heads[scope] != sequence) revert NotActive();
            if (existing.digest != digest || keccak256(existing.payload) != keccak256(payload)
                || keccak256(existing.signature) != keccak256(signature)
                || keccak256(bytes(existing.keyId)) != keccak256(bytes(keyId))) revert Conflict();
            return;
        }
        if (heads[scope] != expectedCurrent) revert Conflict();
        versions[scope][sequence] = Version(digest, payload, signature, keyId, false);
        heads[scope] = sequence;
        emit Published(scope, sequence, digest);
    }

    /// Revocation is permanent and idempotent, including for historical versions.
    /// Revoking the head does not fall back to an older policy or reset sequence.
    function revoke(bytes32 scope, uint256 sequence) external onlyPublisher {
        Version storage v = versions[scope][sequence];
        if (sequence == 0 || v.payload.length == 0) revert MissingVersion();
        if (v.revoked) return;
        v.revoked = true;
        emit Revoked(scope, sequence);
    }
}
