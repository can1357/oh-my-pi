"""Behavior shared by the generated `ExtensionUiRequest` record."""

from __future__ import annotations

from typing import Final, Protocol

PASSIVE_EXTENSION_UI_METHODS: Final[frozenset[str]] = frozenset(
    {"notify", "setStatus", "setWidget", "setTitle", "set_editor_text", "open_url"}
)
"""Fire-and-forget presentation methods; they never take a response."""

INTERACTIVE_EXTENSION_UI_METHODS: Final[frozenset[str]] = frozenset(
    {"select", "confirm", "input", "editor", "ask"}
)
"""Dialog methods the host must answer (or cancel)."""

VALUE_EXTENSION_UI_METHODS: Final[frozenset[str]] = frozenset({"select", "input", "editor"})
"""Dialogs answered with `send_ui_value`."""


class _HasMethod(Protocol):
    @property
    def method(self) -> str: ...


class ExtensionUiRequestMixin:
    """Classifies an extension UI request by `method`."""

    __slots__ = ()

    def is_passive(self: _HasMethod) -> bool:
        return self.method in PASSIVE_EXTENSION_UI_METHODS

    def is_interactive(self: _HasMethod) -> bool:
        return self.method in INTERACTIVE_EXTENSION_UI_METHODS

    def accepts_text(self: _HasMethod) -> bool:
        return self.method in VALUE_EXTENSION_UI_METHODS

    def requires_response(self: _HasMethod) -> bool:
        return self.method in INTERACTIVE_EXTENSION_UI_METHODS
