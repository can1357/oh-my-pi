#!/usr/bin/env python3
"""Embedded ``omp.ui`` extension API spec cases.

These cases verify registration and pure projections through ``omp print``. Full keyboard,
focus, overlay, effects, and paint behavior requires the real TUI
and remains covered by the py-ui ledger rather than this headless extension harness.
"""

from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from harness import OMP_BINARY, call, drive, extension_fixture, introspect  # noqa: E402

COVERS = {
	"py": [
		"omp.ui.Action",
		"omp.ui.Activation",
		"omp.ui.ActivationSource",
		"omp.ui.Anchor",
		"omp.ui.Appearance",
		"omp.ui.Arg",
		"omp.ui.ArgQuery",
		"omp.ui.AskAnswer",
		"omp.ui.AskQuestion",
		"omp.ui.Charset",
		"omp.ui.Collapse",
		"omp.ui.CommandDenied",
		"omp.ui.CommandMountSpec",
		"omp.ui.CommandResult",
		"omp.ui.CompletionItem",
		"omp.ui.Consumed",
		"omp.ui.DialogCancel",
		"omp.ui.DialogOptions",
		"omp.ui.DialogOutcome",
		"omp.ui.DialogUnavailable",
		"omp.ui.DuplicateRenderer",
		"omp.ui.EventKind",
		"omp.ui.Field",
		"omp.ui.Ghost",
		"omp.ui.Graphics",
		"omp.ui.Invocation",
		"omp.ui.InvocationMode",
		"omp.ui.Level",
		"omp.ui.Margin",
		"omp.ui.Marker",
		"omp.ui.MessageView",
		"omp.ui.OverlayEvent",
		"omp.ui.OverlayHandle",
		"omp.ui.OverlayOptions",
		"omp.ui.Pct",
		"omp.ui.Phase",
		"omp.ui.Presentation",
		"omp.ui.Progress",
		"omp.ui.Prompt",
		"omp.ui.RenderCtx",
		"omp.ui.RenderPlace",
		"omp.ui.SelectItem",
		"omp.ui.ShortcutError",
		"omp.ui.Slot",
		"omp.ui.SlotDenied",
		"omp.ui.SlotHandle",
		"omp.ui.SlotOptions",
		"omp.ui.Sound",
		"omp.ui.StatusFacts",
		"omp.ui.TerminalInputDenied",
		"omp.ui.TerminalInputFrame",
		"omp.ui.Tml",
		"omp.ui.TmlError",
		"omp.ui.Token",
		"omp.ui.Trigger",
		"omp.ui.Urgency",
		"omp.ui.ask_user",
		"omp.ui.bell",
		"omp.ui.blur_slot",
		"omp.ui.clear_ghost",
		"omp.ui.command",
		"omp.ui.commands",
		"omp.ui.completion",
		"omp.ui.confirm",
		"omp.ui.dynamic_mount",
		"omp.ui.editor",
		"omp.ui.editor_text",
		"omp.ui.focus_slot",
		"omp.ui.form",
		"omp.ui.handle",
		"omp.ui.icon",
		"omp.ui.icons",
		"omp.ui.image",
		"omp.ui.input",
		"omp.ui.join",
		"omp.ui.limits",
		"omp.ui.markdown_transformer",
		"omp.ui.md",
		"omp.ui.message_renderer",
		"omp.ui.mount",
		"omp.ui.multi_select",
		"omp.ui.notify",
		"omp.ui.on_activate",
		"omp.ui.open_url",
		"omp.ui.overlay",
		"omp.ui.paste_to_editor",
		"omp.ui.presentation",
		"omp.ui.renderer",
		"omp.ui.select",
		"omp.ui.set_appearance",
		"omp.ui.set_clipboard",
		"omp.ui.set_editor_text",
		"omp.ui.set_ghost",
		"omp.ui.set_hidden_thinking_label",
		"omp.ui.set_progress",
		"omp.ui.set_status",
		"omp.ui.set_title",
		"omp.ui.set_tools_expanded",
		"omp.ui.set_working_indicator",
		"omp.ui.set_working_message",
		"omp.ui.shortcut",
		"omp.ui.submit",
		"omp.ui.terminal_input",
		"omp.ui.text",
		"omp.ui.themes",
		"omp.ui.tml",
		"omp.ui.tools_expanded",
		"omp.ui.unmount",
		"omp.ui.unmount_all",
	],
	"rpc": [],
}


class PyUi(unittest.TestCase):
	"""The complete live symbol floor plus representative behavioral families."""

	def test_all_ui_symbols_exist_in_the_embedded_runtime(self):
		report = introspect(COVERS["py"])
		self.assertEqual({symbol: status for symbol, status in report.items() if status != "ok"}, {})

	def test_trees_and_fold_projections_round_trip(self):
		with extension_fixture("ui/projection") as directory:
			result = drive(
				call("hello", name="case"),
				"done",
				prompt="exercise the UI projection",
				extensions=[directory],
				timeout=120,
			)
			self.assertFalse(result.timed_out, result.stderr)
			self.assertEqual(result.exit_code, 0, result.stderr)
			self.assertEqual(result.mock["served"], 2)
			tool_results = [
				tool
				for event in result.of_type("turn_end")
				for tool in event.get("toolResults", ())
			]
			self.assertEqual(len(tool_results), 1, result.stdout)
			parts = tool_results[0]["content"]
			self.assertEqual(len(parts), 1, repr(tool_results[0]))
			projection = json.loads(parts[0]["text"])
			self.assertEqual(projection["tml"], {"tree": "Tml", "rendered": "Tml"})
			self.assertEqual(
				projection["overlay"]["margin"],
				{"top": 1, "right": 2, "bottom": 3, "left": 4},
			)
			self.assertEqual(projection["fold"]["transformed"], "QA projection")
			self.assertEqual(projection["dispatch"], {"action": "qa-action", "command": "qa-ui"})

	def test_command_registration_is_accepted_during_composition(self):
		with extension_fixture("ui/command") as directory:
			result = drive(
				"composed",
				prompt="compose the registered command",
				extensions=[directory],
				timeout=90,
			)
			self.assertFalse(result.timed_out, result.stderr)
			self.assertEqual(result.exit_code, 0, result.stderr)
			self.assertEqual(result.mock["served"], 1)


if __name__ == "__main__":
	if not OMP_BINARY.exists():
		sys.exit(f"missing {OMP_BINARY}; run the project build first")
	unittest.main()
