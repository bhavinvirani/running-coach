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
  useGarminDisconnecting,
  useGarminLogin,
  useStartGarminLogin,
  type WaitingLogin,
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
  /** A start or a code is out, from this screen or before it was left: the form holds still and says so. */
  pending: boolean;
  /** The login Garmin may still wait for the code of, null when the next step is a new sign-in. */
  waiting: WaitingLogin | null;
  start: (request: StartGarminLoginRequest, answered: Answered<StartGarminLoginResponse>) => void;
  finish: (request: FinishGarminLoginRequest, answered: Answered<GarminLoginConnected>) => void;
  /** Start again: the waiting login no longer brings the code step back. */
  forget: () => void;
};

/** Disconnecting as the confirm step holds it. */
export type DisconnectActions = {
  /** A disconnect runs, from this screen or before it was left. */
  pending: boolean;
  /** The removal of the app's workouts runs, which takes a paced Garmin call per workout. */
  removing: boolean;
  disconnect: (query: DisconnectGarminQuery, answered: Answered<DisconnectGarminResponse>) => void;
};

/**
 * Everything the Garmin screen reads and does: the connection, its last sync and the time zone to show it
 * in, from /api/me; signing in with the code step; and disconnecting. Whether a sign-in or a disconnect
 * runs, and the login waiting for its code, come from the mutation cache, so leaving the screen and coming
 * back neither loses them nor allows a second request. The password and the code go into the requests
 * wrapped in SentOnce, so no cache keeps them.
 */
export function useGarminScreen() {
  const me = useMe();
  const start = useStartGarminLogin();
  const finish = useFinishGarminLogin();
  const loginState = useGarminLogin();
  const disconnect = useDisconnectGarmin();
  const disconnecting = useGarminDisconnecting();

  const login: LoginActions = {
    pending: loginState.pending,
    waiting: loginState.waiting,
    start: (request, answered) => start.mutate(new SentOnce(request), answered),
    finish: (request, answered) => finish.mutate(new SentOnce(request), answered),
    forget: loginState.forget,
  };

  return {
    ...screenState(me),
    login,
    disconnect: {
      ...disconnecting,
      disconnect: (query, answered) => disconnect.mutate(query, answered),
    } satisfies DisconnectActions,
  };
}
