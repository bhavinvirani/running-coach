import { Link, useParams } from "react-router";
import { DetailLayout } from "@/components/detail-header";
import { LoadError } from "@/components/load-error";
import { RetryAlert } from "@/components/retry-alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { ShoeActions } from "./parts/shoe-actions";
import { ShoeForm } from "./parts/shoe-form";
import { shoeCopy } from "./shoe-copy";
import { NEW_SHOE, inputOf } from "./shoe-draft";
import { useEditShoeScreen, useNewShoeScreen } from "./use-shoe";

const BACK_TO = "/settings/shoes";

/**
 * One pair: /settings/shoes/new adds one, /settings/shoes/:id edits one, read from the list, with Make
 * active, Retire shoes and Delete shoes below the form. Keyed by id, so moving to another pair starts over.
 * No empty state: a new pair starts from the default goal, and an id the list does not hold is not found.
 */
export function ShoeScreen() {
  const { id } = useParams();
  return id === undefined ? <NewShoe /> : <EditShoe key={id} id={id} />;
}

function NewShoe() {
  const screen = useNewShoeScreen();
  const { data, status, error, refetch, units } = screen;
  const title = shoeCopy.newTitle;

  if (status === "pending" || units === undefined) return <ShoeSkeleton title={title} />;
  if (status === "error") {
    return (
      <DetailLayout title={title} backTo={BACK_TO}>
        <LoadError error={error} onRetry={() => void refetch()} />
      </DetailLayout>
    );
  }

  return (
    <DetailLayout title={title} backTo={BACK_TO}>
      {screen.refetchError ? (
        <RetryAlert error={screen.refetchError} onRetry={() => void refetch()} />
      ) : null}
      <ShoeForm
        stored={NEW_SHOE}
        units={units}
        // The first pair, or one after the active pair was retired, goes on new runs unless unchecked.
        startActive={!data.shoes.some((shoe) => shoe.active)}
        submit={{ idle: shoeCopy.add, pending: shoeCopy.adding }}
        saving={screen.saving}
        saveError={screen.saveError}
        onSave={(input, active) => screen.save({ ...input, active: active ?? false })}
      />
    </DetailLayout>
  );
}

function EditShoe({ id }: { id: string }) {
  const screen = useEditShoeScreen(id);
  const { data, status, error, refetch, units } = screen;
  const title = shoeCopy.editTitle;

  if (status === "pending" || units === undefined) return <ShoeSkeleton title={title} />;
  if (status === "error") {
    return (
      <DetailLayout title={title} backTo={BACK_TO}>
        <LoadError error={error} onRetry={() => void refetch()} />
      </DetailLayout>
    );
  }

  const shoe = data.shoes.find((candidate) => candidate.id === id);
  if (shoe === undefined) {
    return (
      <DetailLayout title={title} backTo={BACK_TO}>
        {screen.actions.removed ? (
          // Deleted here: the list no longer holds it while the screen goes back.
          <p role="status" className="text-body text-ink-2">
            {shoeCopy.removed}
          </p>
        ) : (
          <div className="flex flex-col items-start gap-4">
            <p className="text-body text-ink-2">{shoeCopy.notFound}</p>
            <Button asChild variant="secondary">
              <Link to={BACK_TO}>{shoeCopy.allShoes}</Link>
            </Button>
          </div>
        )}
      </DetailLayout>
    );
  }

  return (
    <DetailLayout title={title} backTo={BACK_TO}>
      {screen.refetchError ? (
        <RetryAlert error={screen.refetchError} onRetry={() => void refetch()} />
      ) : null}
      <ShoeForm
        stored={inputOf(shoe)}
        units={units}
        submit={{ idle: shoeCopy.save, pending: shoeCopy.saving }}
        saving={screen.saving}
        saveError={screen.saveError}
        onSave={(input, _active, onSaved) => screen.save(input, onSaved)}
      />
      <ShoeActions shoe={shoe} actions={screen.actions} />
    </DetailLayout>
  );
}

/** The Pair card's four fields, the Distance card's two and the submit, at their loaded heights. */
function ShoeSkeleton({ title }: { title: string }) {
  return (
    <DetailLayout title={title} backTo={BACK_TO} busy>
      <div role="status" aria-label={shoeCopy.loading} className="flex flex-col gap-4">
        <SkeletonCard fields={[false, false, true, true]} />
        <SkeletonCard fields={[true, true]} narrow />
        <div className="h-11 w-32 rounded-sm bg-surface-2" />
      </div>
    </DetailLayout>
  );
}

/** A CardSection of TextFields; each true field has a helper line under it. */
function SkeletonCard({ fields, narrow = false }: { fields: boolean[]; narrow?: boolean }) {
  return (
    <div className="flex flex-col gap-2">
      <div className="flex h-5.5 items-center">
        <div className="h-4 w-16 rounded-sm bg-surface-2" />
      </div>
      <div className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
        {fields.map((helper, field) => (
          <div key={field} className="flex flex-col gap-2 py-4">
            <div className="flex h-5.5 items-center">
              <div className="h-4 w-20 rounded-sm bg-surface-2" />
            </div>
            <div
              className={cn("h-11 rounded-sm border border-line bg-surface-0", narrow && "w-28")}
            />
            {helper ? (
              <div className="flex h-4 items-center">
                <div className="h-3 w-48 rounded-sm bg-surface-2" />
              </div>
            ) : null}
          </div>
        ))}
      </div>
    </div>
  );
}
