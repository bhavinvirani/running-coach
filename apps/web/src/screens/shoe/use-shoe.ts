import type { CreateShoeRequest, ShoeInput } from "@running-coach/shared";
import { useLocation, useNavigate } from "react-router";
import { useSettings } from "@/api/me";
import { screenState } from "@/api/screen-state";
import {
  useActivateShoe,
  useCreateShoe,
  useDeleteShoe,
  useRetireShoe,
  useShoes,
  useUpdateShoe,
} from "@/api/shoes";

/**
 * Back where the screen was opened from: the Shoes list, or the run that asked for a pair, which then
 * offers the new one. Opened from a link or bookmark, there is nothing in the app to go back to, so the
 * list takes the screen's place.
 */
function useLeave() {
  const navigate = useNavigate();
  const location = useLocation();
  const canGoBack = location.key !== "default";
  return () => {
    if (canGoBack) void navigate(-1);
    else void navigate("/settings/shoes", { replace: true });
  };
}

/**
 * The screen for a new pair: every pair, so Use for new runs starts checked when none is active, the unit
 * the distances are typed in, and Add shoes, which leaves once the pair is stored.
 */
export function useNewShoeScreen() {
  const shoes = useShoes();
  const settings = useSettings();
  const create = useCreateShoe();
  const leave = useLeave();

  return {
    ...screenState(shoes),
    units: settings.data?.units,
    saving: create.isPending,
    saveError: create.error,
    save: (body: CreateShoeRequest) => create.mutate(body, { onSuccess: leave }),
  };
}

/**
 * The screen for one pair, read from the list: Save shoes, Make active, Retire shoes and Delete shoes.
 * Starting one clears the others' errors, so only the last thing tried says it failed. Delete leaves once
 * the pair is gone.
 */
export function useEditShoeScreen(id: string) {
  const shoes = useShoes();
  const settings = useSettings();
  const update = useUpdateShoe(id);
  const activate = useActivateShoe(id);
  const retire = useRetireShoe(id);
  const remove = useDeleteShoe(id);
  const leave = useLeave();

  const resetAll = () => {
    update.reset();
    activate.reset();
    retire.reset();
    remove.reset();
  };

  return {
    ...screenState(shoes),
    units: settings.data?.units,
    saving: update.isPending,
    saveError: update.error,
    /** `onSaved` runs once the pair is stored, so the form can say so. */
    save: (body: ShoeInput, onSaved: () => void) => {
      resetAll();
      update.mutate(body, { onSuccess: onSaved });
    },
    actions: {
      activating: activate.isPending,
      retiring: retire.isPending,
      removing: remove.isPending,
      /** Gone from the list because the runner deleted it, not because it never existed. */
      removed: remove.isSuccess,
      error: activate.error ?? retire.error ?? remove.error,
      /** `onDone` runs once the list says so, so the screen can move focus off the vanished button. */
      activate: (onDone: () => void) => {
        resetAll();
        activate.mutate(undefined, { onSuccess: onDone });
      },
      retire: (onDone: () => void) => {
        resetAll();
        retire.mutate(undefined, { onSuccess: onDone });
      },
      remove: () => {
        resetAll();
        remove.mutate(undefined, { onSuccess: leave });
      },
      /** The confirm step opened or closed: an error from before no longer applies. */
      clearErrors: () => {
        activate.reset();
        retire.reset();
        remove.reset();
      },
    },
  };
}

export type ShoeActionsState = ReturnType<typeof useEditShoeScreen>["actions"];
