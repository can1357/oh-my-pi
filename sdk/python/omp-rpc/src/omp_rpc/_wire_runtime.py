"""Decoding primitives for the generated wire module (`_wire.py`).

Every decoder takes `(value, path)` and returns the decoded value or raises
`ValueError` naming `path`. Generated parsers compose them; nothing here knows
about specific protocol types.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Callable, Mapping, TypeAlias, TypeVar, cast

JsonPrimitive: TypeAlias = str | int | float | bool | None
JsonValue: TypeAlias = JsonPrimitive | list["JsonValue"] | dict[str, "JsonValue"]
JsonObject: TypeAlias = dict[str, JsonValue]

T = TypeVar("T")
Decoder: TypeAlias = Callable[[object, str], T]


@dataclass(slots=True, frozen=True)
class UnknownNotification:
    """A frame this client does not model, or one that failed to parse (`parse_error`)."""

    payload: JsonObject
    type: str = "unknown"
    parse_error: str | None = field(default=None, kw_only=True)


def decode_json(value: object, path: str) -> JsonValue:
    """Deep-copies a JSON value, rejecting anything JSON cannot represent."""
    if value is None or isinstance(value, (str, int, float, bool)):
        return cast(JsonValue, value)
    if isinstance(value, list):
        return [decode_json(item, path) for item in value]
    if isinstance(value, dict):
        cloned: JsonObject = {}
        for key, item in value.items():
            if not isinstance(key, str):
                raise ValueError(f"{path} must contain string keys")
            cloned[key] = decode_json(item, path)
        return cloned
    raise ValueError(f"{path} must be JSON-serializable")


def decode_json_object(value: object, path: str) -> JsonObject:
    if not isinstance(value, dict):
        raise ValueError(f"{path} must be an object")
    return cast(JsonObject, decode_json(value, path))


def expect_object(value: object, path: str) -> Mapping[str, object]:
    if not isinstance(value, dict):
        raise ValueError(f"{path} must be an object")
    return cast(Mapping[str, object], value)


def decode_str(value: object, path: str) -> str:
    if not isinstance(value, str):
        raise ValueError(f"{path} must be a string")
    return value


def decode_int(value: object, path: str) -> int:
    if isinstance(value, bool) or not isinstance(value, int):
        raise ValueError(f"{path} must be an integer")
    return value


def decode_float(value: object, path: str) -> float:
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ValueError(f"{path} must be a number")
    return float(value)


def decode_bool(value: object, path: str) -> bool:
    if not isinstance(value, bool):
        raise ValueError(f"{path} must be a boolean")
    return value


def literal(values: frozenset[str]) -> Decoder[str]:
    """Decoder for a closed string enum."""

    def decode(value: object, path: str) -> str:
        if not isinstance(value, str) or value not in values:
            raise ValueError(f"{path} must be one of: {', '.join(sorted(values))}")
        return value

    return decode


def array(item: Decoder[T]) -> Decoder[tuple[T, ...]]:
    def decode(value: object, path: str) -> tuple[T, ...]:
        if not isinstance(value, list):
            raise ValueError(f"{path} must be a list")
        return tuple(item(element, f"{path}[{index}]") for index, element in enumerate(value))

    return decode


def record(values: Decoder[T]) -> Decoder[dict[str, T]]:
    def decode(value: object, path: str) -> dict[str, T]:
        payload = expect_object(value, path)
        return {key: values(item, f"{path}.{key}") for key, item in payload.items()}

    return decode


def nullable(inner: Decoder[T]) -> Decoder[T | None]:
    def decode(value: object, path: str) -> T | None:
        return None if value is None else inner(value, path)

    return decode


def scalar_or_array(item: Decoder[T]) -> Decoder[tuple[T, ...]]:
    """Accepts a bare scalar where older servers sent one instead of a list."""
    as_array = array(item)

    def decode(value: object, path: str) -> tuple[T, ...]:
        return as_array(value, path) if isinstance(value, list) else (item(value, path),)

    return decode


def open_record(key: str | None, values: frozenset[str] | None) -> Decoder[JsonObject]:
    """Decoder for an open record: checks the `key` discriminator against `values`, keeps every key."""

    def decode(value: object, path: str) -> JsonObject:
        payload = decode_json_object(value, path)
        if key is not None and values is not None:
            literal(values)(payload.get(key), f"{path}.{key}")
        return payload

    return decode


def or_unknown(decode: Decoder[T]) -> Decoder[T | UnknownNotification]:
    """Decodes with `decode`, degrading an object it rejects to `UnknownNotification`."""

    def lenient(value: object, path: str) -> T | UnknownNotification:
        try:
            return decode(value, path)
        except (TypeError, ValueError) as exc:
            return UnknownNotification(decode_json_object(value, path), parse_error=str(exc))

    return lenient


def required(payload: Mapping[str, object], key: str, decode: Decoder[T], path: str) -> T:
    if key not in payload:
        raise ValueError(f"{path}.{key} is required")
    return decode(payload[key], f"{path}.{key}")


def optional(payload: Mapping[str, object], key: str, decode: Decoder[T], path: str) -> T | None:
    value = payload.get(key)
    return None if value is None else decode(value, f"{path}.{key}")


def defaulted(
    payload: Mapping[str, object], key: str, decode: Decoder[T], path: str, default: T
) -> T:
    """Decodes `key`, or returns `default` when an older server omitted it."""
    return default if key not in payload else decode(payload[key], f"{path}.{key}")


def dispatch(key: str, cases: Mapping[str, Decoder[T]]) -> Decoder[T]:
    """Decoder for a discriminated union: routes on the `key` value."""

    def decode(value: object, path: str) -> T:
        payload = expect_object(value, path)
        tag = payload.get(key)
        case = cases.get(tag) if isinstance(tag, str) else None
        if case is None:
            raise ValueError(f"{path}.{key} must be one of: {', '.join(sorted(cases))}")
        return case(payload, path)

    return decode
