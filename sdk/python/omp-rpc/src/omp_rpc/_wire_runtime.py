"""Decoding primitives for the generated wire module (`_wire.py`).

Every decoder takes `(value, path)` and returns the decoded value or raises
`ValueError` naming `path`. Generated parsers compose them; nothing here knows
about specific protocol types.
"""

from __future__ import annotations

from collections.abc import Iterator
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


_JSON_SCALARS = (str, int, float, bool)


def decode_json(value: object, path: str) -> JsonValue:
    """Deep-copies a JSON value, rejecting anything JSON cannot represent.

    Copies by recursion, the fastest way for the values a frame holds; a value
    nested deeper than recursion reaches (`get_tree` nests each session entry
    two levels under its parent) is copied again with a stack of its own. The
    copy is pure, so starting it again is safe.
    """
    try:
        return _copy_json(value, path)
    except RecursionError:
        return _copy_json_deep(value, path)


def _copy_json(value: object, path: str) -> JsonValue:
    """`decode_json` by recursion."""
    if value is None or isinstance(value, _JSON_SCALARS):
        return cast(JsonValue, value)
    if isinstance(value, list):
        return [_copy_json(item, path) for item in value]
    if isinstance(value, dict):
        cloned: JsonObject = {}
        for key, item in value.items():
            cloned[_json_key(key, path)] = _copy_json(item, path)
        return cloned
    raise ValueError(f"{path} must be JSON-serializable")


def _json_key(key: object, path: str) -> str:
    """`key` as the name of a JSON object's member; any other key raises `ValueError` naming `path`."""
    if isinstance(key, str):
        return key
    raise ValueError(f"{path} must contain string keys")


def _copy_json_deep(value: object, path: str) -> JsonValue:
    """`decode_json` with a stack of its own, for a value of any depth.

    It keeps the containers it is inside, so a container met inside itself (a
    cycle: JSON text holds none, but a caller that builds the value can make
    one) raises `ValueError`, where the copy would grow until memory ran out. A
    container that two branches share is copied in each, as recursion copies it.
    """
    scalars = _JSON_SCALARS
    if value is None or isinstance(value, scalars):
        return cast(JsonValue, value)
    inside: set[int] = set()
    # Each container being copied, innermost last: the source, its copy, and the members still to copy.
    frames: list[tuple[object, JsonValue, Iterator[object]]] = []

    def enter(source: object) -> JsonValue:
        """An empty copy of the list or dict `source`, pushed on `frames` to be filled."""
        if id(source) in inside:
            raise ValueError(f"{path} must not contain a cycle")
        copy: JsonValue
        if isinstance(source, list):
            copy = []
            frames.append((source, copy, iter(source)))
            inside.add(id(source))
            return copy
        if isinstance(source, dict):
            copy = {}
            frames.append((source, copy, iter(source.items())))
            inside.add(id(source))
            return copy
        raise ValueError(f"{path} must be JSON-serializable")

    root = enter(value)
    while frames:
        source, target, members = frames[-1]
        if isinstance(target, list):
            for item in members:
                if item is None or isinstance(item, scalars):
                    target.append(cast(JsonValue, item))
                else:
                    target.append(enter(item))
                    break
            else:
                frames.pop()
                inside.discard(id(source))
            continue
        copied = cast(JsonObject, target)
        for key, item in cast(Iterator[tuple[object, object]], members):
            name = _json_key(key, path)
            if item is None or isinstance(item, scalars):
                copied[name] = cast(JsonValue, item)
            else:
                copied[name] = enter(item)
                break
        else:
            frames.pop()
            inside.discard(id(source))
    return root


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
