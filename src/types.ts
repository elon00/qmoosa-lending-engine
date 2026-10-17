export interface AssetReserve {
  symbol: string;
  decimals: number;
  totalDepositedUsd: bigint;
  totalBorrowedUsd: bigint;
  ltvBps: number;
  liquidationThresholdBps: number;
  liquidationBonusBps: number;
  baseRateBps: number;
  optimalUtilizationBps: number;
  rateSlope1Bps: number;
  rateSlope2Bps: number;
}

export interface UserPosition {
  user: string;
  deposits: Map<string, bigint>; // asset -> amountUsd
  borrows: Map<string, bigint>;  // asset -> amountUsd
}

export interface AccountHealth {
  user: string;
  totalCollateralUsd: bigint;
  totalDebtUsd: bigint;
  maxBorrowUsd: bigint;
  healthFactor: number;
  isLiquidatable: boolean;
}
