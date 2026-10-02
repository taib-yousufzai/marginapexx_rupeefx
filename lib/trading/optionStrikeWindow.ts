// ─── Centered Strike Window Selector (Uses 100% Actual Available Contract Strikes) ───
export function getCenteredStrikeWindow<T extends { strike: number }>(
  strikes: T[],
  spotPrice: number
): { centeredStrikes: T[]; atmIndex: number } {
  if (!strikes || strikes.length === 0) {
    return { centeredStrikes: [], atmIndex: -1 };
  }

  // 1. Deduplicate by strike and sort ascending
  const strikeMap = new Map<number, T>();
  strikes.forEach(s => strikeMap.set(s.strike, s));
  const sortedStrikes = Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);

  if (sortedStrikes.length === 0) {
    return { centeredStrikes: [], atmIndex: -1 };
  }

  // 2. Determine ATM strike index from actual available strikes
  let atmIdx = Math.floor(sortedStrikes.length / 2);

  if (spotPrice > 0) {
    let minDiff = Math.abs(sortedStrikes[0].strike - spotPrice);
    atmIdx = 0;
    for (let i = 1; i < sortedStrikes.length; i++) {
      const diff = Math.abs(sortedStrikes[i].strike - spotPrice);
      if (diff < minDiff) {
        minDiff = diff;
        atmIdx = i;
      }
    }
  }

  // 3. Slice 11 actual strikes around ATM
  const targetCount = 11;
  if (sortedStrikes.length <= targetCount) {
    return { centeredStrikes: sortedStrikes, atmIndex: atmIdx };
  }

  // Clamp window so it always contains exactly 11 items
  let startIdx = atmIdx - 5;
  if (startIdx < 0) {
    startIdx = 0;
  } else if (startIdx + targetCount > sortedStrikes.length) {
    startIdx = sortedStrikes.length - targetCount;
  }

  const centeredStrikes = sortedStrikes.slice(startIdx, startIdx + targetCount);
  const centeredAtmIndex = atmIdx - startIdx;

  return { centeredStrikes, atmIndex: centeredAtmIndex };
}
