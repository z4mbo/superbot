/** Jaro similarity of two strings, by characters: 1 for equal strings, 0 for nothing in common. */
export function jaro(left: string, right: string): number {
  const a = Array.from(left);
  const b = Array.from(right);
  if (a.length === 0 && b.length === 0) return 1;
  if (a.length === 0 || b.length === 0) return 0;
  const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = a.map(() => false);
  const bMatched = b.map(() => false);
  let matches = 0;
  for (const [i, character] of a.entries()) {
    const end = Math.min(b.length, i + range + 1);
    for (let j = Math.max(0, i - range); j < end; j++) {
      if (!bMatched[j] && b[j] === character) {
        aMatched[i] = true;
        bMatched[j] = true;
        matches++;
        break;
      }
    }
  }
  if (matches === 0) return 0;
  const bInOrder = b.filter((_, j) => bMatched[j]);
  const transpositions =
    a.filter((_, i) => aMatched[i]).filter((character, k) => character !== bInOrder[k]).length / 2;
  return (
    (matches / a.length + matches / b.length + (matches - Math.floor(transpositions)) / matches) / 3
  );
}

/** The candidates close enough to suggest for `value`, the closest last. */
export function similar(value: string, candidates: readonly string[]): string[] {
  return candidates
    .map((candidate) => ({ candidate, confidence: jaro(value, candidate) }))
    .filter(({ confidence }) => confidence > 0.7)
    .sort((x, y) => x.confidence - y.confidence)
    .map(({ candidate }) => candidate);
}
