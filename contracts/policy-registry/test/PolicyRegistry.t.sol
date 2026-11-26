// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PolicyRegistry} from "../src/PolicyRegistry.sol";

interface TestVm {
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
}

contract BoundaryRegistry is PolicyRegistry {
    constructor() PolicyRegistry(msg.sender) {}
    // Test-only state setup: avoids 2^53 transactions to reach the boundary.
    function seedHead(bytes32 scope, uint256 value) external { heads[scope] = value; }
}

contract PolicyRegistryTest {
    TestVm private constant vm = TestVm(address(uint160(uint256(keccak256("hevm cheat code")))));
    PolicyRegistry private registry;
    bytes32 private scope;
    bytes private body;
    bytes private signature;
    address private constant NEXT = address(0xBEEF);
    address private constant OTHER = address(0xCAFE);

    function setUp() public {
        registry = new PolicyRegistry(address(this));
        scope = registry.scopeId("staging", "default");
        body = bytes("original UTF-8 payload\n");
        signature = new bytes(64);
    }

    function publish(uint256 expected, uint256 sequence, bytes memory value) private {
        registry.publish(scope, expected, sequence, sha256(value), value, signature, "telemetry");
    }

    function check(uint256 sequence, uint256 head, PolicyRegistry.Status expected, bytes memory value) private view {
        (uint256 h, PolicyRegistry.Status s, bytes32 d, bytes memory p, bytes memory sig, string memory id) = registry.read(scope, sequence);
        require(h == head && s == expected, "head/status");
        require(d == sha256(value) && keccak256(p) == keccak256(value), "original bytes/digest");
        require(keccak256(sig) == keccak256(signature) && keccak256(bytes(id)) == keccak256("telemetry"), "signature/key id");
    }

    function testDirectReadReplacementRetryAndPermanentRevocation() public {
        (, PolicyRegistry.Status empty,,,,) = registry.read(scope, 0);
        require(empty == PolicyRegistry.Status.Missing, "initially missing");
        publish(0, 1, body);
        check(0, 1, PolicyRegistry.Status.Active, body);
        publish(0, 1, body); // identical retry, no new version
        require(registry.latest(scope) == 1, "retry must not advance");
        bytes memory changed = bytes("replacement");
        publish(1, 2, changed);
        check(1, 2, PolicyRegistry.Status.Superseded, body);
        check(0, 2, PolicyRegistry.Status.Active, changed);
        registry.revoke(scope, 1);
        registry.revoke(scope, 1);
        check(1, 2, PolicyRegistry.Status.Revoked, body);
        vm.expectRevert(PolicyRegistry.NotActive.selector);
        publish(0, 1, body);
        registry.revoke(scope, 2);
        check(0, 2, PolicyRegistry.Status.Revoked, changed);
        vm.expectRevert(PolicyRegistry.NotActive.selector);
        publish(1, 2, changed);
        publish(2, 3, body);
        check(0, 3, PolicyRegistry.Status.Active, body);
        check(2, 3, PolicyRegistry.Status.Revoked, changed);
    }

    function testCompetingPublishersCannotOverwriteSameSequence() public {
        publish(0, 1, body);
        vm.expectRevert(PolicyRegistry.Conflict.selector);
        publish(0, 1, bytes("competing payload"));
        bytes memory otherSignature = new bytes(64);
        otherSignature[0] = 0x01;
        vm.expectRevert(PolicyRegistry.Conflict.selector);
        registry.publish(scope, 0, 1, sha256(body), body, otherSignature, "telemetry");
        vm.expectRevert(PolicyRegistry.Conflict.selector);
        registry.publish(scope, 0, 1, sha256(body), body, signature, "different");
        vm.expectRevert(PolicyRegistry.InvalidVersion.selector);
        publish(0, 2, body);
        check(1, 1, PolicyRegistry.Status.Active, body);
    }

    function testAuthorityTransferRequiresAcceptanceAndCanBeCancelledOrReplaced() public {
        vm.prank(OTHER);
        vm.expectRevert(PolicyRegistry.Unauthorized.selector);
        registry.proposePublisher(NEXT);
        registry.proposePublisher(NEXT);
        vm.prank(NEXT);
        vm.expectRevert(PolicyRegistry.Unauthorized.selector);
        publish(0, 1, body);
        registry.cancelPublisherTransfer();
        vm.prank(NEXT);
        vm.expectRevert(PolicyRegistry.Unauthorized.selector);
        registry.acceptPublisher();
        registry.proposePublisher(NEXT);
        registry.proposePublisher(OTHER);
        vm.prank(NEXT);
        vm.expectRevert(PolicyRegistry.Unauthorized.selector);
        registry.acceptPublisher();
        vm.prank(OTHER);
        registry.acceptPublisher();
        require(registry.publisher() == OTHER && registry.pendingPublisher() == address(0), "two-step transfer");
        vm.expectRevert(PolicyRegistry.Unauthorized.selector);
        publish(0, 1, body);
        vm.expectRevert(PolicyRegistry.Unauthorized.selector);
        registry.revoke(scope, 1);
        vm.expectRevert(PolicyRegistry.Unauthorized.selector);
        registry.cancelPublisherTransfer();
        vm.prank(OTHER);
        registry.publish(scope, 0, 1, sha256(body), body, signature, "telemetry");
        vm.prank(OTHER);
        registry.revoke(scope, 1);
        check(1, 1, PolicyRegistry.Status.Revoked, body);
    }

    function testInvalidAuthorityDataAndVersionBoundaries() public {
        vm.expectRevert(PolicyRegistry.InvalidAuthority.selector);
        new PolicyRegistry(address(0));
        vm.expectRevert(PolicyRegistry.InvalidAuthority.selector);
        registry.proposePublisher(address(0));
        vm.expectRevert(PolicyRegistry.InvalidAuthority.selector);
        registry.proposePublisher(address(this));
        vm.expectRevert(PolicyRegistry.InvalidVersion.selector);
        publish(0, 0, body);
        vm.expectRevert(PolicyRegistry.InvalidVersion.selector);
        publish(0, 2, body);
        vm.expectRevert(PolicyRegistry.InvalidData.selector);
        registry.publish(scope, 0, 1, bytes32(0), body, signature, "telemetry");
        vm.expectRevert(PolicyRegistry.InvalidData.selector);
        registry.publish(scope, 0, 1, sha256(body), body, new bytes(63), "telemetry");
        vm.expectRevert(PolicyRegistry.InvalidData.selector);
        publish(0, 1, new bytes(32_769));
        vm.expectRevert(PolicyRegistry.MissingVersion.selector);
        registry.revoke(scope, 1);
        BoundaryRegistry boundary = new BoundaryRegistry();
        uint256 maximum = boundary.MAX_SEQUENCE();
        boundary.seedHead(scope, maximum - 1);
        boundary.publish(scope, maximum - 1, maximum, sha256(body), body, signature, "telemetry");
        require(boundary.latest(scope) == maximum, "maximum safe integer accepted");
        vm.expectRevert(PolicyRegistry.InvalidVersion.selector);
        boundary.publish(scope, maximum, maximum + 1, sha256(body), body, signature, "telemetry");
    }

    function testScopeSeparation() public {
        bytes32 production = registry.scopeId("production", "default");
        bytes32 otherProfile = registry.scopeId("staging", "other");
        PolicyRegistry second = new PolicyRegistry(address(this));
        require(scope != production && scope != otherProfile
            && scope != second.scopeId("staging", "default"), "scope collision");
        require(scope == sha256(abi.encode(block.chainid, address(registry), "staging", "default")), "scope encoding");
        publish(0, 1, body);
        require(registry.latest(production) == 0 && registry.latest(otherProfile) == 0, "isolated heads");
    }

    function testFuzzDigestAndBytePreservation(bytes memory value) public {
        if (value.length == 0 || value.length > 4096) return;
        publish(0, 1, value);
        check(1, 1, PolicyRegistry.Status.Active, value);
    }
}
