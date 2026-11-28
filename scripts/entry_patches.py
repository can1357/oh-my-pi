"""`entry_patch` records of a session transcript, for the Python readers of the file.

A pass that changes an entry after its line is written (a retry saga's marker, a
compaction's dead-end `warning` or corrected `tokensAfter`, a snapcompact
archive, an elide pass's placeholders) appends one `custom` entry with
`customType` `entry_patch` that names entries already in the file and the fields
to set on them, instead of rewriting the file. The original lines stay, so a
reader that shows or derives anything from those fields applies the records
first: `collect_entry_patches` over the transcript's lines, `last_target_lines`
to locate the last entry for each target id, then `patch_entry` on each entry
as it reads them again.

This module decides as `@oh-my-pi/pi-utils/entry-patches`
(`packages/utils/src/entry-patches.ts`) does: records apply in file order, so the
newest value of a field wins, a record may precede its target, and when entries
share an id only the last entry with that id is patched. A malformed record is
skipped whole; a patch whose target is missing, lacks a field it names, or holds
`content` of another shape is skipped alone.
"""

from __future__ import annotations

import copy
import json
import math
import re
from collections.abc import Iterable
from typing import Any

ENTRY_PATCH_CUSTOM_TYPE = "entry_patch"
# Bytes the line of every `entry_patch` record holds: its `customType` as JSON
# writes it. A scan for records parses only the lines that hold them, or that
# hold the same string with any of its characters written as a JSON `\u` escape
# (`entry\u005fpatch`), which a JSON parser reads as the same type.
ENTRY_PATCH_MARKER = json.dumps(ENTRY_PATCH_CUSTOM_TYPE).encode()
_ESCAPED_ENTRY_PATCH_MARKER = re.compile(
    b'"'
    + b"".join(
        b"(?:" + re.escape(char.encode()) + rb"|\\u(?i:" + f"{ord(char):04x}".encode() + b"))"
        for char in ENTRY_PATCH_CUSTOM_TYPE
    )
    + b'"'
)

# Message roles whose `content` an elide pass shortens, each with whether that
# `content` may be a string; assistant and tool-result `content` is always a
# list of blocks.
_CONTENT_TAKES_STRING = {
    "user": True,
    "developer": True,
    "assistant": False,
    "toolResult": False,
}
# Entry fields only a `compaction` entry has.
_COMPACTION_FIELDS = ("warning", "tokensAfter", "preserveData")
# Message fields only an assistant message has.
_ASSISTANT_FIELDS = ("retryRecovery", "contextSnapshot", "elidedOutputTokens")


def _is_content_block(block: Any) -> bool:
    """A typed block with the payload its type carries, as the model-context builder reads it.

    A block of another type passes on its `type` alone.
    """
    if not isinstance(block, dict) or not isinstance(block.get("type"), str):
        return False
    kind = block["type"]
    if kind == "text":
        return isinstance(block.get("text"), str)
    if kind == "thinking":
        return isinstance(block.get("thinking"), str) and (
            "thinkingSignature" not in block or isinstance(block["thinkingSignature"], str)
        )
    if kind == "redactedThinking":
        return isinstance(block.get("data"), str)
    if kind == "image":
        return isinstance(block.get("data"), str) and isinstance(block.get("mimeType"), str)
    if kind == "toolCall":
        return (
            isinstance(block.get("id"), str)
            and isinstance(block.get("name"), str)
            and isinstance(block.get("arguments"), dict)
        )
    if kind == "fallback":
        return all(
            isinstance(block.get(side), dict) and isinstance(block[side].get("model"), str)
            for side in ("from", "to")
        )
    if kind == "anthropicServerTool":
        return isinstance(block.get("block"), dict)
    return True


def _is_content(value: Any) -> bool:
    return isinstance(value, str) or (
        isinstance(value, list) and all(_is_content_block(block) for block in value)
    )


def _is_count(value: Any) -> bool:
    """Whether `value` is a finite number, as every counter a patch sets is."""
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        return False
    try:
        return math.isfinite(value)
    except OverflowError:  # an integer past float range, which JavaScript reads as Infinity
        return False


def _is_context_snapshot(snapshot: Any) -> bool:
    """An assistant's `contextSnapshot`: its prompt and non-message token counts
    finite numbers, and each optional count absent or one."""
    return (
        isinstance(snapshot, dict)
        and all(_is_count(snapshot.get(key)) for key in ("promptTokens", "nonMessageTokens"))
        and all(
            key not in snapshot or _is_count(snapshot[key])
            for key in ("toolSchemaTokens", "historyRewriteTokensRemoved", "compactionEpoch", "lastMessageTimestamp")
        )
    )


def _is_entry_fields(fields: Any) -> bool:
    return (
        isinstance(fields, dict)
        and ("warning" not in fields or isinstance(fields["warning"], str))
        and ("tokensAfter" not in fields or _is_count(fields["tokensAfter"]))
        and ("preserveData" not in fields or isinstance(fields["preserveData"], dict))
        and ("content" not in fields or _is_content(fields["content"]))
    )


def _is_message_fields(fields: Any) -> bool:
    return (
        isinstance(fields, dict)
        and ("retryRecovery" not in fields or isinstance(fields["retryRecovery"], dict))
        and ("contextSnapshot" not in fields or _is_context_snapshot(fields["contextSnapshot"]))
        and ("elidedOutputTokens" not in fields or _is_count(fields["elidedOutputTokens"]))
        and ("prunedAt" not in fields or _is_count(fields["prunedAt"]))
        and ("content" not in fields or _is_content(fields["content"]))
    )


def _is_entry_patch(patch: Any) -> bool:
    return (
        isinstance(patch, dict)
        and isinstance(patch.get("entryId"), str)
        and ("entry" not in patch or _is_entry_fields(patch["entry"]))
        and ("message" not in patch or _is_message_fields(patch["message"]))
    )


def is_entry_patch_record(entry: Any) -> bool:
    """Whether `entry` is an `entry_patch` record."""
    return (
        isinstance(entry, dict)
        and entry.get("type") == "custom"
        and entry.get("customType") == ENTRY_PATCH_CUSTOM_TYPE
    )


def entry_patches_of(record: dict[str, Any]) -> list[dict[str, Any]] | None:
    """The patches of `record`, or None when its `data` is malformed."""
    data = record.get("data")
    if not isinstance(data, dict):
        return None
    patches = data.get("patches")
    if not isinstance(patches, list) or not all(_is_entry_patch(patch) for patch in patches):
        return None
    return patches


def _target_id_of(entry: Any) -> str | None:
    """Id under which `entry` is a patch target: every entry but the session header has one."""
    if not isinstance(entry, dict) or entry.get("type") == "session":
        return None
    entry_id = entry.get("id")
    return entry_id if isinstance(entry_id, str) else None


def entry_accepts_patch(entry: Any, patch: dict[str, Any]) -> bool:
    """Whether every field `patch` names exists on `entry`'s kind.

    A `content` must also have the shape its role holds.
    """
    if not isinstance(entry, dict):
        return False
    fields = patch.get("entry")
    if fields is not None:
        if any(key in fields for key in _COMPACTION_FIELDS) and entry.get("type") != "compaction":
            return False
        if "content" in fields and entry.get("type") != "custom_message":
            return False
    patched = patch.get("message")
    if patched is None:
        return True
    message = entry.get("message")
    if entry.get("type") != "message" or not isinstance(message, dict):
        return False
    role = message.get("role")
    if any(key in patched for key in _ASSISTANT_FIELDS) and role != "assistant":
        return False
    if "prunedAt" in patched and role != "toolResult":
        return False
    if "content" not in patched:
        return True
    return isinstance(role, str) and role in _CONTENT_TAKES_STRING and (
        _CONTENT_TAKES_STRING[role] or not isinstance(patched["content"], str)
    )


def set_patched_fields(entry: dict[str, Any], patch: dict[str, Any]) -> None:
    """Set `patch`'s fields on `entry`, which `entry_accepts_patch` accepted.

    Each value is a copy of the record's, so `entry` shares no object with it.
    """
    kind = entry.get("type")
    fields = patch.get("entry")
    if fields is not None:
        if kind == "compaction":
            for key in _COMPACTION_FIELDS:
                if key in fields:
                    entry[key] = copy.deepcopy(fields[key])
        if "content" in fields and kind == "custom_message":
            entry["content"] = copy.deepcopy(fields["content"])
    patched = patch.get("message")
    message = entry.get("message")
    if patched is None or kind != "message" or not isinstance(message, dict):
        return
    if message.get("role") == "assistant":
        for key in _ASSISTANT_FIELDS:
            if key in patched:
                message[key] = copy.deepcopy(patched[key])
    if "prunedAt" in patched and message.get("role") == "toolResult":
        message["prunedAt"] = patched["prunedAt"]
    if "content" in patched and "content" in message:
        message["content"] = copy.deepcopy(patched["content"])


def collect_entry_patches(lines: Iterable[bytes]) -> dict[str, list[dict[str, Any]]]:
    """The patches of the `entry_patch` records among `lines`, by the id of the entry each names.

    `lines` are a transcript's raw lines in file order, so each id's patches are
    in file order. Only the lines that hold `ENTRY_PATCH_MARKER`, or the type
    written with a `\\u` escape, are parsed.
    """
    by_id: dict[str, list[dict[str, Any]]] = {}
    for raw in lines:
        if ENTRY_PATCH_MARKER not in raw and not (b"\\u" in raw and _ESCAPED_ENTRY_PATCH_MARKER.search(raw)):
            continue
        try:
            record = json.loads(raw)
        except ValueError:
            continue
        if not is_entry_patch_record(record):
            continue
        for patch in entry_patches_of(record) or ():
            by_id.setdefault(patch["entryId"], []).append(patch)
    return by_id


def last_target_lines(lines: Iterable[bytes], target_ids: Iterable[str]) -> dict[str, int]:
    """The 0-based line index of the last entry among `lines` for each id in `target_ids`.

    Matches `entriesById` in `packages/utils/src/entry-patches.ts`: every entry
    except a `session` header is a target, and when entries share an id the last
    one wins. Unparseable lines are ignored, as the transcript readers skip them.
    """
    wanted = set(target_ids)
    if not wanted:
        return {}
    last_line: dict[str, int] = {}
    for line_no, raw in enumerate(lines):
        if not raw.strip():
            continue
        try:
            entry = json.loads(raw)
        except ValueError:
            continue
        entry_id = _target_id_of(entry)
        if entry_id is not None and entry_id in wanted:
            last_line[entry_id] = line_no
    return last_line


def patch_entry(
    entry: dict[str, Any],
    by_id: dict[str, list[dict[str, Any]]],
    *,
    line_no: int | None = None,
    target_lines: dict[str, int] | None = None,
) -> bool:
    """Set on `entry` the fields of each patch `by_id` holds for it that fits it, in file order.

    When `target_lines` (from `last_target_lines`) and `line_no` are given, an
    earlier entry whose id is repeated later is left untouched, matching the
    TypeScript reader. Returns whether a record names `entry` (as the target).
    """
    entry_id = _target_id_of(entry)
    patches = by_id.get(entry_id) if entry_id is not None else None
    if patches is None:
        return False
    if target_lines is not None and line_no is not None and target_lines.get(entry_id) != line_no:
        return False
    for patch in patches:
        if entry_accepts_patch(entry, patch):
            set_patched_fields(entry, patch)
    return True
