"""problem+json body, mirroring problemSchema in packages/shared/src/contracts/problem.ts."""

from enum import StrEnum

from pydantic import Field

from garmin_service.models.base import ResponseModel


class ErrorCode(StrEnum):
    """The shared codes this service returns; a subset of packages/shared/src/error-codes.ts."""

    VALIDATION = "validation"
    UNAUTHORIZED = "unauthorized"
    NOT_FOUND = "not_found"
    RATE_LIMITED = "rate_limited"
    INTERNAL = "internal"
    GARMIN_AUTH_EXPIRED = "garmin_auth_expired"
    GARMIN_RATE_LIMITED = "garmin_rate_limited"
    GARMIN_UNAVAILABLE = "garmin_unavailable"
    GARMIN_MFA_REQUIRED = "garmin_mfa_required"


class Issue(ResponseModel):
    path: str
    message: str


class Problem(ResponseModel):
    type: str = "about:blank"
    title: str
    status: int
    code: ErrorCode
    detail: str | None = None
    request_id: str | None = None
    retry_after_seconds: int | None = Field(default=None, ge=0)
    issues: list[Issue] | None = None
