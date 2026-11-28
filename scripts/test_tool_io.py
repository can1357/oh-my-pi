"""Contracts of `tool_io.py` for a session's `entry_patch` records.

An elide pass appends a record that sets the shortened `content` of entries the
file already holds, instead of rewriting the file. The tool invocations read
from a session must carry the content the records set, applied as
`@oh-my-pi/pi-utils/entry-patches` applies them.

Run: python3 -m unittest scripts/test_tool_io.py
"""

from __future__ import annotations

import json
import sys
import tempfile
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from tool_io import ToolIOConfig, iter_tool_invocations  # noqa: E402

OUTPUT_ELIDED = "[shaken ~1000 tokens — recover: artifact://7 (region 2)]"


def _message(entry_id: str, message: dict) -> dict:
    return {
        "type": "message",
        "id": entry_id,
        "parentId": None,
        "timestamp": "2026-11-20T10:00:01.000Z",
        "message": message,
    }


def _assistant_content(call_id: str, path: str, thinking: str) -> list[dict]:
    return [
        {"type": "thinking", "thinking": thinking},
        {"type": "toolCall", "id": call_id, "name": "read", "arguments": {"path": path}},
    ]


def _call(entry_id: str, call_id: str, path: str, thinking: str) -> dict:
    return _message(entry_id, {"role": "assistant", "content": _assistant_content(call_id, path, thinking)})


def _result(entry_id: str, call_id: str, text: str) -> dict:
    return _message(
        entry_id,
        {
            "role": "toolResult",
            "toolCallId": call_id,
            "toolName": "read",
            "content": [{"type": "text", "text": text}],
            "isError": False,
        },
    )


def _record(record_id: str, patches: list[dict]) -> dict:
    return {
        "type": "custom",
        "customType": "entry_patch",
        "id": record_id,
        "parentId": None,
        "timestamp": "2026-11-20T10:00:02.000Z",
        "data": {"patches": patches},
    }


def _content(entry_id: str, content: object) -> dict:
    return {"entryId": entry_id, "message": {"content": content}}


def _text(text: str) -> list[dict]:
    return [{"type": "text", "text": text}]


class EntryPatchToolIOTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.sessions = Path(tmp.name)
        self.path = self.sessions / "--work--" / "session-1.jsonl"
        self.path.parent.mkdir(parents=True)

    def _invocations(self, entries: list[dict | str]) -> dict:
        """The invocations of a session of `entries`; a string is written as the line itself."""
        header = {"type": "session", "version": 3, "id": "session-1", "timestamp": "2026-11-20T10:00:00.000Z"}
        self.path.write_text(
            "".join(
                (entry if isinstance(entry, str) else json.dumps(entry, ensure_ascii=False)) + "\n"
                for entry in [header, *entries]
            ),
            encoding="utf-8",
        )
        config = ToolIOConfig(sessions_dir=self.sessions, include_unresolved=False)
        return {
            invocation.tool_call_id: (invocation.arguments, invocation.assistant_thinking, invocation.result_text)
            for invocation in iter_tool_invocations("read", config)
        }

    # A reader that ignored the records, or applied them out of file order, would report the heavy output an
    # elide pass removed, or an older elision than the session holds.
    def test_invocations_carry_the_last_content_the_records_set_a_record_before_its_target_included(self) -> None:
        invocations = self._invocations(
            [
                _record("p0", [_content("a1", _assistant_content("c1", "[elided path]", "[elided reasoning]"))]),
                _call("a1", "c1", "a.log", "long reasoning " * 100),
                _result("r1", "c1", "heavy output " * 200),
                _record("p1", [_content("r1", _text("[an older elision]"))]),
                _record("p2", [_content("r1", _text(OUTPUT_ELIDED))]),
            ]
        )
        self.assertEqual(invocations, {"c1": ({"path": "[elided path]"}, "[elided reasoning]", OUTPUT_ELIDED)})

    # A damaged record must change nothing, and a patch the TypeScript readers reject (string content on a tool
    # result) must not drop the record's other patches; either way the Python and TypeScript readers would disagree.
    def test_skips_a_malformed_record_whole_and_a_misfit_patch_alone(self) -> None:
        invocations = self._invocations(
            [
                _call("a1", "c1", "a.log", "reasoning one"),
                _result("r1", "c1", "output one"),
                _call("a2", "c2", "b.log", "reasoning two"),
                _result("r2", "c2", "output two"),
                # A text block without its text makes the whole record malformed.
                _record("p1", [_content("r1", _text("[p1]")), _content("r2", [{"type": "text"}])]),
                _record("p2", [_content("r1", "a string"), _content("r2", _text("[p2]"))]),
            ]
        )
        self.assertEqual(
            invocations,
            {
                "c1": ({"path": "a.log"}, "reasoning one", "output one"),
                "c2": ({"path": "b.log"}, "reasoning two", "[p2]"),
            },
        )

    # The TypeScript readers parse every line, so they apply a record whose type another writer escaped;
    # a scan that missed it would report the heavy output the record replaced.
    def test_applies_a_record_whose_custom_type_is_written_with_a_json_escape(self) -> None:
        record = json.dumps(_record("p1", [_content("r1", _text(OUTPUT_ELIDED))]))
        escaped = record.replace('"entry_patch"', '"entry\\u005fpatch"')
        invocations = self._invocations(
            [_call("a1", "c1", "a.log", "reasoning"), _result("r1", "c1", "heavy output " * 200), escaped]
        )
        self.assertEqual(invocations, {"c1": ({"path": "a.log"}, "reasoning", OUTPUT_ELIDED)})

    # A thinking block without its `thinking` makes the TypeScript readers skip the record whole (the next turn
    # would throw building its context), and a tool call without its arguments has no input for the provider.
    def test_skips_whole_a_record_with_a_thinking_or_tool_call_block_without_its_payload(self) -> None:
        for block in ({"type": "thinking"}, {"type": "toolCall", "id": "c1", "name": "read"}):
            with self.subTest(block=block):
                invocations = self._invocations(
                    [
                        _call("a1", "c1", "a.log", "reasoning"),
                        _result("r1", "c1", "output"),
                        _record("p1", [_content("r1", _text("[p1]")), _content("a1", [block])]),
                    ]
                )
                self.assertEqual(invocations, {"c1": ({"path": "a.log"}, "reasoning", "output")})

    # When two entries share an id, `@oh-my-pi/pi-utils/entry-patches` patches only the last entry with
    # that id; patching every duplicate would disagree with every TypeScript reader.
    def test_duplicate_entry_id_patches_only_the_last_entry(self) -> None:
        invocations = self._invocations(
            [
                _call("a1", "c1", "a.log", "reasoning one"),
                _result("r1", "c1", "output one"),
                _call("a2", "c2", "b.log", "reasoning two"),
                _result("r1", "c2", "output two"),
                _record("p1", [_content("r1", _text(OUTPUT_ELIDED))]),
            ]
        )
        self.assertEqual(
            invocations,
            {
                "c1": ({"path": "a.log"}, "reasoning one", "output one"),
                "c2": ({"path": "b.log"}, "reasoning two", OUTPUT_ELIDED),
            },
        )

    # An image block without string `data` makes the whole record malformed (matching `isContentBlock` in TS),
    # so sibling patches in the same record do not apply; an image block with string `data` is valid.
    def test_image_block_without_string_data_makes_the_record_malformed(self) -> None:
        bad_block = {"type": "image", "mimeType": "image/png"}
        invocations = self._invocations(
            [
                _call("a1", "c1", "a.log", "reasoning one"),
                _result("r1", "c1", "output one"),
                _call("a2", "c2", "b.log", "reasoning two"),
                _result("r2", "c2", "output two"),
                _record("p1", [_content("r1", _text("[should-skip]")), _content("r2", [bad_block])]),
            ]
        )
        self.assertEqual(
            invocations,
            {
                "c1": ({"path": "a.log"}, "reasoning one", "output one"),
                "c2": ({"path": "b.log"}, "reasoning two", "output two"),
            },
        )

        valid_invocations = self._invocations(
            [
                _call("a1", "c1", "a.log", "reasoning one"),
                _result("r1", "c1", "output one"),
                _record(
                    "p1",
                    [
                        _content(
                            "r1",
                            [
                                {"type": "image", "data": "aGVsbG8=", "mimeType": "image/png"},
                                {"type": "text", "text": OUTPUT_ELIDED},
                            ],
                        )
                    ],
                ),
            ]
        )
        self.assertEqual(valid_invocations, {"c1": ({"path": "a.log"}, "reasoning one", OUTPUT_ELIDED)})

    # Every counter a patch sets (`tokensAfter`, `elidedOutputTokens`, `prunedAt`) must be a finite number
    # (not bool, string, null, overflow float `1e400`, or integer past float range `10**400`, which JS reads
    # as Infinity); a non-finite counter makes the whole record malformed.
    def test_non_finite_or_non_numeric_counter_makes_the_record_malformed(self) -> None:
        # One value per branch the check takes: an infinite float, an integer past float range, a bool, and a
        # value of another type.
        bad_counters = (
            "1e400",
            str(10**400),
            "true",
            "null",
        )
        counter_fields = (
            ("entry", "tokensAfter"),
            ("message", "elidedOutputTokens"),
            ("message", "prunedAt"),
        )
        for raw_counter in bad_counters:
            for container, field in counter_fields:
                with self.subTest(container=container, field=field, value=raw_counter):
                    raw_record = (
                        '{"type":"custom","customType":"entry_patch","id":"p1","parentId":null,'
                        '"timestamp":"2026-11-20T10:00:02.000Z","data":{"patches":['
                        + json.dumps(_content("r1", _text("[should-skip]")), ensure_ascii=False)
                        + f',{{"entryId":"r2","{container}":{{"{field}":{raw_counter}}}}}'
                        + "]}}"
                    )
                    invocations = self._invocations(
                        [
                            _call("a1", "c1", "a.log", "reasoning one"),
                            _result("r1", "c1", "output one"),
                            _call("a2", "c2", "b.log", "reasoning two"),
                            _result("r2", "c2", "output two"),
                            raw_record,
                        ]
                    )
                    self.assertEqual(
                        invocations,
                        {
                            "c1": ({"path": "a.log"}, "reasoning one", "output one"),
                            "c2": ({"path": "b.log"}, "reasoning two", "output two"),
                        },
                    )

        # A finite float and an integer in float range are accepted.
        for raw_counter in ("1e308", str(10**300)):
            with self.subTest(valid_value=raw_counter):
                raw_record = (
                    '{"type":"custom","customType":"entry_patch","id":"p1","parentId":null,'
                    '"timestamp":"2026-11-20T10:00:02.000Z","data":{"patches":['
                    + json.dumps(_content("r1", _text(OUTPUT_ELIDED)), ensure_ascii=False)
                    + f',{{"entryId":"r1","message":{{"prunedAt":{raw_counter}}}}}'
                    + "]}}"
                )
                invocations = self._invocations(
                    [
                        _call("a1", "c1", "a.log", "reasoning one"),
                        _result("r1", "c1", "output one"),
                        raw_record,
                    ]
                )
                self.assertEqual(invocations, {"c1": ({"path": "a.log"}, "reasoning one", OUTPUT_ELIDED)})


if __name__ == "__main__":
    unittest.main()
