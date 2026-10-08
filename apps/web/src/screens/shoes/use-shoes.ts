import { useSettings } from "@/api/me";
import { screenState } from "@/api/screen-state";
import { useShoes } from "@/api/shoes";

/** Everything the Shoes screen reads: every pair with its totals, and the unit to show them in. */
export function useShoesScreen() {
  const shoes = useShoes();
  const settings = useSettings();

  return {
    ...screenState(shoes),
    units: settings.data?.units,
  };
}
