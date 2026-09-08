import { describe, expect, it } from "bun:test";
import { PromptCacheAffinityStore, type PromptCacheHit } from "@oh-my-pi/pi-ai/auth-gateway/prompt-cache-store";

const TTL_MS = 30 * 60 * 1000;
const MAX_ENTRIES = 4096;
const NOW_MS = 1_700_000_000_000;

function hit(overrides: Partial<PromptCacheHit> = {}): PromptCacheHit {
	return {
		provider: "openai",
		model: "gpt-5",
		accountId: "acct-1",
		...overrides,
	};
}

describe("PromptCacheAffinityStore", () => {
	it("remember then lookup returns the same hit", () => {
		const store = new PromptCacheAffinityStore();
		const remembered = hit({ provider: "anthropic", model: "claude-sonnet-4", accountId: "acct-9" });
		store.remember("fp-1", remembered, NOW_MS);
		expect(store.lookup("fp-1", NOW_MS)).toEqual(remembered);
	});

	it("unknown fingerprint is undefined (negative)", () => {
		const store = new PromptCacheAffinityStore();
		store.remember("fp-known", hit(), NOW_MS);
		expect(store.lookup("fp-unknown", NOW_MS)).toBeUndefined();
	});

	it("expired TTL is undefined (negative)", () => {
		const store = new PromptCacheAffinityStore();
		store.remember("fp-live", hit({ accountId: "live" }), NOW_MS);
		store.remember("fp-old", hit({ accountId: "old" }), NOW_MS);
		expect(store.lookup("fp-live", NOW_MS + TTL_MS - 1)).toEqual(hit({ accountId: "live" }));
		expect(store.lookup("fp-old", NOW_MS + TTL_MS)).toBeUndefined();
	});

	it("empty fingerprint is a no-op and lookup is undefined (negative)", () => {
		const store = new PromptCacheAffinityStore();
		store.remember("", hit({ accountId: "must-not-store" }), NOW_MS);
		expect(store.lookup("", NOW_MS)).toBeUndefined();
		store.remember("fp-live", hit(), NOW_MS);
		store.remember("", hit({ accountId: "still-not" }), NOW_MS);
		expect(store.lookup("fp-live", NOW_MS)).toEqual(hit());
	});

	it("evicts the oldest entry once the store exceeds 4096", () => {
		const store = new PromptCacheAffinityStore();
		for (let i = 0; i < MAX_ENTRIES; i += 1) {
			store.remember(`fp-${i}`, hit({ accountId: `acct-${i}` }), NOW_MS + i);
		}
		expect(store.lookup("fp-0", NOW_MS + MAX_ENTRIES)).toEqual(hit({ accountId: "acct-0" }));
		store.remember("fp-new", hit({ accountId: "acct-new" }), NOW_MS + MAX_ENTRIES);
		expect(store.lookup("fp-0", NOW_MS + MAX_ENTRIES)).toBeUndefined();
		expect(store.lookup("fp-1", NOW_MS + MAX_ENTRIES)).toEqual(hit({ accountId: "acct-1" }));
		expect(store.lookup("fp-new", NOW_MS + MAX_ENTRIES)).toEqual(hit({ accountId: "acct-new" }));
	});

	it("does not store prompt text on the hit (negative)", () => {
		const store = new PromptCacheAffinityStore();
		const poisoned = { ...hit(), prompt: "SECRET_PROMPT_TEXT" };
		store.remember("fp-safe", poisoned, NOW_MS);
		const found = store.lookup("fp-safe", NOW_MS);
		expect(found).toEqual(hit());
		expect(found && "prompt" in found).toBe(false);
		expect(JSON.stringify(found)).not.toContain("SECRET_PROMPT_TEXT");
		expect(JSON.stringify(found)).not.toContain("prompt");
	});
});
