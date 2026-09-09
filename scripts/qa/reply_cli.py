"""Command-line adapter for the typed mock-model reply DSL."""

from __future__ import annotations

import argparse
import json

from harness import Reply, call, raw_call


def _append(namespace: argparse.Namespace, reply: Reply | str) -> None:
	replies = namespace.replies
	if replies is None:
		replies = []
		namespace.replies = replies
	replies.append(reply)


class _TextReply(argparse.Action):
	def __call__(self, parser, namespace, value, option_string=None):
		_append(namespace, value)


class _ToolReply(argparse.Action):
	def __call__(self, parser, namespace, values, option_string=None):
		tool, encoded = values
		try:
			arguments = json.loads(encoded)
		except json.JSONDecodeError as error:
			raise argparse.ArgumentError(self, f"invalid JSON arguments: {error.msg}") from error
		if not isinstance(arguments, dict):
			raise argparse.ArgumentError(self, "tool arguments must be a JSON object")
		_append(namespace, call(tool, arguments))


class _RawToolReply(argparse.Action):
	def __call__(self, parser, namespace, values, option_string=None):
		tool, arguments = values
		_append(namespace, raw_call(tool, arguments))


def add_reply_arguments(parser: argparse.ArgumentParser) -> None:
	"""Adds ordered text and tool-reply options to a QA command parser."""
	parser.set_defaults(replies=None)
	parser.add_argument(
		"--text",
		dest="replies",
		action=_TextReply,
		metavar="TEXT",
		help="append an assistant text reply",
	)
	parser.add_argument(
		"--call",
		dest="replies",
		action=_ToolReply,
		nargs=2,
		metavar=("TOOL", "JSON"),
		help="append one assistant tool-call reply",
	)
	parser.add_argument(
		"--raw-call",
		dest="replies",
		action=_RawToolReply,
		nargs=2,
		metavar=("TOOL", "ARGUMENTS"),
		help="append a tool call with a deliberately raw argument document",
	)
	parser.add_argument("--loop", action="store_true", help="repeat replies after exhaustion")


def require_replies(
	parser: argparse.ArgumentParser,
	namespace: argparse.Namespace,
) -> tuple[Reply | str, ...]:
	"""Returns ordered CLI replies or terminates with an argument error."""
	if not namespace.replies:
		parser.error("at least one --text, --call, or --raw-call is required")
	return tuple(namespace.replies)
