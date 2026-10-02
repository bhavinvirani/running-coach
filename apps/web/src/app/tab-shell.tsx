import { ChartNoAxesColumn, House, Settings2, type LucideIcon } from "lucide-react";
import { NavLink, Outlet } from "react-router";
import { useForgetSyncOutcomeOnReconnect } from "@/api/sync";
import { useSyncOnOpen } from "@/api/sync-on-open";
import { cn } from "@/lib/cn";

type Tab = { to: string; label: string; icon: LucideIcon };

// Only the tabs that exist. Plan joins between Today and Progress when its slice lands.
const tabs: readonly Tab[] = [
  { to: "/", label: "Today", icon: House },
  { to: "/progress", label: "Progress", icon: ChartNoAxesColumn },
  { to: "/settings", label: "Settings", icon: Settings2 },
];

/**
 * The authenticated layout: mounted once per app load and kept across tabs, so it owns the sync on open and
 * forgets an earlier sync's login error after a reconnect, also one seen while Today was not on screen.
 */
export function TabShell() {
  useSyncOnOpen();
  useForgetSyncOutcomeOnReconnect();

  return (
    <div className="flex min-h-dvh flex-col bg-surface-0 pt-safe">
      <main className="mx-auto w-full max-w-lg flex-1">
        <Outlet />
      </main>
      <nav aria-label="Tabs" className="sticky bottom-0 border-t border-line bg-surface-0 pb-safe">
        <ul className="mx-auto flex max-w-lg">
          {tabs.map(({ to, label, icon: Icon }) => (
            <li key={to} className="flex-1">
              <NavLink
                to={to}
                className={({ isActive }) =>
                  cn(
                    "flex min-h-14 flex-col items-center justify-center gap-1 text-caption font-medium",
                    isActive ? "text-accent" : "text-ink-2",
                  )
                }
              >
                <Icon aria-hidden="true" className="size-6" strokeWidth={1.75} />
                {label}
              </NavLink>
            </li>
          ))}
        </ul>
      </nav>
    </div>
  );
}
