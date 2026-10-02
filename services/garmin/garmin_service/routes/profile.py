"""POST /profile: the cheapest call that proves a token bundle still works.

The pattern every Garmin route follows (garmin-call skill):
1. FastAPI parses the body with the pydantic request model (camelCase on the wire).
2. connect(bundle) builds a fresh client and runs Garmin().login(tokenstore=bundle).
3. Library calls go through garmin.call(...), which keeps GARMIN_CALL_GAP_S between them.
4. The response carries garmin.token_bundle(): rotated by login's refresh, or unchanged.
Nothing is caught here; errors.py maps library exceptions to problem+json.

login() already loads the social profile, so this route needs no further library call.
"""

from fastapi import APIRouter

from garmin_service.client import ConnectDep
from garmin_service.models.profile import Profile, ProfileRequest, ProfileResponse

router = APIRouter()


@router.post("/profile")
def profile(body: ProfileRequest, connect: ConnectDep) -> ProfileResponse:
    garmin = connect(body.token_bundle)
    return ProfileResponse(
        token_bundle=garmin.token_bundle(),
        profile=Profile(display_name=garmin.display_name()),
    )
