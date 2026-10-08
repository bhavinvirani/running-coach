import type { Shoe } from "@running-coach/shared";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { errorMessage } from "@/lib/errors";
import { shoeStatus } from "@/lib/shoe-names";
import { shoeCopy, statusLines } from "../shoe-copy";
import type { ShoeActionsState } from "../use-shoe";

type ShoeActionsProps = {
  shoe: Shoe;
  actions: ShoeActionsState;
};

/**
 * What the runner can do with a stored pair, under its form: where it stands, then Make active (not for
 * the active pair; a retired pair comes back in use), Retire shoes (not for a retired pair) and Delete
 * shoes, confirmed in place like SessionActions. Make active and Retire shoes take away the button just
 * pressed, so focus goes to the line saying where the pair now stands; the confirm step takes focus to its
 * question, and Keep shoes back to Delete shoes.
 */
export function ShoeActions({ shoe, actions }: ShoeActionsProps) {
  const [confirming, setConfirming] = useState(false);
  const questionId = useId();
  const statusLine = useRef<HTMLParagraphElement>(null);
  const question = useRef<HTMLParagraphElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null);
  // Set with the swap, so only a render the runner caused moves focus, never a refetch.
  const focusAfterSwap = useRef<"question" | "delete" | null>(null);
  const status = shoeStatus(shoe);
  const busy = actions.activating || actions.retiring || actions.removing;

  useEffect(() => {
    const target = focusAfterSwap.current;
    focusAfterSwap.current = null;
    if (target === "question") question.current?.focus();
    if (target === "delete") deleteButton.current?.focus();
  });

  function confirm(open: boolean) {
    focusAfterSwap.current = open ? "question" : "delete";
    actions.clearErrors();
    setConfirming(open);
  }

  const failed = actions.error ? (
    <p role="alert" className="text-body text-ink">
      {errorMessage(actions.error)}
    </p>
  ) : null;

  return (
    <div className="flex flex-col gap-3">
      <p ref={statusLine} tabIndex={-1} className="text-body text-ink-2">
        {statusLines[status]}
      </p>
      {confirming ? (
        <div
          role="group"
          aria-labelledby={questionId}
          className="flex flex-col gap-3 rounded-md bg-surface-1 p-4"
        >
          <p id={questionId} ref={question} tabIndex={-1} className="text-body text-ink">
            {shoeCopy.removeQuestion}
          </p>
          {failed}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={actions.removing}
              aria-busy={actions.removing}
              onClick={actions.remove}
            >
              {actions.removing ? shoeCopy.removing : shoeCopy.remove}
            </Button>
            <Button variant="ghost" disabled={actions.removing} onClick={() => confirm(false)}>
              {shoeCopy.keep}
            </Button>
          </div>
        </div>
      ) : (
        <>
          <div className="flex flex-wrap gap-2">
            {shoe.active ? null : (
              <Button
                variant="secondary"
                disabled={busy}
                aria-busy={actions.activating}
                onClick={() => actions.activate(() => statusLine.current?.focus())}
              >
                {actions.activating ? shoeCopy.makingActive : shoeCopy.makeActive}
              </Button>
            )}
            {shoe.retiredAt === null ? (
              <Button
                variant="secondary"
                disabled={busy}
                aria-busy={actions.retiring}
                onClick={() => actions.retire(() => statusLine.current?.focus())}
              >
                {actions.retiring ? shoeCopy.retiring : shoeCopy.retire}
              </Button>
            ) : null}
            <Button
              ref={deleteButton}
              variant="secondary"
              disabled={busy}
              onClick={() => confirm(true)}
            >
              {shoeCopy.remove}
            </Button>
          </div>
          {failed}
        </>
      )}
    </div>
  );
}
