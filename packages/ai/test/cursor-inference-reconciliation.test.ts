import { describe, expect, test } from "bun:test";
import type { AssistantMessage } from "../src/types";
import { reconcileFinalContent } from "../src/providers/cursor/reconciliation";

type Content = AssistantMessage["content"];

const tool = (id: string, name = "join", value = "ok"): Content[number] => ({
	type: "toolCall",
	id,
	name,
	arguments: { value },
});
const thinking = (text: string, signature?: string): Content[number] => ({
	type: "thinking",
	thinking: text,
	...(signature === undefined ? {} : { thinkingSignature: signature }),
});

describe("Cursor final response reconciliation", () => {
	test("requires exact tool ids, names, and deep arguments", () => {
		expect(reconcileFinalContent([tool("call-1")], [tool("call-1")])).toEqual([tool("call-1")]);
		expect(() => reconcileFinalContent([tool("call-1")], [])).toThrow(
			"Cursor final response tool set disagrees with completed streamed tools",
		);
		expect(() => reconcileFinalContent([tool("call-1")], [tool("call-1", "other")])).toThrow(
			"Cursor final response changed the name of tool 'call-1'",
		);
		expect(() => reconcileFinalContent([tool("call-1")], [tool("call-1", "join", "changed")])).toThrow(
			"Cursor final response changed the arguments of tool 'call-1'",
		);
	});

	test("uses final text when present and streamed text when final text is absent", () => {
		expect(reconcileFinalContent([{ type: "text", text: "stream" }], [{ type: "text", text: "final" }])).toEqual([
			{ type: "text", text: "final" },
		]);
		expect(reconcileFinalContent([{ type: "text", text: "stream" }], [])).toEqual([{ type: "text", text: "stream" }]);
	});

	test("preserves equal text blocks when their positions are semantically distinct", () => {
		expect(
			reconcileFinalContent(
				[{ type: "text", text: "answer" }, thinking("pause"), { type: "text", text: "answer" }],
				undefined,
			),
		).toEqual([{ type: "text", text: "answer" }, thinking("pause"), { type: "text", text: "answer" }]);
		expect(
			reconcileFinalContent(
				[{ type: "text", text: "streamed copy" }],
				[{ type: "text", text: "answer" }, thinking("", "opaque"), { type: "text", text: "answer" }],
			),
		).toEqual([thinking("", "opaque"), { type: "text", text: "answer" }, { type: "text", text: "answer" }]);
	});

	test("attaches one exact opaque signature only when one streamed block is unambiguous", () => {
		expect(
			reconcileFinalContent(
				[thinking("streamed analysis")],
				[thinking("", "final-signature"), { type: "text", text: "answer" }],
			),
		).toEqual([thinking("streamed analysis", "final-signature"), { type: "text", text: "answer" }]);
	});

	test("never pairs several opaque final signatures by array index", () => {
		expect(
			reconcileFinalContent(
				[thinking("first"), thinking("second")],
				[thinking("", "sig-1"), thinking("", "sig-2"), { type: "text", text: "answer" }],
			),
		).toEqual([
			thinking("first"),
			thinking("second"),
			thinking("", "sig-1"),
			thinking("", "sig-2"),
			{ type: "text", text: "answer" },
		]);
	});

	test("preserves streamed thinking when final reasoning is redacted", () => {
		expect(
			reconcileFinalContent(
				[thinking("streamed analysis")],
				[
					{ type: "redactedThinking", data: "opaque" },
					{ type: "text", text: "answer" },
				],
			),
		).toEqual([
			thinking("streamed analysis"),
			{ type: "redactedThinking", data: "opaque" },
			{ type: "text", text: "answer" },
		]);
	});

	test("keeps non-empty final reasoning authoritative and preserves unmatched stream metadata", () => {
		expect(
			reconcileFinalContent(
				[thinking("draft", "stream-signature")],
				[thinking("final"), { type: "text", text: "answer" }],
			),
		).toEqual([thinking("final"), thinking("", "stream-signature"), { type: "text", text: "answer" }]);
	});
});
