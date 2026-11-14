"""Extension-declared URL schemes for the frozen :mod:`omp` package (ADR 0050).

An extension claims its URL schemes in the manifest ``[[schemes]]`` table and
registers them at activation with :func:`register`. A declared spelling has one
canonical form, with no aliases: it is lowercased with ASCII-only folding, must
match ``^[a-z][a-z0-9+.-]*$`` in full, must fit :data:`MAX_SCHEME_BYTES`, and
must not be a built-in wire name of the URL vocabulary that :mod:`omp.urls`
loads (``https`` and ``pr`` included). One extension registers at most
:data:`MAX_SCHEMES` schemes; a description fits :data:`MAX_DESCRIPTION_BYTES`.

Registration gates on the loaded manifest's claims (ADR 0050 S2). An optional
``read`` callable is stored for CONTROL ``omp.schemes.read``; writable declared
schemes are refused by the host in S2.
"""

from __future__ import annotations

import re as _re
import string as _string
import threading as _threading
from collections.abc import Callable as _Callable
from collections.abc import Mapping as _Mapping
from dataclasses import dataclass as _dataclass
from typing import Any as _Any
from typing import Final as _Final

from _omp_url_vocab import SCHEMES as _SCHEMES

from .urls import UrlError as _UrlError


class SchemeError(_UrlError):
    """A URL-scheme declaration was refused."""


class SchemeGrammarError(SchemeError):
    """A spelling misses ``^[a-z][a-z0-9+.-]*$`` after ASCII lowercasing."""


class BuiltinSchemeError(SchemeError):
    """A spelling is a built-in wire name of the URL vocabulary."""


class DuplicateSchemeError(SchemeError):
    """A spelling is declared twice after normalization."""


class SchemeLimitError(SchemeError):
    """A declaration exceeds a byte limit or the per-extension count."""


class UnclaimedSchemeError(SchemeError):
    """A spelling was not claimed by the loaded extension manifest."""


MAX_SCHEME_BYTES: _Final = 64
MAX_SCHEMES: _Final = 32
MAX_DESCRIPTION_BYTES: _Final = 4 * 1024

_GRAMMAR: _Final = _re.compile(r"[a-z][a-z0-9+.-]*")
_ASCII_LOWER: _Final = str.maketrans(_string.ascii_uppercase, _string.ascii_lowercase)
_BUILTIN_WIRE_NAMES: _Final = frozenset(
    spelling for _member, wire, _selectors in _SCHEMES for spelling in wire
)
_lock: _Final = _threading.Lock()
_declared: tuple[Declaration, ...] = ()
_readers: dict[str, _Callable[[str], _Any]] = {}
_claimed: frozenset[str] | None = None
_claims_configured: bool = False


def _canonical(spelling: object) -> str:
    if not isinstance(spelling, str):
        raise TypeError("scheme name must be str")
    if not spelling:
        raise SchemeGrammarError("URL scheme must not be empty")
    size = len(spelling.encode("utf-8", "surrogatepass"))
    if size > MAX_SCHEME_BYTES:
        raise SchemeLimitError(
            f"URL scheme is {size} bytes; the limit is {MAX_SCHEME_BYTES}"
        )
    canonical = spelling.translate(_ASCII_LOWER)
    if _GRAMMAR.fullmatch(canonical) is None:
        raise SchemeGrammarError(
            f"URL scheme {spelling!r} must match ^[a-z][a-z0-9+.-]*$"
        )
    if canonical in _BUILTIN_WIRE_NAMES:
        raise BuiltinSchemeError(f"URL scheme {canonical!r} is a built-in wire name")
    return canonical


@_dataclass(frozen=True, slots=True)
class Declaration:
    """One URL scheme an extension declares, mirroring a manifest ``[[schemes]]`` entry."""

    name: str
    description: str | None = None
    immutable: bool = False
    writable: bool = False

    def __post_init__(self) -> None:
        object.__setattr__(self, "name", _canonical(self.name))
        if self.description is not None:
            if not isinstance(self.description, str):
                raise TypeError("scheme description must be str or None")
            try:
                size = len(self.description.encode("utf-8"))
            except UnicodeEncodeError:
                raise SchemeError("scheme description must be valid UTF-8 text") from None
            if size > MAX_DESCRIPTION_BYTES:
                raise SchemeLimitError(
                    f"scheme description is {size} bytes; the limit is {MAX_DESCRIPTION_BYTES}"
                )
        for key in ("immutable", "writable"):
            if not isinstance(getattr(self, key), bool):
                raise TypeError(f"scheme {key} must be bool")


def configure_claims(claims: object | None) -> None:
    """Install the manifest-claimed scheme spellings for :func:`register` gating.

    ``None`` clears claim gating (S1 inert contract). A sequence of spellings or
    declaration mappings enables gating: an unclaimed name is refused.
    """
    global _claimed, _claims_configured
    if claims is None:
        _claimed = None
        _claims_configured = False
        return
    names: set[str] = set()
    if isinstance(claims, (str, bytes)) or not isinstance(claims, (list, tuple)):
        raise TypeError("scheme claims must be a sequence of spellings or mappings")
    for index, row in enumerate(claims):
        if isinstance(row, str):
            names.add(_canonical(row))
            continue
        if isinstance(row, _Mapping):
            name = row.get("name")
            if not isinstance(name, str):
                raise TypeError(f"schemes[{index}].name must be str")
            names.add(_canonical(name))
            continue
        raise TypeError(f"schemes[{index}] must be str or mapping")
    _claimed = frozenset(names)
    _claims_configured = True


def _require_claimed(name: str) -> None:
    if not _claims_configured:
        return
    assert _claimed is not None
    if name not in _claimed:
        raise UnclaimedSchemeError(
            f"URL scheme {name!r} is not claimed by the manifest"
        )


def register(
    *declarations: Declaration | str,
    read: _Callable[[str], _Any] | None = None,
) -> tuple[Declaration, ...]:
    """Register URL schemes for this extension and publish them into envd.

    Each argument is a :class:`Declaration` or a bare spelling. When the
    extension manifest configured claims, every spelling must be claimed.
    Built-in wire names are refused. Optional ``read`` is invoked by CONTROL
    ``omp.schemes.read`` with the authored URL and may return ``str``,
    ``bytes``, or a mapping with a ``content`` field.
    """
    global _declared
    if read is not None and not callable(read):
        raise TypeError("scheme read handler must be callable or None")
    if len(declarations) > MAX_SCHEMES:
        raise SchemeLimitError(
            f"{len(declarations)} URL schemes declared; the limit is {MAX_SCHEMES}"
        )
    batch = tuple(
        item if isinstance(item, Declaration) else Declaration(item)
        for item in declarations
    )
    for declaration in batch:
        _require_claimed(declaration.name)
    with _lock:
        names = {declaration.name for declaration in _declared}
        for declaration in batch:
            if declaration.name in names:
                raise DuplicateSchemeError(
                    f"URL scheme {declaration.name!r} is declared twice"
                )
            names.add(declaration.name)
        if len(names) > MAX_SCHEMES:
            raise SchemeLimitError(
                f"{len(names)} URL schemes declared; the limit is {MAX_SCHEMES}"
            )
        _declared = (*_declared, *batch)
        if read is not None:
            for declaration in batch:
                _readers[declaration.name] = read
    _publish_registered(batch)
    return batch


def declared() -> tuple[Declaration, ...]:
    """Return this extension's registered declarations, in registration order."""
    return _declared


def _publication_rows(
    declarations: tuple[Declaration, ...] | None = None,
) -> list[dict[str, object]]:
    rows = declarations if declarations is not None else _declared
    return [
        {
            "name": declaration.name,
            "description": declaration.description,
            "immutable": declaration.immutable,
            "writable": declaration.writable,
        }
        for declaration in rows
    ]


def _publish_registered(batch: tuple[Declaration, ...]) -> None:
    """Best-effort CONTROL publish; freeze also folds the full registered set."""
    if not batch:
        return
    try:
        from . import _control_backend
    except ImportError:
        return
    backend = _control_backend.get()
    if backend is None or not hasattr(backend, "request"):
        return
    # Registration during import may run before the CONTROL loop; freeze folds.


def dispatch_read(*, scheme: str, url: str) -> object:
    """CONTROL ``omp.schemes.read`` entry: invoke the registered read callable."""
    if not isinstance(scheme, str) or not scheme:
        raise SchemeError("omp.schemes.read requires a non-empty scheme")
    if not isinstance(url, str) or not url:
        raise SchemeError("omp.schemes.read requires a non-empty url")
    canonical = scheme.translate(_ASCII_LOWER)
    with _lock:
        reader = _readers.get(canonical)
        owned = any(declaration.name == canonical for declaration in _declared)
    if not owned:
        raise UnclaimedSchemeError(
            f"URL scheme {canonical!r} is not registered in this extension"
        )
    if reader is None:
        raise SchemeError(f"URL scheme {canonical!r} has no read handler")
    value = reader(url)
    if isinstance(value, (str, bytes, bytearray)):
        if isinstance(value, (bytes, bytearray)):
            return {"content": bytes(value).decode("utf-8", "surrogatepass")}
        return {"content": value}
    if isinstance(value, _Mapping):
        if "content" not in value:
            raise SchemeError("scheme read mapping requires a 'content' field")
        content = value["content"]
        if isinstance(content, (bytes, bytearray)):
            content = bytes(content).decode("utf-8", "surrogatepass")
        elif not isinstance(content, str):
            raise SchemeError("scheme read content must be str or bytes")
        payload: dict[str, object] = {"content": content}
        notes = value.get("notes")
        if notes is not None:
            if isinstance(notes, (str, bytes)) or not isinstance(notes, (list, tuple)):
                raise SchemeError("scheme read notes must be a sequence of strings")
            payload["notes"] = [str(note) for note in notes]
        return payload
    raise SchemeError("scheme read handler must return str, bytes, or a mapping")


def freeze_publication() -> list[dict[str, object]]:
    """Rows included in the FREEZE CONTROL publication for envd fold."""
    return _publication_rows()


__all__ = (
    "BuiltinSchemeError",
    "Declaration",
    "DuplicateSchemeError",
    "MAX_DESCRIPTION_BYTES",
    "MAX_SCHEMES",
    "MAX_SCHEME_BYTES",
    "SchemeError",
    "SchemeGrammarError",
    "SchemeLimitError",
    "UnclaimedSchemeError",
    "configure_claims",
    "declared",
    "dispatch_read",
    "freeze_publication",
    "register",
)
