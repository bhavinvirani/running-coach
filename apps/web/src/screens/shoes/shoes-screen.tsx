import { Link } from "react-router";
import { CardSection } from "@/components/card-section";
import { DetailLayout } from "@/components/detail-header";
import { LoadError } from "@/components/load-error";
import { RetryAlert } from "@/components/retry-alert";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/cn";
import { ShoeRow } from "./parts/shoe-row";
import { shoesCopy } from "./shoes-copy";
import { useShoesScreen } from "./use-shoes";

const NEW_SHOES = "/settings/shoes/new";

/**
 * The runner's pairs at /settings/shoes, from Settings: an In use card with the active pair first, then a
 * Retired card once a pair is retired, each pair opening its own screen, and Add shoes below. Empty until
 * the first pair is added.
 */
export function ShoesScreen() {
  const screen = useShoesScreen();
  const { data, status, error, refetch, units } = screen;

  if (status === "pending" || units === undefined) {
    return (
      <DetailLayout title={shoesCopy.title} backTo="/settings" busy>
        <ShoesSkeleton />
      </DetailLayout>
    );
  }

  if (status === "error") {
    return (
      <DetailLayout title={shoesCopy.title} backTo="/settings">
        <LoadError error={error} onRetry={() => void refetch()} />
      </DetailLayout>
    );
  }

  const refetchFailed = screen.refetchError ? (
    <RetryAlert error={screen.refetchError} onRetry={() => void refetch()} />
  ) : null;

  if (data.shoes.length === 0) {
    return (
      <DetailLayout title={shoesCopy.title} backTo="/settings">
        {refetchFailed}
        <div className="flex flex-col items-start gap-4">
          <p className="text-body text-ink-2">{shoesCopy.empty}</p>
          <AddShoes />
        </div>
      </DetailLayout>
    );
  }

  const inUse = data.shoes.filter((shoe) => shoe.retiredAt === null);
  const retired = data.shoes.filter((shoe) => shoe.retiredAt !== null);

  return (
    <DetailLayout title={shoesCopy.title} backTo="/settings">
      {refetchFailed}
      <CardSection title={shoesCopy.inUse}>
        {inUse.length > 0 ? (
          inUse.map((shoe) => <ShoeRow key={shoe.id} shoe={shoe} units={units} />)
        ) : (
          <p className="py-3 text-body text-ink-2">{shoesCopy.noneInUse}</p>
        )}
      </CardSection>
      {retired.length > 0 ? (
        <CardSection title={shoesCopy.retired}>
          {retired.map((shoe) => (
            <ShoeRow key={shoe.id} shoe={shoe} units={units} />
          ))}
        </CardSection>
      ) : null}
      <AddShoes />
    </DetailLayout>
  );
}

function AddShoes() {
  return (
    <Button asChild className="self-start">
      <Link to={NEW_SHOES}>{shoesCopy.add}</Link>
    </Button>
  );
}

/** The In use card with two pairs at their loaded heights, then Add shoes. */
function ShoesSkeleton() {
  return (
    <div role="status" aria-label={shoesCopy.loading} className="flex flex-col gap-4">
      <div className="flex flex-col gap-2">
        <div className="flex h-5.5 items-center">
          <div className="h-4 w-14 rounded-sm bg-surface-2" />
        </div>
        <div className="flex flex-col divide-y divide-line rounded-md bg-surface-1 px-4">
          {["w-28", "w-36"].map((width) => (
            <div key={width} className="flex flex-col gap-2 py-3">
              <div className="flex flex-col">
                <Line className={cn("h-4", width)} tall />
                <Line className="h-3 w-32" />
              </div>
              <div className="flex flex-col gap-1">
                <Line className="h-4 w-28" tall />
                <div className="h-3 rounded-sm bg-surface-2" />
              </div>
              <Line className="h-3 w-28" />
            </div>
          ))}
        </div>
      </div>
      <div className="h-11 w-28 rounded-sm bg-surface-2" />
    </div>
  );
}

/** A block on a text line's height: a body line (22 px) when tall, else a caption line (16 px). */
function Line({ className, tall = false }: { className: string; tall?: boolean }) {
  return (
    <div className={cn("flex items-center", tall ? "h-5.5" : "h-4")}>
      <div className={cn("rounded-sm bg-surface-2", className)} />
    </div>
  );
}
