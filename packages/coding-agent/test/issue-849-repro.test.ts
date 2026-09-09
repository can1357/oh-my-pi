import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { buildSessionContext } from "@oh-my-pi/pi-coding-agent/session/session-context";
import type {
	ModelChangeEntry,
	SessionEntry,
	SessionMessageEntry,
} from "@oh-my-pi/pi-coding-agent/session/session-entries";

/**
 * Issue #849: After a user explicitly switches to gpt-5.5, the session reverts
 * to gpt-5.4 on resume.
 *
 * Root cause hypothesis: buildSessionContext walks entries in path order and
 * overwrites `models.default` from every assistant message's reported model.
 * When a temporary fallback (e.g. retry fallback or a server-side downgrade
 * in the codex provider) emits an assistant message tagged with the older
 * model id, that id clobbers the user's explicitly chosen default.
 *
 * Contract under test: an explicit `model_change` with role="default" must
 * win over assistant-message inference from later messages produced under a
 * temporary or downgraded model.
 */
describe("issue #849: explicit default model survives later assistant-message inference", () => {
	function makeAssistantEntry(
		id: string,
		parentId: string | null,
		provider: string,
		model: string,
	): SessionMessageEntry {
		const message: AssistantMessage = {
			role: "assistant",
			content: [{ type: "text", text: "ok" }],
			api: "openai-codex-responses",
			provider: provider as AssistantMessage["provider"],
			model,
			usage: {
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: Date.parse(`2026-04-30T00:00:0${id.slice(-1)}Z`),
		};
		return {
			type: "message",
			id,
			parentId,
			timestamp: new Date(message.timestamp).toISOString(),
			message,
		};
	}

	function makeModelChange(id: string, parentId: string | null, model: string, role: string): ModelChangeEntry {
		return {
			type: "model_change",
			id,
			parentId,
			timestamp: new Date().toISOString(),
			model,
			role,
		};
	}

	it("preserves explicit user-selected default when a later assistant message reports a downgraded model", () => {
		// User explicitly picks gpt-5.5 as default.
		// Then a temporary fallback (retry / context promotion) appends a
		// model_change with role="temporary" pointing at gpt-5.4, and the
		// next assistant message is produced under that temporary model.
		const entries: SessionEntry[] = [
			makeModelChange("a1", null, "openai-codex/gpt-5.5", "default"),
			makeAssistantEntry("a2", "a1", "openai-codex", "gpt-5.5"),
			makeModelChange("a3", "a2", "openai-codex/gpt-5.4", "temporary"),
			makeAssistantEntry("a4", "a3", "openai-codex", "gpt-5.4"),
		];

		const ctx = buildSessionContext(entries);
		expect(ctx.models.default).toBe("openai-codex/gpt-5.5");
	});

	it("preserves explicit user-selected default when the codex backend reports a different model id", () => {
		// User picks gpt-5.5; the assistant message returned by the upstream
		// codex backend is tagged "gpt-5.4" (server-side downgrade /
		// stale id mapping).  Resume must still restore what the user picked.
		const entries: SessionEntry[] = [
			makeModelChange("b1", null, "openai-codex/gpt-5.5", "default"),
			makeAssistantEntry("b2", "b1", "openai-codex", "gpt-5.4"),
		];

		const ctx = buildSessionContext(entries);
		expect(ctx.models.default).toBe("openai-codex/gpt-5.5");
	});

	it("still infers default from assistant messages when no model_change entry exists", () => {
		// Backwards compatibility: legacy sessions have no model_change entries
		// and rely on assistant-message inference.
		const entries: SessionEntry[] = [makeAssistantEntry("c1", null, "openai-codex", "gpt-5.4")];

		const ctx = buildSessionContext(entries);
		expect(ctx.models.default).toBe("openai-codex/gpt-5.4");
	});
});
