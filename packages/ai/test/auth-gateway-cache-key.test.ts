import { describe, expect, it } from "bun:test";
import { resolvePromptCacheKey } from "@oh-my-pi/pi-ai/auth-gateway/http";

describe("resolvePromptCacheKey", () => {
	it("prefers body.prompt_cache_key over everything else", () => {
		const headers = new Headers({ "x-prompt-cache-key": "from-header" });
		expect(
			resolvePromptCacheKey(
				{
					prompt_cache_key: "from-body",
					metadata: { session_id: "from-metadata" },
				},
				headers,
			),
		).toBe("from-body");
	});

	it("falls back to body.metadata.session_id when prompt_cache_key absent", () => {
		expect(resolvePromptCacheKey({ metadata: { session_id: "from-metadata" } }, undefined)).toBe("from-metadata");
	});

	it("falls back to body.metadata.conversation_id", () => {
		expect(resolvePromptCacheKey({ metadata: { conversation_id: "conv-1" } }, undefined)).toBe("conv-1");
	});

	it("falls back to the session inside Claude Code's metadata.user_id", () => {
		const userId = JSON.stringify({ device_id: "device", account_uuid: "account", session_id: "cc-session" });
		expect(resolvePromptCacheKey({ metadata: { user_id: userId } }, undefined)).toBe("cc-session");
	});

	it("does not key on an opaque metadata.user_id shared by every conversation of a user", () => {
		expect(resolvePromptCacheKey({ metadata: { user_id: "user-123" } }, new Headers())).toBeUndefined();
	});

	it("prefers explicit metadata.prompt_cache_key over session/conversation ids", () => {
		expect(
			resolvePromptCacheKey(
				{ metadata: { prompt_cache_key: "meta-pck", session_id: "sid", conversation_id: "cid" } },
				undefined,
			),
		).toBe("meta-pck");
	});

	it("falls back to x-prompt-cache-key header when body lacks anything", () => {
		expect(resolvePromptCacheKey({}, new Headers({ "x-prompt-cache-key": "hdr-pck" }))).toBe("hdr-pck");
	});

	it("falls back to Claude Code and OpenCode session headers", () => {
		expect(resolvePromptCacheKey({}, new Headers({ "x-claude-code-session-id": "cc-sid" }))).toBe("cc-sid");
		expect(resolvePromptCacheKey({}, new Headers({ "x-session-affinity": "oc-sid" }))).toBe("oc-sid");
	});

	it("falls back to codex session and thread headers in either spelling", () => {
		expect(resolvePromptCacheKey({}, new Headers({ "session-id": "codex-sid" }))).toBe("codex-sid");
		expect(resolvePromptCacheKey({}, new Headers({ "thread-id": "codex-tid" }))).toBe("codex-tid");
		expect(resolvePromptCacheKey({}, new Headers({ session_id: "legacy-sid" }))).toBe("legacy-sid");
		expect(resolvePromptCacheKey({}, new Headers({ conversation_id: "legacy-cid" }))).toBe("legacy-cid");
	});

	it("keys on codex-rs session-id over the per-thread id sent alongside it", () => {
		const headers = new Headers({ "thread-id": "subagent-thread", "session-id": "root-session" });
		expect(resolvePromptCacheKey({}, headers)).toBe("root-session");
	});

	it("falls back to vendor-neutral x-session-id / x-conversation-id headers", () => {
		expect(resolvePromptCacheKey({}, new Headers({ "x-session-id": "x-sid" }))).toBe("x-sid");
		expect(resolvePromptCacheKey({}, new Headers({ "x-conversation-id": "x-cid" }))).toBe("x-cid");
	});

	it("returns undefined when nothing resolvable is present", () => {
		expect(resolvePromptCacheKey({}, new Headers())).toBeUndefined();
		expect(resolvePromptCacheKey({}, undefined)).toBeUndefined();
		expect(resolvePromptCacheKey(null, undefined)).toBeUndefined();
		expect(resolvePromptCacheKey("not-an-object", undefined)).toBeUndefined();
	});

	it("ignores empty string body fields and empty header values", () => {
		expect(resolvePromptCacheKey({ prompt_cache_key: "" }, new Headers({ "x-prompt-cache-key": "fallback" }))).toBe(
			"fallback",
		);
	});

	it("ignores non-string body fields", () => {
		expect(
			resolvePromptCacheKey(
				{ prompt_cache_key: 123, metadata: { session_id: { nested: "wrong-type" } } },
				new Headers({ "x-session-id": "hdr-sid" }),
			),
		).toBe("hdr-sid");
	});
});
