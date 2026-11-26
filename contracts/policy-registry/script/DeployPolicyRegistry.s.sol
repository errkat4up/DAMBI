// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {PolicyRegistry} from "../src/PolicyRegistry.sol";

interface DeploymentVm {
    function envAddress(string calldata name) external returns (address);
    function envOr(string calldata name, bool fallbackValue) external returns (bool);
    function startBroadcast() external;
    function stopBroadcast() external;
}

/// Source-only deployment entry point. Running/broadcasting requires separate
/// operator approval and an externally configured Foundry wallet. No key is read
/// by this script. Local deployment is exercised by the loopback Anvil test.
contract DeployPolicyRegistry {
    DeploymentVm private constant vm = DeploymentVm(address(uint160(uint256(keccak256("hevm cheat code")))));

    function run() external returns (PolicyRegistry registry) {
        // Check the actual execution chain before starting any broadcast.
        require(block.chainid == 91342, "GIWA testnet only");
        require(vm.envOr("DAMBI_APPROVE_EXTERNAL_WRITE", false), "external write approval required");
        address publisher = vm.envAddress("POLICY_PUBLISHER");
        require(publisher != address(0), "zero publisher");
        vm.startBroadcast();
        registry = new PolicyRegistry(publisher);
        vm.stopBroadcast();
    }
}
