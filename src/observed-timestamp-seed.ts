// resume 直後の normalizer へ渡す観測時刻の種。
//
// arrival だけを使ってはいけない。初回 hydration では Session の fold がまだ無いので
// foldedSeed は undefined だが、失敗後の retry では Session が既に live event を fold して
// いる一方 arrivalTimestamp は journalLiveEvent でしか進まない。arrival だけを渡すと
// fold 済みより古い時刻が normalizer へ入り、到着したイベントが「過去」と判定されて落ちる。
export function observedTimestampSeed(
  arrivalSeed: number | undefined,
  foldedSeed: number | undefined
): number | undefined {
  if (arrivalSeed === undefined) return foldedSeed;
  if (foldedSeed === undefined) return arrivalSeed;
  return Math.max(arrivalSeed, foldedSeed);
}
