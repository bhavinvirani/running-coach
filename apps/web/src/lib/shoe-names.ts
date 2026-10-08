import type { Shoe } from "@running-coach/shared";

type Named = Pick<Shoe, "brand" | "model" | "nickname">;

/** "Northpace Glide 4". */
export function brandAndModel({ brand, model }: Named): string {
  return `${brand} ${model}`;
}

/** What the runner calls a pair everywhere: its nickname, else brand and model. */
export function shoeName(shoe: Named): string {
  return shoe.nickname ?? brandAndModel(shoe);
}

/**
 * What a pair's name leaves out, for the line under it: brand and model when a nickname stands in for
 * them, then the colour. Empty for a pair with neither nickname nor colour.
 */
export function shoeDetails(shoe: Named & Pick<Shoe, "colour">): string[] {
  return [shoe.nickname === null ? null : brandAndModel(shoe), shoe.colour].filter(
    (part) => part !== null,
  );
}

/** Where a pair stands: the one on new runs, in use, or retired. */
export function shoeStatus(
  shoe: Pick<Shoe, "active" | "retiredAt">,
): "Active" | "In use" | "Retired" {
  if (shoe.retiredAt !== null) return "Retired";
  return shoe.active ? "Active" : "In use";
}
