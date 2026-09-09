"""Read-only package and site-tree metadata for the current omp host.

The host installs a verified snapshot before extension code runs.  This module never
scans ``sys.path``, imports a requested module, opens a lock, or touches the network:
that keeps deployment introspection declarative and preserves isolated-host policy.
"""
from __future__ import annotations

import builtins as _builtins
import json
from dataclasses import dataclass, field, replace
from enum import StrEnum
from pathlib import Path
from types import ModuleType, MappingProxyType
from typing import Any, Callable, Iterable, Literal, Mapping

from _omp import OmpError

from ._errors import ManifestError


class PackageError(OmpError, RuntimeError):
    """Package metadata is unavailable in the current execution context."""


class ResolutionError(PackageError):
    """Verified package ownership metadata contradicts the materialized site tree."""


class IntegrityError(PackageError):
    """An on-demand distribution integrity verification failed."""


class GrantError(PackageError):
    """A deployment operation lacks the operator-recorded capability grant."""


class Origin(StrEnum):
    """How a distribution became visible in this host's site tree."""

    FROZEN = "frozen"
    STORE = "store"
    LINK = "link"


class ContentKind(StrEnum):
    """Closed manifest vocabulary for shipped, non-executable content."""

    SKILLS = "skills"
    RULES = "rules"
    CONTEXT_FILES = "context-files"
    PROMPTS = "prompts"


@dataclass(frozen=True, slots=True)
class ContentDeclaration:
    """One manifest-declared content path or glob and its author metadata."""

    kind: ContentKind
    path: str
    metadata: Mapping[str, Any] = field(
        default_factory=lambda: MappingProxyType({})
    )

    def __post_init__(self) -> None:
        """Validate and freeze the host-supplied manifest row."""
        if not isinstance(self.kind, ContentKind):
            object.__setattr__(self, "kind", ContentKind(self.kind))
        if not isinstance(self.path, str) or not self.path:
            raise ManifestError(
                "<manifest>",
                "content.path",
                "content declaration path must be a non-empty str",
            )
        if not isinstance(self.metadata, Mapping):
            raise ManifestError(
                str(self.path),
                "content.metadata",
                "content declaration metadata must be a mapping",
            )
        object.__setattr__(
            self, "metadata", MappingProxyType(dict(self.metadata))
        )


def _normalize(name: str) -> str:
    """Return the PEP 503 comparison form of a distribution name."""
    if not isinstance(name, str) or not name:
        raise TypeError("distribution name must be a non-empty str")
    normalized = "-".join(part for part in name.lower().replace("_", "-").replace(".", "-").split("-") if part)
    if not normalized:
        raise ValueError("distribution name must include an alphanumeric segment")
    return normalized


@dataclass(frozen=True, slots=True)
class SettingSchema:
    """Validated schema for one user-editable manifest setting."""

    type: Literal["string", "number", "boolean", "enum"]
    default: str | float | bool | None = None
    description: str | None = None
    values: tuple[str, ...] | None = None
    min: float | None = None
    max: float | None = None
    step: float | None = None
    secret: bool = False
    env: str | None = None

    def __post_init__(self) -> None:
        self.validate()

    def validate(self) -> None:
        """Raise ``ManifestError`` when this setting schema is inconsistent."""
        if self.type not in {"string", "number", "boolean", "enum"}:
            raise ManifestError(
                "omp.toml", "settings.type", f"unknown setting type {self.type!r}"
            )
        if self.description is not None and not isinstance(self.description, str):
            raise ManifestError(
                "omp.toml", "settings.description", "must be str or None"
            )
        if self.values is not None:
            if isinstance(self.values, str):
                raise ManifestError(
                    "omp.toml",
                    "settings.values",
                    "must be a sequence of strings",
                )
            values = tuple(self.values)
            if any(not isinstance(item, str) or not item for item in values):
                raise ManifestError(
                    "omp.toml",
                    "settings.values",
                    "must contain non-empty strings",
                )
            object.__setattr__(self, "values", values)
        if self.type == "enum" and (
            self.values is None
            or self.default is not None
            and self.default not in self.values
        ):
            raise ManifestError(
                "omp.toml",
                "settings.default",
                "enum default must be one of values",
            )
        if self.type != "enum" and self.values is not None:
            raise ManifestError(
                "omp.toml",
                "settings.values",
                "is valid only for enum settings",
            )
        for name in ("min", "max", "step"):
            value = getattr(self, name)
            if value is not None and (
                not isinstance(value, (int, float)) or isinstance(value, bool)
            ):
                raise ManifestError(
                    "omp.toml",
                    f"settings.{name}",
                    "must be numeric or None",
                )
        if self.type != "number" and any(
            getattr(self, name) is not None for name in ("min", "max", "step")
        ):
            raise ManifestError(
                "omp.toml",
                "settings",
                "min, max, and step are valid only for number settings",
            )
        if self.min is not None and self.max is not None and self.min > self.max:
            raise ManifestError(
                "omp.toml", "settings.min", "must not exceed max"
            )
        if self.step is not None and self.step <= 0:
            raise ManifestError(
                "omp.toml", "settings.step", "must be positive"
            )
        if not isinstance(self.secret, bool):
            raise ManifestError(
                "omp.toml", "settings.secret", "must be bool"
            )
        if self.env is not None and (
            not isinstance(self.env, str) or not self.env
        ):
            raise ManifestError(
                "omp.toml",
                "settings.env",
                "must be a non-empty str or None",
            )


@dataclass(frozen=True, slots=True)
class Provenance:
    """The structurally stamped provenance septet for an extension action."""

    publisher: str
    extension_id: str
    version: str
    artifact_digest: str
    layer: str
    tier: str
    generation: int


@dataclass(frozen=True, slots=True)
class SiteTree:
    """One host's single materialized import tree."""

    path: Path
    key: str
    layer: str
    tier: str
    pool: str | None
    resolution: str
    lock: Path | None


@dataclass(frozen=True, slots=True)
class Distribution:
    """Verified metadata for one distribution visible to this host."""

    name: str
    version: str
    extension_id: str | None
    origin: Origin
    tag: str | None
    blake3: str | None
    root: Path | None
    files: tuple[Path, ...]
    declarations: tuple[ContentDeclaration, ...]
    requested_by: tuple[str, ...]
    vendored: tuple[str, ...]

    def verify(self, deep: bool = False) -> None:
        """Ask the host to verify this distribution's recorded integrity.

        Verification is deliberately explicit: listing metadata stays allocation-only,
        while a security-sensitive extension may request hash or RECORD verification.
        """
        if _verifier is None:
            raise IntegrityError("no package verifier is installed for this host")
        try:
            _verifier(self, deep)
        except IntegrityError:
            raise
        except Exception as error:  # Host bridges use their own concrete error types.
            raise IntegrityError(str(error)) from error


_snapshot: tuple[Distribution, ...] = ()
_by_name: dict[str, Distribution] = {}
_module_owners: dict[str, Distribution] = {}
_own_distribution: Distribution | None = None
_site_tree: SiteTree | None = None
_verifier: Callable[[Distribution, bool], None] | None = None


def _content_declaration(
    value: ContentDeclaration | Mapping[str, Any],
) -> ContentDeclaration:
    """Decode one verified content row from the uniform manifest table."""
    if isinstance(value, ContentDeclaration):
        return value
    if not isinstance(value, Mapping):
        raise TypeError(
            "content declaration must be a ContentDeclaration or mapping"
        )
    return ContentDeclaration(
        kind=ContentKind(str(value["kind"])),
        path=value["path"],
        metadata=value.get("metadata", {}),
    )


def _content_declarations(
    values: Iterable[ContentDeclaration | Mapping[str, Any]],
) -> tuple[ContentDeclaration, ...]:
    """Decode an extension's verified content declaration inventory."""
    return tuple(_content_declaration(value) for value in values)


def _distribution(value: Distribution | Mapping[str, Any]) -> Distribution:
    """Decode one host-supplied, already-verified metadata record."""
    if isinstance(value, Distribution):
        return value
    if not isinstance(value, Mapping):
        raise TypeError("distribution metadata must be a Distribution or mapping")
    origin = value.get("origin", Origin.FROZEN)
    return Distribution(
        name=_normalize(str(value["name"])),
        version=str(value["version"]),
        extension_id=value.get("extension_id"),
        origin=origin if isinstance(origin, Origin) else Origin(str(origin)),
        tag=value.get("tag"),
        blake3=value.get("blake3"),
        root=None if value.get("root") is None else Path(value["root"]),
        files=tuple(Path(path) for path in value.get("files", ())),
        declarations=_content_declarations(value.get("declarations", ())),
        requested_by=tuple(str(item) for item in value.get("requested_by", ())),
        vendored=tuple(str(item) for item in value.get("vendored", ())),
    )


def _configure_own_declarations(
    extension: str | None,
    declarations: tuple[ContentDeclaration, ...],
) -> None:
    """Attach configured manifest content to the calling distribution snapshot."""
    global _snapshot, _by_name, _module_owners, _own_distribution
    current = _own_distribution
    if current is None:
        if declarations:
            raise ResolutionError(
                "content declarations require an installed own distribution"
            )
        return
    if extension is not None and current.extension_id != extension:
        raise ResolutionError(
            "configured extension does not match the own distribution"
        )
    updated = replace(current, declarations=declarations)
    _snapshot = tuple(
        updated if distribution is current else distribution
        for distribution in _snapshot
    )
    _by_name = {
        _normalize(distribution.name): distribution
        for distribution in _snapshot
    }
    _module_owners = {
        module: updated if owner is current else owner
        for module, owner in _module_owners.items()
    }
    _own_distribution = updated


def _install_snapshot(
    distributions: Iterable[Distribution | Mapping[str, Any]],
    *,
    modules: Mapping[str, str | Distribution] = {},
    own: str | Distribution | None = None,
    tree: SiteTree | Mapping[str, Any] | None = None,
    verifier: Callable[[Distribution, bool], None] | None = None,
) -> None:
    """Install the host-generated read snapshot; private to the embedding bridge."""
    global _snapshot, _by_name, _module_owners, _own_distribution, _site_tree, _verifier
    snapshot = tuple(_distribution(item) for item in distributions)
    by_name = {_normalize(item.name): item for item in snapshot}
    if len(by_name) != len(snapshot):
        raise ResolutionError("site snapshot contains duplicate normalized distribution names")
    owners: dict[str, Distribution] = {}
    for module, owner in modules.items():
        resolved = by_name[_normalize(owner)] if isinstance(owner, str) else owner
        if resolved not in snapshot:
            raise ResolutionError(f"module owner {module!r} is not in the site snapshot")
        owners[module] = resolved
    if isinstance(own, str):
        own = by_name.get(_normalize(own))
    if own is not None and own not in snapshot:
        raise ResolutionError("own distribution is not in the site snapshot")
    if isinstance(tree, Mapping):
        tree = SiteTree(
            path=Path(tree["path"]), key=str(tree["key"]), layer=str(tree["layer"]),
            tier=str(tree["tier"]), pool=tree.get("pool"), resolution=str(tree["resolution"]),
            lock=None if tree.get("lock") is None else Path(tree["lock"]),
        )
    _snapshot, _by_name, _module_owners = snapshot, by_name, owners
    _own_distribution, _site_tree, _verifier = own, tree, verifier


def _install_snapshot_json(envelope: bytes | str) -> None:
    """Decode a native bootstrap envelope and install its verified package snapshot.

    The embedding host reads ``OMP_EXT_PACKAGE_SNAPSHOT`` and invokes this private
    bridge before extension code starts.  Keeping environment access outside this
    module preserves zero-I/O import semantics.
    """
    try:
        value = json.loads(envelope)
    except (TypeError, UnicodeDecodeError, json.JSONDecodeError) as error:
        raise ResolutionError("package snapshot envelope is not valid JSON") from error
    if not isinstance(value, Mapping):
        raise ResolutionError("package snapshot envelope must be an object")
    distributions = value.get("distributions")
    modules = value.get("modules", {})
    if not isinstance(distributions, _builtins.list) or not isinstance(modules, Mapping):
        raise ResolutionError("package snapshot has invalid distributions or modules")
    _install_snapshot(
        distributions,
        modules=modules,
        own=value.get("own"),
        tree=value.get("tree"),
    )


def list() -> _builtins.list[Distribution]:
    """Return every distribution visible in this host's site tree."""
    return _builtins.list(_snapshot)


def get(name: str) -> Distribution | None:
    """Look up a distribution by its PEP 503 normalized name."""
    return _by_name.get(_normalize(name))


def of(module: str | ModuleType) -> Distribution | None:
    """Return the RECORD owner of a loaded module without importing it."""
    name = module if isinstance(module, str) else module.__name__
    if not isinstance(name, str):
        raise TypeError("module must be a module object or module name")
    while name:
        owner = _module_owners.get(name)
        if owner is not None:
            return owner
        name = name.rpartition(".")[0]
    return None


def own() -> Distribution:
    """Return the calling extension distribution or raise outside extension code."""
    if _own_distribution is None:
        raise PackageError("no calling extension distribution is installed")
    return _own_distribution


def site() -> SiteTree:
    """Return this host's single materialized site tree."""
    if _site_tree is None:
        raise PackageError("no site tree is installed for this host")
    return _site_tree


# Kept as an alias instead of an import-time module alias so the public API can
# remain exactly ``omp.packages.list`` without shadowing Python's list globally.

__all__ = (
    "ContentDeclaration", "ContentKind", "Distribution", "GrantError",
    "IntegrityError", "Origin", "PackageError", "Provenance", "ResolutionError",
    "SettingSchema", "SiteTree", "get", "list",
    "of", "own", "site",
)
