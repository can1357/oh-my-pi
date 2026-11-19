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

	it("falls back to codex session_id / conversation_id headers", () => {
		expect(resolvePromptCacheKey({}, new Headers({ session_id: "codex-sid" }))).toBe("codex-sid");
		expect(resolvePromptCacheKey({}, new Headers({ conversation_id: "codex-cid" }))).toBe("codex-cid");
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
