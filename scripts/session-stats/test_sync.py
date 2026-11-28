"""Contracts of `sync.py` for a session's `entry_patch` records.

An elide pass appends a record that sets the shortened `content` of entries the
file already holds, instead of rewriting the file. The `ss_*` rows must hold the
content the records set, whether a record and its target arrive in one sync or a
record arrives after an earlier sync stored its target.

Run: python3 -m unittest scripts/session-stats/test_sync.py
"""

from __future__ import annotations

import importlib.util
import json
import sqlite3
import sys
import tempfile
import types
import unittest
from pathlib import Path
from unittest import mock

SYNC_PATH = Path(__file__).resolve().parent / "sync.py"
# A transcript whose two messages share an id, with a record for that id between them, and the text each
# message reads; every reader of a session file reads it (`crates/natives/src/transcripts.rs`, the
# TypeScript readers in `packages/utils` and `packages/stats`).
DUPLICATE_ID_FIXTURE = (
    Path(__file__).resolve().parents[2] / "crates" / "natives" / "fixtures" / "entry-patch-duplicate-id.json"
)

OUTPUT = "heavy output " * 200
OUTPUT_ELIDED = "[shaken ~1000 tokens — recover: artifact://7 (region 2)]"
PROMPT = "Summarize this log:\n" + "a line of a long pasted log\n" * 80
PROMPT_ELIDED = "Summarize this log:\n[shaken ~500 tokens — recover: artifact://7 (region 1)]"


class _WordEncoding:
    """Stands in for tiktoken's `o200k_base`, which needs a download: one token per word."""

    def encode_ordinary(self, text: str) -> list[str]:
        return text.split()

    def encode_ordinary_batch(self, texts: list[str], num_threads: int = 1) -> list[list[str]]:
        return [text.split() for text in texts]


def _load_sync() -> types.ModuleType:
    tiktoken = types.ModuleType("tiktoken")
    tiktoken.get_encoding = lambda name: _WordEncoding()
    spec = importlib.util.spec_from_file_location("session_stats_sync", SYNC_PATH)
    assert spec is not None and spec.loader is not None
    module = importlib.util.module_from_spec(spec)
    with mock.patch.dict(sys.modules, {"tiktoken": tiktoken, spec.name: module}):
        spec.loader.exec_module(module)
    return module


sync = _load_sync()


def _header() -> dict:
    return {
        "type": "session",
        "version": 3,
        "id": "session-1",
        "timestamp": "2026-11-20T10:00:00.000Z",
        "cwd": "/work",
    }


def _message(entry_id: str, message: dict) -> dict:
    return {
        "type": "message",
        "id": entry_id,
        "parentId": None,
        "timestamp": "2026-11-20T10:00:01.000Z",
        "message": message,
    }


def _user(entry_id: str, text: str) -> dict:
    return _message(entry_id, {"role": "user", "content": [{"type": "text", "text": text}]})


def _call(entry_id: str, call_id: str) -> dict:
    return _message(
        entry_id,
        {
            "role": "assistant",
            "content": [{"type": "toolCall", "id": call_id, "name": "read", "arguments": {"path": "a.log"}}],
            "model": "model-1",
            "provider": "provider-1",
        },
    )


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


def _content(entry_id: str, text: str) -> dict:
    return {"entryId": entry_id, "message": {"content": [{"type": "text", "text": text}]}}


def _append(path: Path, entries: list[dict]) -> None:
    with path.open("a", encoding="utf-8") as handle:
        for entry in entries:
            handle.write(json.dumps(entry, ensure_ascii=False) + "\n")


class EntryPatchSyncTest(unittest.TestCase):
    def setUp(self) -> None:
        tmp = tempfile.TemporaryDirectory()
        self.addCleanup(tmp.cleanup)
        self.path = Path(tmp.name) / "sessions" / "--work--" / "session-1.jsonl"
        self.path.parent.mkdir(parents=True)
        self.conn = sqlite3.connect(":memory:", isolation_level=None)
        self.addCleanup(self.conn.close)
        self.conn.executescript(sync.SCHEMA_SQL)

    def _sync(self) -> None:
        """One run of the sync over the session file, as `main` decides and writes it."""
        decision = sync.decide_action(self.path, sync.existing_state(self.conn), False)
        self.assertIsNotNone(decision)
        full_rebuild, start_offset, start_seq, patch_targets = decision
        rec = sync.parse_file(self.path, start_offset, start_seq, full_rebuild, patch_targets)
        sync.write_records(self.conn, rec, 0)

    def _rows(self) -> dict:
        return {
            "results": self.conn.execute(
                "SELECT entry_id, result_text FROM ss_tool_results ORDER BY seq"
            ).fetchall(),
            "users": self.conn.execute("SELECT entry_id, text_blob FROM ss_user_msgs ORDER BY seq").fetchall(),
            "offset": self.conn.execute("SELECT byte_offset FROM ss_sessions").fetchone()[0],
        }

    # A sync that ignored the records would store the heavy text an elide pass removed from the session.
    def test_rows_carry_the_content_the_records_of_the_same_read_set(self) -> None:
        _append(
            self.path,
            [
                _header(),
                # A record before its target applies to it.
                _record("p0", [_content("u1", PROMPT_ELIDED)]),
                _user("u1", PROMPT),
                _call("a1", "c1"),
                _result("r1", "c1", OUTPUT),
                # Of two records that set one field, the later in the file wins.
                _record("p1", [_content("r1", "[an older elision]")]),
                _record("p2", [_content("r1", OUTPUT_ELIDED)]),
            ],
        )
        self._sync()
        self.assertEqual(
            self._rows(),
            {
                "results": [("r1", OUTPUT_ELIDED)],
                "users": [("u1", PROMPT_ELIDED)],
                "offset": self.path.stat().st_size,
            },
        )

    # The sync reads only the bytes appended since its last run: a record there that names an entry an earlier
    # run stored must replace that entry's rows, as the full rewrite of the file did before records existed.
    def test_a_record_after_an_earlier_sync_rebuilds_the_rows_it_stored(self) -> None:
        _append(self.path, [_header(), _user("u1", PROMPT), _call("a1", "c1"), _result("r1", "c1", OUTPUT)])
        self._sync()
        _append(
            self.path,
            [
                _record("p1", [_content("r1", OUTPUT_ELIDED), _content("u1", PROMPT_ELIDED)]),
                _user("u2", "next prompt"),
            ],
        )
        self._sync()
        self.assertEqual(
            self._rows(),
            {
                "results": [("r1", OUTPUT_ELIDED)],
                "users": [("u1", PROMPT_ELIDED), ("u2", "next prompt")],
                "offset": self.path.stat().st_size,
            },
        )

    # A database synced by an older `sync.py` (parser_version 6, before records applied) holds rows derived
    # from unpatched entries; the next sync must rebuild them even when no new record arrives.
    def test_rebuilds_rows_synced_at_parser_version_6_before_records_applied(self) -> None:
        _append(
            self.path,
            [
                _header(),
                _user("u1", PROMPT),
                _call("a1", "c1"),
                _result("r1", "c1", OUTPUT),
                _record("p1", [_content("u1", PROMPT_ELIDED), _content("r1", OUTPUT_ELIDED)]),
            ],
        )
        with mock.patch.object(sync, "collect_entry_patches", return_value={}), mock.patch.object(
            sync, "EDIT_PARSER_VERSION", 6
        ):
            self._sync()
        self.assertEqual(self._rows()["users"], [("u1", PROMPT)])
        self.assertEqual(self._rows()["results"], [("r1", OUTPUT)])

        # Even with a new prompt appended (so the file is dirty without any new record), the bump forces a
        # full rebuild of the earlier rows rather than an incremental tail read.
        _append(self.path, [_user("u2", "next prompt")])
        self._sync()
        self.assertEqual(
            self._rows(),
            {
                "results": [("r1", OUTPUT_ELIDED)],
                "users": [("u1", PROMPT_ELIDED), ("u2", "next prompt")],
                "offset": self.path.stat().st_size,
            },
        )

    # When two entries share an id, the TypeScript reader patches only the last entry with that id; patching
    # every duplicate would alter rows the TypeScript readers leave untouched.
    def test_duplicate_entry_id_patches_only_the_last_entry(self) -> None:
        _append(
            self.path,
            [
                _header(),
                _user("u1", "first prompt"),
                _user("u1", "second prompt"),
                _record("p1", [_content("u1", PROMPT_ELIDED)]),
            ],
        )
        self._sync()
        self.assertEqual(self._rows()["users"], [("u1", "first prompt"), ("u1", PROMPT_ELIDED)])

    # The duplicate-id fixture every reader of a session file reads: the record between the two entries sets its
    # fields on the later one only.
    def test_reads_the_duplicate_id_fixture_every_reader_reads(self) -> None:
        fixture = json.loads(DUPLICATE_ID_FIXTURE.read_text(encoding="utf-8"))
        _append(self.path, fixture["lines"])
        self._sync()
        self.assertEqual(self._rows()["users"], [("u1", text) for text in fixture["reads"]])

    # The same fixture with the sync boundary between the record and the later entry: the first sync stores the
    # earlier entry patched, as its last entry with the id; the second must give it back its own content and patch
    # the later one, as a sync of the whole file does.
    def test_a_later_entry_with_a_patched_id_takes_the_record_from_the_entry_an_earlier_sync_patched(self) -> None:
        fixture = json.loads(DUPLICATE_ID_FIXTURE.read_text(encoding="utf-8"))
        _append(self.path, fixture["lines"][:3])
        self._sync()
        self.assertEqual(self._rows()["users"], [("u1", fixture["reads"][1])])
        _append(self.path, fixture["lines"][3:])
        self._sync()
        self.assertEqual(self._rows()["users"], [("u1", text) for text in fixture["reads"]])

    # A record may precede its target (entries another writer appended, a copy written out of order). A sync that
    # reads the record before its target must keep it: the next sync reads only the appended target, and would store
    # the content the record replaced, where a sync of the whole file stores the record's.
    def test_a_record_read_before_its_target_applies_when_a_later_sync_reads_the_target(self) -> None:
        # The first sync reads through the record; the second reads only the appended target.
        _append(self.path, [_header(), _record("p1", [_content("u1", PROMPT_ELIDED)])])
        self._sync()
        _append(self.path, [_user("u1", PROMPT)])
        self._sync()
        self.assertEqual(self._rows()["users"], [("u1", PROMPT_ELIDED)])

    # A record whose `customType` is written with a JSON `\u` escape (`"entry\u005fpatch"`) is still an
    # `entry_patch` record to `JSON.parse`, so the byte prefilter must not skip it.
    def test_applies_record_whose_custom_type_uses_json_escape(self) -> None:
        _append(self.path, [_header(), _user("u1", PROMPT)])
        raw_record = json.dumps(_record("p1", [_content("u1", PROMPT_ELIDED)]), ensure_ascii=False)
        escaped_record = raw_record.replace('"entry_patch"', '"entry\\u005fpatch"')
        with self.path.open("a", encoding="utf-8") as handle:
            handle.write(escaped_record + "\n")
        self._sync()
        self.assertEqual(self._rows()["users"], [("u1", PROMPT_ELIDED)])


if __name__ == "__main__":
    unittest.main()
