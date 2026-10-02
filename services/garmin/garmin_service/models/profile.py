"""POST /profile, mirroring garminProfileRequestSchema and garminProfileResponseSchema."""

from pydantic import Field

from garmin_service.models.base import RequestModel, ResponseModel


class ProfileRequest(RequestModel):
    token_bundle: str = Field(min_length=2)


class Profile(ResponseModel):
    display_name: str | None


class ProfileResponse(ResponseModel):
    token_bundle: str = Field(min_length=2)
    profile: Profile
