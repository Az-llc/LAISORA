export function observedTimestampSeed(
  arrivalSeed: number | undefined,
  foldedSeed: number | undefined
): number | undefined {
  if (arrivalSeed === undefined) return foldedSeed;
  if (foldedSeed === undefined) return arrivalSeed;
  return Math.max(arrivalSeed, foldedSeed);
}
