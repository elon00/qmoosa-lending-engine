import { AssetReserve, UserPosition, AccountHealth } from "./types.js";

export class LendingEngine {
  public static readonly BPS_DIVISOR = 10_000n;
  public static readonly HF_PRECISION = 10_000;
  public static readonly LIQUIDATION_THRESHOLD_HF = 10_000; // HF < 1.0

  private reserves: Map<string, AssetReserve> = new Map();
  private positions: Map<string, UserPosition> = new Map();

  public registerReserve(reserve: AssetReserve): void {
    if (this.reserves.has(reserve.symbol)) {
      throw new Error(`Reserve ${reserve.symbol} already registered`);
    }
    this.reserves.set(reserve.symbol, { ...reserve });
  }

  public getReserve(symbol: string): AssetReserve {
    const res = this.reserves.get(symbol);
    if (!res) {
      throw new Error(`Reserve ${symbol} not found`);
    }
    return res;
  }

  private getOrCreatePosition(user: string): UserPosition {
    let pos = this.positions.get(user);
    if (!pos) {
      pos = {
        user,
        deposits: new Map(),
        borrows: new Map()
      };
      this.positions.set(user, pos);
    }
    return pos;
  }

  public deposit(user: string, asset: string, amountUsd: bigint): void {
    if (amountUsd <= 0n) {
      throw new Error("Deposit amount must be strictly positive");
    }
    const reserve = this.getReserve(asset);
    const pos = this.getOrCreatePosition(user);

    const current = pos.deposits.get(asset) ?? 0n;
    pos.deposits.set(asset, current + amountUsd);
    reserve.totalDepositedUsd += amountUsd;
  }

  public withdraw(user: string, asset: string, amountUsd: bigint): void {
    if (amountUsd <= 0n) {
      throw new Error("Withdraw amount must be strictly positive");
    }
    const reserve = this.getReserve(asset);
    const pos = this.getOrCreatePosition(user);
    const current = pos.deposits.get(asset) ?? 0n;

    if (current < amountUsd) {
      throw new Error("Insufficient deposited collateral");
    }

    // Speculatively deduct
    pos.deposits.set(asset, current - amountUsd);
    reserve.totalDepositedUsd -= amountUsd;

    // Check health factor after withdrawal
    const health = this.getAccountHealth(user);
    if (health.isLiquidatable) {
      // Rollback
      pos.deposits.set(asset, current);
      reserve.totalDepositedUsd += amountUsd;
      throw new Error(`Withdrawal denied: would cause under-collateralization (HF: ${health.healthFactor / 10000})`);
    }
  }

  public borrow(user: string, asset: string, amountUsd: bigint): void {
    if (amountUsd <= 0n) {
      throw new Error("Borrow amount must be strictly positive");
    }
    const reserve = this.getReserve(asset);
    const pos = this.getOrCreatePosition(user);

    // Check pool liquidity
    const availablePoolLiquidity = reserve.totalDepositedUsd - reserve.totalBorrowedUsd;
    if (amountUsd > availablePoolLiquidity) {
      throw new Error(`Insufficient pool liquidity for ${asset}`);
    }

    const healthBefore = this.getAccountHealth(user);
    if (healthBefore.totalDebtUsd + amountUsd > healthBefore.maxBorrowUsd) {
      throw new Error(`Borrow exceeds maximum collateral borrowing capacity (LTV violation)`);
    }

    const currentBorrow = pos.borrows.get(asset) ?? 0n;
    pos.borrows.set(asset, currentBorrow + amountUsd);
    reserve.totalBorrowedUsd += amountUsd;

    const healthAfter = this.getAccountHealth(user);
    if (healthAfter.isLiquidatable) {
      // Rollback
      pos.borrows.set(asset, currentBorrow);
      reserve.totalBorrowedUsd -= amountUsd;
      throw new Error(`Borrow denied: health factor violation`);
    }
  }

  public repay(user: string, asset: string, amountUsd: bigint): bigint {
    if (amountUsd <= 0n) {
      throw new Error("Repay amount must be strictly positive");
    }
    const reserve = this.getReserve(asset);
    const pos = this.getOrCreatePosition(user);
    const currentBorrow = pos.borrows.get(asset) ?? 0n;

    if (currentBorrow === 0n) {
      throw new Error(`No active debt in ${asset}`);
    }

    const actualRepay = amountUsd > currentBorrow ? currentBorrow : amountUsd;
    pos.borrows.set(asset, currentBorrow - actualRepay);
    reserve.totalBorrowedUsd -= actualRepay;

    return actualRepay;
  }

  public liquidate(
    liquidator: string,
    borrower: string,
    debtAsset: string,
    debtToCoverUsd: bigint,
    collateralAsset: string
  ): { seizedCollateralUsd: bigint; repaidDebtUsd: bigint } {
    if (liquidator === borrower) {
      throw new Error("Self-liquidation strictly forbidden");
    }
    const health = this.getAccountHealth(borrower);
    if (!health.isLiquidatable) {
      throw new Error(`Account is not eligible for liquidation (HF: ${health.healthFactor / 10000} >= 1.0)`);
    }

    const debtReserve = this.getReserve(debtAsset);
    const collateralReserve = this.getReserve(collateralAsset);
    const borrowerPos = this.getOrCreatePosition(borrower);
    const liquidatorPos = this.getOrCreatePosition(liquidator);

    const borrowerDebt = borrowerPos.borrows.get(debtAsset) ?? 0n;
    if (borrowerDebt === 0n) {
      throw new Error(`Borrower has no debt in ${debtAsset}`);
    }

    const actualDebtCovered = debtToCoverUsd > borrowerDebt ? borrowerDebt : debtToCoverUsd;
    // Calculate collateral to seize with bonus (e.g. 5% = 1.05x)
    const bonusMultiplier = LendingEngine.BPS_DIVISOR + BigInt(collateralReserve.liquidationBonusBps);
    const collateralToSeize = (actualDebtCovered * bonusMultiplier) / LendingEngine.BPS_DIVISOR;

    const borrowerCollateral = borrowerPos.deposits.get(collateralAsset) ?? 0n;
    if (collateralToSeize > borrowerCollateral) {
      throw new Error("Insufficient borrower collateral to reward liquidator");
    }

    // Settle liquidation
    borrowerPos.borrows.set(debtAsset, borrowerDebt - actualDebtCovered);
    debtReserve.totalBorrowedUsd -= actualDebtCovered;

    borrowerPos.deposits.set(collateralAsset, borrowerCollateral - collateralToSeize);
    const liquidatorCollateral = liquidatorPos.deposits.get(collateralAsset) ?? 0n;
    liquidatorPos.deposits.set(collateralAsset, liquidatorCollateral + collateralToSeize);

    return {
      seizedCollateralUsd: collateralToSeize,
      repaidDebtUsd: actualDebtCovered
    };
  }

  public getAccountHealth(user: string): AccountHealth {
    const pos = this.positions.get(user);
    if (!pos) {
      return {
        user,
        totalCollateralUsd: 0n,
        totalDebtUsd: 0n,
        maxBorrowUsd: 0n,
        healthFactor: 1_000_000,
        isLiquidatable: false
      };
    }

    let totalCollateralUsd = 0n;
    let weightedCollateralUsd = 0n;
    let maxBorrowUsd = 0n;

    for (const [asset, amount] of pos.deposits.entries()) {
      const res = this.getReserve(asset);
      totalCollateralUsd += amount;
      weightedCollateralUsd += (amount * BigInt(res.liquidationThresholdBps)) / LendingEngine.BPS_DIVISOR;
      maxBorrowUsd += (amount * BigInt(res.ltvBps)) / LendingEngine.BPS_DIVISOR;
    }

    let totalDebtUsd = 0n;
    for (const [, amount] of pos.borrows.entries()) {
      totalDebtUsd += amount;
    }

    let healthFactor = 1_000_000;
    if (totalDebtUsd > 0n) {
      const hf = (weightedCollateralUsd * BigInt(LendingEngine.HF_PRECISION)) / totalDebtUsd;
      healthFactor = Number(hf);
    }

    const isLiquidatable = totalDebtUsd > 0n && healthFactor < LendingEngine.LIQUIDATION_THRESHOLD_HF;

    return {
      user,
      totalCollateralUsd,
      totalDebtUsd,
      maxBorrowUsd,
      healthFactor,
      isLiquidatable
    };
  }
}
