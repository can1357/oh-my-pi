"""Hand-written helpers over the generated wire types (`_wire.py`)."""

from __future__ import annotations

import base64
import mimetypes
from pathlib import Path
from typing import cast

from ._wire import AgentMessage, ImageContent


def image_from_path(path: str | Path, mime_type: str | None = None) -> ImageContent:
    """Reads an image file into an inline `ImageContent` block for prompts."""
    file_path = Path(path)
    resolved_mime_type = (
        mime_type
        or mimetypes.guess_type(file_path.name)[0]
        or "application/octet-stream"
    )
    return {
        "type": "image",
        "mimeType": resolved_mime_type,
        "data": base64.b64encode(file_path.read_bytes()).decode("ascii"),
    }


def message_text(
    message: AgentMessage, *, include_thinking: bool = False
) -> str | None:
    """Concatenated visible text of a message; None for roles without text content."""
    role = message.get("role")
    if role not in {
        "user",
        "developer",
        "assistant",
        "toolResult",
        "custom",
        "hookMessage",
    }:
        return None

    content = message.get("content")
    if isinstance(content, str):
        return content
    if not isinstance(content, list):
        return None

    fragments: list[str] = []
    for block in content:
        if not isinstance(block, dict):
            continue
        block_type = block.get("type")
        if block_type == "text" and isinstance(block.get("text"), str):
            fragments.append(cast(str, block["text"]))
        elif (
            include_thinking
            and block_type == "thinking"
            and isinstance(block.get("thinking"), str)
        ):
            fragments.append(cast(str, block["thinking"]))
    return "".join(fragments) or None


def message_text_with_thinking(message: AgentMessage) -> str | None:
    return message_text(message, include_thinking=True)


def assistant_text(
    message: AgentMessage, *, include_thinking: bool = False
) -> str | None:
    if message.get("role") != "assistant":
        return None
    return message_text(message, include_thinking=include_thinking)


def assistant_text_with_thinking(message: AgentMessage) -> str | None:
    return assistant_text(message, include_thinking=True)
