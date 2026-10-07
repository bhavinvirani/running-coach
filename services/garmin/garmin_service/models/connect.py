"""POST /connect and /connect/mfa, mirroring garminLoginRequestSchema, garminLoginResponseSchema,
garminLoginCodeRequestSchema and garminLoginCodeResponseSchema.

repr=False keeps the email, password and code out of any repr of a request, so a stray log line or
traceback cannot carry them.
"""

from typing import Literal

from pydantic import Field

from garmin_service.models.base import RequestModel, ResponseModel

# zod's z.email() as exported to JSON Schema (garmin-email.json).
EMAIL_PATTERN = (
    r"^(?:[A-Za-z0-9_'+\-]+\.)*[A-Za-z0-9_'+\-]*[A-Za-z0-9_+-]@"
    r"(?:[A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$"
)
# ASCII digits only, like zod's /^\d{4,10}$/: pydantic's \d would also match other scripts' digits.
MFA_CODE_PATTERN = r"^[0-9]{4,10}$"


class LoginRequest(RequestModel):
    login_id: str = Field(min_length=1, max_length=128)
    email: str = Field(max_length=254, pattern=EMAIL_PATTERN, repr=False)
    password: str = Field(min_length=1, max_length=256, repr=False)


class LoginCodeNeeded(ResponseModel):
    status: Literal["code_needed"] = "code_needed"


class LoginConnected(ResponseModel):
    status: Literal["connected"] = "connected"
    token_bundle: str = Field(min_length=2, repr=False)


class LoginCodeRequest(RequestModel):
    login_id: str = Field(min_length=1, max_length=128)
    mfa_code: str = Field(pattern=MFA_CODE_PATTERN, repr=False)


class LoginCodeResponse(ResponseModel):
    token_bundle: str = Field(min_length=2, repr=False)
