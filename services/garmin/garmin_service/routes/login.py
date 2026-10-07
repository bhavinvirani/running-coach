"""POST /connect and /connect/mfa: the web app's Garmin login with email, password and 2FA code.

The two calls without a token bundle: they make one. /connect runs the password login; when Garmin
asks for a code, the live login waits in pending_logins under loginId and the answer is
code_needed. /connect/mfa tries the code on that same login, so a refused code can be followed by
the right one. Both answer a bundle only when it holds both DI tokens. Neither call is paced or
retried (password_login), and nothing here is written to disk.

What /connect/mfa answers tells the web app whether the login still waits: garmin_mfa_rejected 422
and garmin_unavailable 502 keep it, so another code (or the same one) goes to the same login;
garmin_login_lost 409 and garmin_rate_limited 429 (and a bug's 500) mean it is gone and the runner
starts again with the email and password (after the wait, for a 429).

Logs carry the login id, the outcome and exception class names: never the email, password, code
or bundle.
"""

import logging

from fastapi import APIRouter

from garmin_service.errors import (
    ServiceError,
    from_code_exception,
    from_login_exception,
    login_lost,
    no_reusable_login,
)
from garmin_service.models.connect import (
    LoginCodeNeeded,
    LoginCodeRequest,
    LoginCodeResponse,
    LoginConnected,
    LoginRequest,
)
from garmin_service.models.problem import ErrorCode
from garmin_service.password_login import (
    PasswordLogin,
    PasswordLoginDep,
    code_refused,
    has_tokens,
    mfa_pending,
)
from garmin_service.pending_logins import MAX_CODES, PendingLogin, PendingLogins, PendingLoginsDep

log = logging.getLogger(__name__)
router = APIRouter()


@router.post("/connect")
def connect(
    body: LoginRequest, make_garmin: PasswordLoginDep, logins: PendingLoginsDep
) -> LoginCodeNeeded | LoginConnected:
    # The runner started over: a code sent now belongs to this login, not the one before.
    logins.discard(body.login_id)
    garmin = make_garmin(body.email, body.password)
    try:
        status, _ = garmin.login()
    except Exception as exc:
        error = from_login_exception(exc)
        if error is None:
            raise
        raise error from exc
    if status == "needs_mfa":
        garmin.password = None
        logins.put(body.login_id, garmin)
        log.info("garmin login waits for a code", extra={"login_id": body.login_id})
        return LoginCodeNeeded()
    bundle = _reusable_bundle(garmin)
    log.info("garmin login connected", extra={"login_id": body.login_id, "with_code": False})
    return LoginConnected(token_bundle=bundle)


@router.post("/connect/mfa")
def connect_code(body: LoginCodeRequest, logins: PendingLoginsDep) -> LoginCodeResponse:
    with logins.checkout(body.login_id) as pending:
        try:
            pending.garmin.resume_login({}, body.mfa_code)
        except Exception as exc:
            failure = _code_failure(logins, body.login_id, pending, exc)
            if failure is None:
                raise
            raise failure from exc
        logins.drop(body.login_id, pending)
    bundle = pending.garmin.client.dumps()
    if not has_tokens(bundle):
        # The code was spent on a login no other process can use; another code cannot help.
        raise login_lost(
            "Garmin accepted the code but signed in without a token the app can reuse."
        )
    log.info("garmin login connected", extra={"login_id": body.login_id, "with_code": True})
    return LoginCodeResponse(token_bundle=bundle)


def _code_failure(
    logins: PendingLogins, login_id: str, pending: PendingLogin, exc: Exception
) -> ServiceError | None:
    """What a failed code answers (None: a bug, answered 500), and whether its login stays.

    A refused code keeps the login, up to MAX_CODES. An outage keeps it while the library's MFA
    session survived, so the same code can be sent again: a 502 from here always means the login
    waits. A 429 drops it (another code now would only extend Garmin's block) and answers the 429.
    Any other Garmin or network failure drops it and answers garmin_login_lost: with the MFA
    session gone, no code can finish it. In garminconnect 0.3.17 the session ends only once Garmin
    accepted the code, so that is a login that failed after the code (the token check or the
    profile load that follow it).
    """
    error = from_code_exception(exc)
    if error is not None and code_refused(pending.garmin, exc):
        pending.refused_codes += 1
        if pending.refused_codes < MAX_CODES:
            _log_code_failure(login_id, pending, kept=True)
            return error
        logins.drop(login_id, pending)
        _log_code_failure(login_id, pending, kept=False)
        return login_lost(f"Garmin refused {MAX_CODES} codes for this login.")
    kept = (
        error is not None
        and error.code is ErrorCode.GARMIN_UNAVAILABLE
        and mfa_pending(pending.garmin)
    )
    if not kept:
        logins.drop(login_id, pending)
    _log_code_failure(login_id, pending, kept=kept)
    if error is None or kept or error.code is ErrorCode.GARMIN_RATE_LIMITED:
        return error
    return login_lost("Garmin accepted the code but did not finish the login.")


def _log_code_failure(login_id: str, pending: PendingLogin, *, kept: bool) -> None:
    # The error handler logs the code and the exception classes; this adds the login's state.
    log.info(
        "garmin login code failed",
        extra={"login_id": login_id, "refused_codes": pending.refused_codes, "login_kept": kept},
    )


def _reusable_bundle(garmin: PasswordLogin) -> str:
    bundle = garmin.client.dumps()
    if not has_tokens(bundle):
        raise no_reusable_login()
    return bundle
