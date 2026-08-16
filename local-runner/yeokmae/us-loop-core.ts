// 역매공파 US 지속실행 루프 코어 (P0-34L) — 시장무관 loop-core 로 이관(P0-35). US 이름 유지(back-compat) 재수출.
export { resolveLoopIntervals as resolveUSLoopIntervals, isDue, evaluateManagedExit, runManagedSellCycle as runUSSellCycle } from './loop-core';
export type { Quote as USQuote, ManagedSellCycleDeps as USSellCycleDeps, ManagedSellCycleResult as USSellCycleResult, ManagedExitSkip as USExitSkip, LoopIntervals as USLoopIntervals } from './loop-core';
