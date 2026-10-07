import type {
  DisconnectGarminQuery,
  DisconnectGarminResponse,
  FinishGarminLoginRequest,
  GarminLoginConnected,
  StartGarminLoginRequest,
  StartGarminLoginResponse,
} from "@running-coach/shared";
import {
  SentOnce,
  useDisconnectGarmin,
  useFinishGarminLogin,
  useStartGarminLogin,
} from "@/api/garmin";
import { useMe } from "@/api/me";
import { screenState } from "@/api/screen-state";

/** What a part does once its request is answered; called only while the screen is on. */
export type Answered<T> = {
  onSuccess: (answer: T) => void;
  onError: (error: Error) => void;
};

/** Signing in to Garmin as the connect form holds it. */
export type LoginActions = {
  /** A start or a code is out: the form holds still and says so. */
  pending: boolean;
  start: (request: StartGarminLoginRequest, answered: Answered<StartGarminLoginResponse>) => void;
  finish: (request: FinishGarminLoginRequest, answered: Answered<GarminLoginConnected>) => void;
};

/** Disconnecting as the confirm step holds it. */
export type DisconnectActions = {
  pending: boolean;
  /** The removal of the app's workouts runs, which takes a paced Garmin call per workout. */
  removing: boolean;
  disconnect: (query: DisconnectGarminQuery, answered: Answered<DisconnectGarminResponse>) => void;
};

/**
 * Everything the Garmin screen reads and does: the connection, its last sync and the time zone to show it
 * in, from /api/me; signing in with the code step; and disconnecting. The password and the code go into the
 * requests wrapped in SentOnce, so no cache keeps them.
 */
export function useGarminScreen() {
  const me = useMe();
  const start = useStartGarminLogin();
  const finish = useFinishGarminLogin();
  const disconnect = useDisconnectGarmin();

  const login: LoginActions = {
    pending: start.isPending || finish.isPending,
    start: (request, answered) => start.mutate(new SentOnce(request), answered),
    finish: (request, answered) => finish.mutate(new SentOnce(request), answered),
  };

  return {
    ...screenState(me),
    login,
    disconnect: {
      pending: disconnect.isPending,
      removing: disconnect.isPending && disconnect.variables.workouts === "remove",
      disconnect: (query, answered) => disconnect.mutate(query, answered),
    } satisfies DisconnectActions,
  };
}
