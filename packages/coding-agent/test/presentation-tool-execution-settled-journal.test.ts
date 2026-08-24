import { describe, expect, it } from "bun:test";
import type { ToolCallPresentation, ToolFactBody } from "@oh-my-pi/pi-agent-core/presentation";
import { byteOffset, factId, sequence, streamId, toolExecutionId } from "@oh-my-pi/pi-agent-core/presentation";
import { MODEL_PROJECTION_VERSION, TOOL_JOURNAL_RECORD_VERSION, toolCallRecordOf } from "../src/presentation/journal";
import { LiveToolPresentationRecord } from "../src/presentation/live-record";
import type { ToolPresentationView } from "../src/presentation/projections";
import { renderModelContent } from "../src/presentation/projections";
import { persistedToolJournalSchema } from "../src/presentation/schemas/journal";

/**
 * The `PersistedToolExecutionSettled` v4
 * journal entry a producer builds from a finished `ToolPresentationRecord`,
 * the agent loop's own `ToolOutcome`, and the `renderModelContent` frozen
 * projection.
 *
 * Deliberately exercises a shape the bash integration test
 * (`session-tool-execution-settled-journal.test.ts`) cannot reach in one call:
 * a mid-stream `terminal_gap` alongside a real `image` attachment, so the
 * `presentation.stream.gaps` array and the `modelProjection.content` image
 * block both round-trip through the strict zod schema — not merely the
 * text-only shape a bash run produces. Fixed-width, unique fixture lines
 * throughout.
 */

const FIXTURE_LINE = "journal-settled-fixture-4c2a\n"; // 37 bytes, all ASCII
const FIXTURE_IMAGE_BASE64 = "am91cm5hbC1zZXR0bGVkLWltYWdlLWZpeHR1cmU="; // arbitrary base64 payload

const CALL: ToolCallPresentation = {
	toolCallId: "call_settled_journal_4c2a",
	toolName: "bash",
	title: "Run journal-settled-fixture-4c2a",
	kind: "execute",
	rawInput: { command: "printf 'journal-settled-fixture-4c2a\\n'" },
};

describe("PersistedToolExecutionSettled journal entry", () => {
	it("round-trips a finished record + outcome + model projection through persistedToolJournalSchema", () => {
		const acc = new LiveToolPresentationRecord();
		const stream = streamId("settled-journal-fixture-stream");
		const lineBytes = byteOffset(Buffer.byteLength(FIXTURE_LINE, "utf-8"));

		acc.fold({
			type: "terminal_append",
			streamId: stream,
			sequence: sequence(0),
			startByte: byteOffset(0),
			data: FIXTURE_LINE,
		});
		// A real mid-stream gap: an explicit bounded producer queue dropping
		// undelivered bytes — never a retention/rollover artifact.
		acc.fold({
			type: "terminal_gap",
			streamId: stream,
			sequence: sequence(1),
			fromByte: lineBytes,
			toByte: byteOffset(lineBytes + 8),
		});
		const factBody: ToolFactBody = { kind: "wall_time", ms: 128 };
		acc.fold({ type: "fact", fact: { id: factId("settled-journal-fixture-fact"), ...factBody } });
		acc.fold({
			type: "attachment",
			attachment: { kind: "image", data: FIXTURE_IMAGE_BASE64, mimeType: "image/png" },
		});

		const presentation = acc.finish();
		const outcome = { kind: "succeeded" as const };
		const call = toolCallRecordOf(CALL);

		const view: ToolPresentationView = { call, outcome, presentation };
		const modelProjection = { version: MODEL_PROJECTION_VERSION, content: renderModelContent(view) };

		// The image attachment must have actually reached the model projection —
		// otherwise this test would validate the schema against a projection
		// that never exercised the `image` content block at all.
		expect(modelProjection.content.some(block => block.type === "image")).toBe(true);

		const entry = {
			type: "tool_execution_settled" as const,
			recordVersion: TOOL_JOURNAL_RECORD_VERSION,
			executionId: toolExecutionId("exec-settled-journal-fixture-4c2a"),
			outcome,
			presentation,
			modelProjection,
		};

		// Prove the on-disk hop (JSON.stringify/parse) does not lose anything the
		// schema requires — frozen arrays/objects and branded strings must all
		// survive as plain JSON.
		const roundTripped = JSON.parse(JSON.stringify(entry));
		const parsed = persistedToolJournalSchema.safeParse(roundTripped);
		expect(parsed.success, parsed.success ? undefined : JSON.stringify(parsed.error.issues)).toBe(true);
		if (!parsed.success) return;
		expect(parsed.data.type).toBe("tool_execution_settled");
		if (parsed.data.type !== "tool_execution_settled") return;
		expect(parsed.data.executionId).toBe(entry.executionId);
		expect(parsed.data.recordVersion).toBe(1);
		expect(parsed.data.presentation.stream?.gaps).toEqual([
			{ fromByte: lineBytes, toByte: byteOffset(lineBytes + 8) },
		]);
	});
});
