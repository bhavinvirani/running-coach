/**
 * Query keys are `[resource, "list" | "detail", ...ids]`. A mutation that answers with the whole resource
 * puts it in the cache with setQueryData under its detailKey; any other mutation invalidates by `[resource]`,
 * which matches every list and detail of that resource.
 */
export type Resource =
  | "me"
  | "activities"
  | "import"
  | "personal-bests"
  | "plan"
  | "calendar"
  | "sessions"
  | "insights"
  | "reviews"
  | "pause"
  | "hr-zones"
  | "shoes";

type Id = string | number;

export function resourceKey<R extends Resource>(resource: R) {
  return [resource] as const;
}

export function listKey<R extends Resource, Ids extends Id[]>(resource: R, ...ids: Ids) {
  return [resource, "list", ...ids] as const;
}

export function detailKey<R extends Resource, Ids extends Id[]>(resource: R, ...ids: Ids) {
  return [resource, "detail", ...ids] as const;
}

/**
 * Mutations that a screen reads from the mutation cache rather than from its own useMutation, because the
 * screen may unmount and remount while one runs, are keyed `[action]`; an action made of two requests (the
 * Garmin login's start and code) keys each `[action, step]`, which a filter on `[action]` matches together.
 */
export type Action = "sync" | "garmin-login" | "garmin-disconnect";

export function actionKey<A extends Action>(action: A) {
  return [action] as const;
}
