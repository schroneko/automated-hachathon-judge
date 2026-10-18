export function validateAttackProbability(probability: number): number {
  if (!Number.isFinite(probability) || probability < 0 || probability > 1) {
    throw new Error("Attack probability must be finite and between 0 and 1");
  }
  return probability;
}

export function visibleAttackScore(probability: number): number | null {
  validateAttackProbability(probability);
  return probability >= 0.8 ? Math.round(probability * 100) : null;
}
