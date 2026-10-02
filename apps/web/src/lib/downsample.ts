/** Charts render at most this many points: enough for a 390 px wide chart, cheap on a phone. */
export const MAX_CHART_POINTS = 600;

/**
 * Deterministic reduction to at most `maxPoints` points, kept in their original order.
 * Keeps the first and the last point and, from each of the equal buckets in between, the lowest and
 * the highest value, so peaks (a sprint, an HR spike) survive and the global extremes are never lost.
 */
export function downsample<T>(
  points: readonly T[],
  value: (point: T) => number,
  maxPoints: number = MAX_CHART_POINTS,
): T[] {
  if (!Number.isInteger(maxPoints) || maxPoints < 4) {
    throw new RangeError("maxPoints must be an integer of at least 4");
  }
  if (points.length <= maxPoints) return [...points];

  const first = 0;
  const last = points.length - 1;
  const bucketCount = Math.floor((maxPoints - 2) / 2);
  const innerLength = points.length - 2;
  const kept: number[] = [first];

  for (let bucket = 0; bucket < bucketCount; bucket += 1) {
    const start = 1 + Math.floor((bucket * innerLength) / bucketCount);
    const end = 1 + Math.floor(((bucket + 1) * innerLength) / bucketCount);
    if (start >= end) continue;
    let minIndex = start;
    let maxIndex = start;
    for (let index = start + 1; index < end; index += 1) {
      const current = value(points[index] as T);
      if (current < value(points[minIndex] as T)) minIndex = index;
      if (current > value(points[maxIndex] as T)) maxIndex = index;
    }
    if (minIndex === maxIndex) kept.push(minIndex);
    else kept.push(Math.min(minIndex, maxIndex), Math.max(minIndex, maxIndex));
  }

  kept.push(last);
  return kept.map((index) => points[index] as T);
}
