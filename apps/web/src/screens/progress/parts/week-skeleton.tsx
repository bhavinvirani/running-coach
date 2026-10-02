/** A week section at its loaded heights (range, figure, run rows), so nothing jumps when the week arrives. */
export function WeekSkeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div className="flex flex-col gap-2 border-t border-line pt-4">
      <div className="flex h-5.5 items-center">
        <div className="h-4 w-24 rounded-sm bg-surface-2" />
      </div>
      <div className="flex h-8.5 items-end gap-3">
        <div className="h-7 w-24 rounded-sm bg-surface-2" />
        <div className="mb-1 h-3 w-14 rounded-sm bg-surface-2" />
      </div>
      <div className="flex flex-col divide-y divide-line">
        {Array.from({ length: rows }, (_, row) => (
          <div key={row} className="flex min-h-12 items-center justify-between gap-2 py-3">
            <div className="h-4 w-20 rounded-sm bg-surface-2" />
            <div className="h-4 w-48 rounded-sm bg-surface-2" />
          </div>
        ))}
      </div>
    </div>
  );
}
