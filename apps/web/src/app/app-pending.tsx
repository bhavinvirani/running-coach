/** Blank page while the first route loads: the body background already matches, no spinner. */
export function AppPending() {
  return <div aria-busy="true" className="min-h-dvh bg-surface-0" />;
}
