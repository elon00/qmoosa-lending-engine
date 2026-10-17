import { test } from "node:test";
import assert from "node:assert/strict";
import { LendingEngine } from "../dist/index.js";

function setupEngine() {
  const engine = new LendingEngine();
  engine.registerReserve({
    symbol: "ETH",
    decimals: 18,
    totalDepositedUsd: 0n,
    totalBorrowedUsd: 0n,
    ltvBps: 7500,               // 75% max borrow
    liquidationThresholdBps: 8000, // 80% liquidation threshold
    liquidationBonusBps: 500,   // 5% bonus
    baseRateBps: 200,
    optimalUtilizationBps: 8000,
    rateSlope1Bps: 400,
    rateSlope2Bps: 6000
  });
  engine.registerReserve({
    symbol: "USDC",
    decimals: 6,
    totalDepositedUsd: 0n,
    totalBorrowedUsd: 0n,
    ltvBps: 8000,
    liquidationThresholdBps: 8500,
    liquidationBonusBps: 500,
    baseRateBps: 200,
    optimalUtilizationBps: 8000,
    rateSlope1Bps: 400,
    rateSlope2Bps: 6000
  });
  return engine;
}

test("1. Deposit and collateral accounting", () => {
  const engine = setupEngine();
  engine.deposit("alice", "ETH", 10_000n);

  const health = engine.getAccountHealth("alice");
  assert.equal(health.totalCollateralUsd, 10_000n);
  assert.equal(health.totalDebtUsd, 0n);
  assert.equal(health.maxBorrowUsd, 7500n); // 75% LTV
  assert.equal(health.isLiquidatable, false);
});

test("2. Borrow within LTV limit succeeds", () => {
  const engine = setupEngine();
  // Provider supplies USDC liquidity
  engine.deposit("lender", "USDC", 50_000n);
  // Alice deposits $10,000 ETH collateral
  engine.deposit("alice", "ETH", 10_000n);

  // Alice borrows $5,000 USDC (limit is $7,500)
  engine.borrow("alice", "USDC", 5000n);

  const health = engine.getAccountHealth("alice");
  assert.equal(health.totalDebtUsd, 5000n);
  // Weighted collateral = 10,000 * 80% = 8,000. HF = 8000 / 5000 = 1.6 (16,000 bps)
  assert.equal(health.healthFactor, 16000);
  assert.equal(health.isLiquidatable, false);
});

test("3. Borrow exceeding LTV is strictly rejected", () => {
  const engine = setupEngine();
  engine.deposit("lender", "USDC", 50_000n);
  engine.deposit("alice", "ETH", 10_000n);

  // Alice tries to borrow $8,000 USDC (limit is $7,500)
  assert.throws(
    () => engine.borrow("alice", "USDC", 8000n),
    /Borrow exceeds maximum collateral borrowing capacity/
  );
});

test("4. Withdrawal causing under-collateralization is strictly rolled back", () => {
  const engine = setupEngine();
  engine.deposit("lender", "USDC", 50_000n);
  engine.deposit("alice", "ETH", 10_000n);
  engine.borrow("alice", "USDC", 5000n);

  // Withdrawing $5,000 of ETH would leave $5,000 collateral. Weighted = $4,000, debt = $5,000 -> HF = 0.8 < 1.0
  assert.throws(
    () => engine.withdraw("alice", "ETH", 5000n),
    /Withdrawal denied: would cause under-collateralization/
  );

  // Verify state wasn't corrupted
  const health = engine.getAccountHealth("alice");
  assert.equal(health.totalCollateralUsd, 10_000n);
});

test("5. Liquidation of healthy account is strictly rejected", () => {
  const engine = setupEngine();
  engine.deposit("lender", "USDC", 50_000n);
  engine.deposit("alice", "ETH", 10_000n);
  engine.borrow("alice", "USDC", 5000n);

  assert.throws(
    () => engine.liquidate("bob", "alice", "USDC", 2000n, "ETH"),
    /Account is not eligible for liquidation/
  );
});

test("6. Liquidation of unhealthy account rewards liquidator with bonus", () => {
  const engine = setupEngine();
  engine.deposit("lender", "USDC", 50_000n);
  engine.deposit("alice", "ETH", 10_000n);
  engine.borrow("alice", "USDC", 7000n); // HF = 8000/7000 = 1.14

  // Simulate market drop: Alice's collateral is now worth only $8,000
  // Alice withdraws $1,500 in an approved restructuring or partial collateral slash
  // Let's directly test liquidation when position drops:
  // To trigger liquidation, borrow an asset whose parameter or price shifts:
  engine.registerReserve({
    symbol: "RISK",
    decimals: 18,
    totalDepositedUsd: 10_000n,
    totalBorrowedUsd: 0n,
    ltvBps: 8000,
    liquidationThresholdBps: 5000, // drops to 50% threshold
    liquidationBonusBps: 500,
    baseRateBps: 200,
    optimalUtilizationBps: 8000,
    rateSlope1Bps: 400,
    rateSlope2Bps: 6000
  });

  const engine2 = new LendingEngine();
  engine2.registerReserve({
    symbol: "COL",
    decimals: 18,
    totalDepositedUsd: 0n,
    totalBorrowedUsd: 0n,
    ltvBps: 8000,
    liquidationThresholdBps: 8000,
    liquidationBonusBps: 500, // 5% bonus
    baseRateBps: 200,
    optimalUtilizationBps: 8000,
    rateSlope1Bps: 400,
    rateSlope2Bps: 6000
  });
  engine2.registerReserve({
    symbol: "DEBT",
    decimals: 6,
    totalDepositedUsd: 100_000n,
    totalBorrowedUsd: 0n,
    ltvBps: 8000,
    liquidationThresholdBps: 8000,
    liquidationBonusBps: 500,
    baseRateBps: 200,
    optimalUtilizationBps: 8000,
    rateSlope1Bps: 400,
    rateSlope2Bps: 6000
  });

  // Borrower deposits $10,000 COL and borrows $7,500 DEBT
  engine2.deposit("borrower", "COL", 10_000n);
  engine2.borrow("borrower", "DEBT", 7500n);

  // Suppose collateral drops: 25% is slashed / drops value
  // Let's adjust borrower deposits to $8,000
  // Weighted collateral = 8000 * 0.8 = 6400, debt = 7500 -> HF = 6400/7500 = 0.8533 (liquidatable!)
  // In our engine, we can simulate by withdrawing to an under-collateralized state via internal map or setting
  const pos = engine2["positions"].get("borrower");
  pos.deposits.set("COL", 8000n);

  const health = engine2.getAccountHealth("borrower");
  assert.equal(health.isLiquidatable, true);

  // Liquidator covers $3,000 of debt
  const res = engine2.liquidate("liquidator", "borrower", "DEBT", 3000n, "COL");
  assert.equal(res.repaidDebtUsd, 3000n);
  // 3000 * 1.05 = 3150
  assert.equal(res.seizedCollateralUsd, 3150n);

  // Liquidator received $3,150 COL
  const liqHealth = engine2.getAccountHealth("liquidator");
  assert.equal(liqHealth.totalCollateralUsd, 3150n);
});
