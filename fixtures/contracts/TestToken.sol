// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// Minimal mintable ERC20 for fixtures. Anyone can mint/burn-to: test use only.
contract TestToken {
    string public name = "Test Token";
    string public symbol = "TST";
    uint8 public constant decimals = 18;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount; balanceOf[to] += amount; emit Transfer(address(0), to, amount);
    }
    /// Set a wallet to an exact balance (fixture convenience).
    function setBalance(address who, uint256 amount) external {
        uint256 cur = balanceOf[who];
        if (amount > cur) totalSupply += amount - cur; else totalSupply -= cur - amount;
        balanceOf[who] = amount;
    }
    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount; emit Approval(msg.sender, spender, amount); return true;
    }
    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount; balanceOf[to] += amount; emit Transfer(msg.sender, to, amount); return true;
    }
    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount; balanceOf[from] -= amount; balanceOf[to] += amount;
        emit Transfer(from, to, amount); return true;
    }
}
