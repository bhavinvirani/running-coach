"""Base classes for the wire models: snake_case fields in Python, camelCase JSON on the wire.

The zod schemas in packages/shared are the contract; tests/test_contract.py validates every response
these models produce against the exported JSON Schema.
"""

import re
from datetime import date
from typing import Annotated

from pydantic import BaseModel, BeforeValidator, ConfigDict
from pydantic.alias_generators import to_camel

_ISO_DATE = re.compile(r"[0-9]{4}-[0-9]{2}-[0-9]{2}")


def _iso_date(value: object) -> object:
    if isinstance(value, date):
        return value
    if isinstance(value, str) and _ISO_DATE.fullmatch(value):
        return date.fromisoformat(value)  # ValueError on 2026-02-30 becomes a validation issue
    raise ValueError("must be a date as YYYY-MM-DD")


# zod's z.iso.date(): exactly YYYY-MM-DD, a real calendar date, nothing else.
IsoDate = Annotated[date, BeforeValidator(_iso_date)]


class RequestModel(BaseModel):
    """A request body: camelCase keys only, unknown keys rejected, no coercion (zod .strict())."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_alias=True,
        validate_by_name=False,
        extra="forbid",
        strict=True,
        frozen=True,
    )


class ResponseModel(BaseModel):
    """A response body: built in Python by field name, serialized with camelCase aliases."""

    model_config = ConfigDict(
        alias_generator=to_camel,
        validate_by_alias=True,
        validate_by_name=True,
        serialize_by_alias=True,
        extra="forbid",
        frozen=True,
    )
