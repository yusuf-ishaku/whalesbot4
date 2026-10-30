// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Fixture staking contract: many positions per wallet, each can be unbonding.
/// Accounting only (does not custody tokens) so fixtures can set any state directly.
contract TestStaking {
    struct Position { uint256 amount; bool unbonding; uint64 unlockAt; }
    mapping(address => Position[]) private _positions;

    function stake(address who, uint256 amount) external { _positions[who].push(Position(amount, false, 0)); }
    function beginUnbond(address who, uint256 index, uint64 unlockAt) external {
        _positions[who][index].unbonding = true; _positions[who][index].unlockAt = unlockAt;
    }
    function clear(address who) external { delete _positions[who]; }
    function positionsOf(address who) external view returns (Position[] memory) { return _positions[who]; }
}
