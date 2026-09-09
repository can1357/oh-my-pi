import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Model, ToolCall, Usage } from "@oh-my-pi/pi-ai";
import {
	createHarmonyAuditEvent,
	detectHarmonyLeak,
	detectHarmonyLeakInAssistantMessage,
	extractHarmonyRemoved,
	isHarmonyLeakMitigationTarget,
	recoverHarmonyToolCall,
	signalListLabel,
} from "@oh-my-pi/pi-ai/utils/harmony-leak";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import corpus from "./fixtures/harmony-leak-corpus.json" with { type: "json" };

interface CorpusPositive {
	id: string;
	kind: "edit_dsl" | "edit_json" | "eval";
	expectation: "recover" | "abort";
	input: string | null;
	argJson: string | null;
}
interface CorpusNegative {
	name: string;
	input: string;
}
const positives = corpus.positives as CorpusPositive[];
const negatives = corpus.negatives as CorpusNegative[];

const codexModel: Model = buildModel({ ...getBundledModel("openai-codex", "gpt-5.4") });
const anthropicModel: Model = buildModel({ ...getBundledModel("anthropic", "claude-sonnet-4-5") });

function createAssistantMessage(
	content: AssistantMessage["content"],
	stopReason: AssistantMessage["stopReason"] = "stop",
): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock-model",
		usage: createUsage(),
		stopReason,
		timestamp: Date.now(),
	};
}

function createUsage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function makeToolCallMessage(toolName: string, input: string | null, argJson: string | null): AssistantMessage {
	const callArgs: Record<string, unknown> =
		input !== null ? { input } : argJson !== null ? (JSON.parse(argJson) as Record<string, unknown>) : {};
	const toolCall: ToolCall = {
		type: "toolCall",
		id: "call_test",
		name: toolName,
		arguments: callArgs,
	};
	return createAssistantMessage([toolCall], "toolUse");
}

// Corpus tool-arg entries are wholly-contaminated args captured from real
// production leaks. detectHarmonyLeakInAssistantMessage keeps the tool_arg
// surface inert without a parse boundary (the production default), so these
// tests inject a boundary at 0 — the entire payload is treated as trailing
// garbage past the valid parse — to exercise tool-arg detection and recovery.
const wholePayloadTrailing = () => 0;

describe("isHarmonyLeakMitigationTarget", () => {
	it("targets models enabled by resolved compatibility policy", () => {
		expect(codexModel.compat).toMatchObject({ harmonyLeakMitigation: true });
		expect(isHarmonyLeakMitigationTarget(codexModel)).toBe(true);
	});

	it("does not target models without the compatibility policy", () => {
		expect(anthropicModel.compat).not.toMatchObject({ harmonyLeakMitigation: true });
		expect(isHarmonyLeakMitigationTarget(anthropicModel)).toBe(false);
	});
});

describe("detectHarmonyLeak — negative cases (must NOT trip)", () => {
	for (const neg of negatives) {
		it(neg.name, () => {
			// Base content guards (co-signal requirement, fence exemption) are
			// surface-independent; the extra `tool_arg` `T`-gate would mask them, so
			// assert them on a surface without it — a pass proves the heuristics.
			const detection = detectHarmonyLeak(neg.input, "assistant_text");
			expect(detection).toBeUndefined();
		});
	}

	it("user prose mentioning marker is not scanned (caller responsibility)", () => {
		// Sanity: detector itself fires on bare M only when paired with co-signals.
		// User-message exemption is enforced by the call site, not the detector.
		const harmless = "I read about to=functions.edit in the docs.";
		expect(detectHarmonyLeak(harmless, "assistant_text")).toBeUndefined();
	});

	it("streaming chunk-boundary split does not trip on partial marker", () => {
		// Detector only fires once the full marker resolves in the buffer.
		expect(detectHarmonyLeak("...to=funct", "tool_arg")).toBeUndefined();
		expect(detectHarmonyLeak("...to=functions.", "tool_arg")).toBeUndefined();
	});
});

describe("detectHarmonyLeak — positive corpus cases (must trip with co-signal)", () => {
	for (const pos of positives) {
		const surfaceText = pos.input ?? pos.argJson;
		if (surfaceText === null) continue;
		it(`${pos.id} (${pos.kind}) trips with co-signals`, () => {
			// Production feeds no boundary, so tool_arg stays inert. These corpus
			// payloads are wholly-contaminated args from real leaks, so a boundary at
			// 0 treats the whole payload as trailing and exercises the heuristics.
			const detection = detectHarmonyLeak(surfaceText, "tool_arg", {
				toolName: pos.kind === "eval" ? "eval" : "edit",
				parsedEnd: 0,
			});
			expect(detection).toBeDefined();
			// Every signal that did fire must include `M` plus at least one co-signal.
			for (const signal of detection!.signals) {
				expect(signal.classes.length).toBeGreaterThanOrEqual(2);
				expect(signal.classes).toContain("M");
			}
		});
	}
});

describe("detectHarmonyLeak — tool_arg T-gate", () => {
	// The strongest co-signals (channel word + marker + CJK) that a legitimate
	// edit of these very fixtures would carry inside its `input` argument.
	const embedded = "header line one\nanalysis to=functions.edit code 大发官网";

	it("does not trip on tool_arg without a parse boundary (no false hard-abort)", () => {
		expect(detectHarmonyLeak(embedded, "tool_arg")).toBeUndefined();
	});

	it("trips the same content on a non-tool surface (gate is tool_arg-specific)", () => {
		const detection = detectHarmonyLeak(embedded, "assistant_text");
		expect(detection).toBeDefined();
		expect(detection!.signals.some(s => s.classes.includes("M"))).toBe(true);
	});

	it("does not trip when the marker precedes the parse boundary (embedded content)", () => {
		// Whole payload is structurally valid → marker is before parsedEnd → no `T`.
		expect(detectHarmonyLeak(embedded, "tool_arg", { parsedEnd: embedded.length })).toBeUndefined();
	});

	it("trips when the marker trails the parse boundary (real leak signature)", () => {
		const boundary = embedded.indexOf("analysis");
		const detection = detectHarmonyLeak(embedded, "tool_arg", { parsedEnd: boundary });
		expect(detection).toBeDefined();
		// Every fired signal carries the `T` co-signal the gate requires.
		expect(detection!.signals.every(s => s.classes.includes("T"))).toBe(true);
	});
});

describe("recoverHarmonyToolCall — edit DSL", () => {
	const editDsl = positives.filter(p => p.kind === "edit_dsl");
	for (const fix of editDsl) {
		it(`${fix.id}: produces an args-truncated message ending with the *** Abort sentinel`, () => {
			const message = makeToolCallMessage("edit", fix.input, fix.argJson);
			const detection = detectHarmonyLeakInAssistantMessage(message, wholePayloadTrailing);
			expect(detection).toBeDefined();
			const recovered = recoverHarmonyToolCall(message, detection!);
			expect(recovered).toBeDefined();

			const recoveredCall = recovered!.message.content[0];
			expect(recoveredCall.type).toBe("toolCall");
			if (recoveredCall.type !== "toolCall") return; // narrow

			const cleanInput = recoveredCall.arguments.input;
			expect(typeof cleanInput).toBe("string");
			expect(cleanInput as string).toMatch(/\n\*\*\* Abort\n$/);
			// The cleaned input is a strict prefix of the original (plus the sentinel).
			expect((cleanInput as string).length).toBeLessThan(fix.input!.length + 16);
			expect((cleanInput as string).includes("to=functions.")).toBe(false);

			// Encrypted reasoning blob is dropped (we cannot validate it isn't contaminated).
			expect(recovered!.message.providerPayload).toBeUndefined();

			// Removed substring is non-empty and contains the marker we cut.
			expect(recovered!.removed.length).toBeGreaterThan(0);
			expect(recovered!.removed.includes("to=functions.")).toBe(true);
		});
	}

	it("idempotence: re-running detect+recover on the cleaned message is a no-op", () => {
		const fix = editDsl[0];
		const message = makeToolCallMessage("edit", fix.input, fix.argJson);
		const detection = detectHarmonyLeakInAssistantMessage(message, wholePayloadTrailing)!;
		const recovered = recoverHarmonyToolCall(message, detection)!;
		const second = detectHarmonyLeakInAssistantMessage(recovered.message, wholePayloadTrailing);
		expect(second).toBeUndefined();
	});

	it("rejects edit input that doesn't look like the patch DSL", () => {
		// Apply_patch envelope shape — its parser doesn't recognize *** Abort,
		// so we fall through to abort-and-retry rather than recover.
		const applyPatchInput =
			"*** Begin Patch\n*** Update File: a.ts\n@@\n-old\n+new\n*** End Patch\n analysis to=functions.edit code 大发官网";
		const message = makeToolCallMessage("edit", applyPatchInput, null);
		const detection = detectHarmonyLeakInAssistantMessage(message, wholePayloadTrailing)!;
		expect(detection).toBeDefined();
		const recovered = recoverHarmonyToolCall(message, detection);
		expect(recovered).toBeUndefined();
	});
});

describe("recoverHarmonyToolCall — edit JSON-schema (must NOT recover)", () => {
	for (const fix of positives.filter(p => p.kind === "edit_json")) {
		it(`${fix.id}: detects but refuses to recover`, () => {
			const message = makeToolCallMessage("edit", fix.input, fix.argJson);
			const detection = detectHarmonyLeakInAssistantMessage(message, wholePayloadTrailing);
			expect(detection).toBeDefined();
			const recovered = recoverHarmonyToolCall(message, detection!);
			// argJson cases either lack a string `input` field, or their `input`
			// doesn't start with `@<path>` — both go to abort-and-retry.
			expect(recovered).toBeUndefined();
		});
	}
});

describe("recoverHarmonyToolCall — eval", () => {
	for (const fix of positives.filter(p => p.kind === "eval")) {
		it(`${fix.id}: cleaned input ends with *** Abort sentinel`, () => {
			const message = makeToolCallMessage("eval", fix.input, fix.argJson);
			const detection = detectHarmonyLeakInAssistantMessage(message, wholePayloadTrailing);
			expect(detection).toBeDefined();
			const recovered = recoverHarmonyToolCall(message, detection!);
			expect(recovered).toBeDefined();
			const block = recovered!.message.content[0];
			if (block.type !== "toolCall") throw new Error("expected toolCall");
			const cleanInput = block.arguments.input;
			expect(typeof cleanInput).toBe("string");
			expect(cleanInput as string).toMatch(/\n\*\*\* Abort\n$/);
			expect((cleanInput as string).includes("to=functions.")).toBe(false);
		});
	}
});

describe("recoverHarmonyToolCall — unsupported tools", () => {
	it("returns undefined for tools not in the recovery registry", () => {
		const text =
			'{"path":"src/foo.ts","sel":"raw"}' /* legitimate-looking */ +
			" \tchangedFiles to=functions.read code  天天中彩票";
		const message = makeToolCallMessage("read", text, null);
		const detection = detectHarmonyLeakInAssistantMessage(message, wholePayloadTrailing);
		// Detector trips because of `G` (changedFiles) + `M`.
		expect(detection).toBeDefined();
		// But `read` is not in RECOVERY_REGISTRY, so no recovery offered.
		const recovered = recoverHarmonyToolCall(message, detection!);
		expect(recovered).toBeUndefined();
	});
});

describe("extractHarmonyRemoved", () => {
	it("returns the contaminated tail of a tool argument", () => {
		const fix = positives.filter(p => p.kind === "edit_json")[0];
		const message = makeToolCallMessage("edit", fix.input, fix.argJson);
		const detection = detectHarmonyLeakInAssistantMessage(message, wholePayloadTrailing)!;
		const removed = extractHarmonyRemoved(message, detection);
		expect(removed.length).toBeGreaterThan(0);
		expect(removed.startsWith("to=functions.")).toBe(true);
	});

	it("returns the contaminated tail of an assistant text block", () => {
		const text = "Some prose. analysis to=functions.edit code 大发官网";
		const message = createAssistantMessage([{ type: "text", text }], "stop");
		const detection = detectHarmonyLeakInAssistantMessage(message)!;
		const removed = extractHarmonyRemoved(message, detection);
		expect(removed.length).toBeGreaterThan(0);
		expect(removed.includes("to=functions.")).toBe(true);
	});
});

describe("createHarmonyAuditEvent", () => {
	it("captures sha + redacted preview by default; raw blob hidden", () => {
		const fix = positives.filter(p => p.kind === "edit_dsl")[0];
		const message = makeToolCallMessage("edit", fix.input, fix.argJson);
		const detection = detectHarmonyLeakInAssistantMessage(message, wholePayloadTrailing)!;
		const recovered = recoverHarmonyToolCall(message, detection)!;
		const event = createHarmonyAuditEvent({
			action: "truncate_resume",
			detection,
			model: codexModel,
			retryN: 0,
			removed: recovered.removed,
		});
		expect(event.removedLen).toBe(recovered.removed.length);
		expect(event.removedSha8).toMatch(/^[0-9a-f]{8}$/);
		// Default: no raw blob.
		expect(event.removedBlob).toBeUndefined();
		// Preview is non-empty and obeys the junk-only redaction (every
		// non-junk char becomes `·`; marker tokens are kept verbatim).
		expect(event.removedPreview.length).toBeGreaterThan(0);
		expect(event.signal).toBe(signalListLabel(detection.signals));
	});
});
