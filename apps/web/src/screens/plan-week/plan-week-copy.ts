/** Every sentence and label on a plan week, so the wording is read and changed in one place. */
export const planWeekCopy = {
  /** The title while the plan loads or when there is no such week. */
  title: "Week",
  loading: "Loading the week",
  days: "Days",
  /** The address names a week the plan does not have: an old link, or a plan made again shorter. */
  noSuchWeek: (number: string) => `Your plan has no week ${number}.`,
  noPlan: "You have no plan yet.",
  openPlan: "Open plan",
} as const;
