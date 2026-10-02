/**
 * Query keys are `[resource, "list" | "detail", ...ids]`. A mutation that answers with the whole resource
 * puts it in the cache with setQueryData under its detailKey; any other mutation invalidates by `[resource]`,
 * which matches every list and detail of that resource.
 */
export type Resource = "me";

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
