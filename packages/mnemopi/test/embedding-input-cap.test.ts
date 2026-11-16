import { afterEach, describe, expect, it } from "bun:test";

import {
	embed,
	resetEmbeddingProviderForTests,
	setEmbeddingProviderForTests,
} from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { estimateTokens } from "@oh-my-pi/pi-mnemopi/core/text-window";

/**
 * Regression coverage for issue #3126: `MnemopiSessionState.retainMessages`
 * passes the entire multi-turn transcript to `embed()`. Long sessions used to
 * overflow whatever ctx the embedding server was started with — llama.cpp
 * rejects oversized requests with `request (N tokens) exceeds the available
 * context size`, OpenAI silently right-truncates. `embed()` now caps each
 * input to `MNEMOPI_EMBEDDING_MAX_INPUT_CHARS` (default 8192) and to the token
 * budget derived from it (default ~2048 tokens) before the provider sees it.
 */
function captureProvider(): {
	embed: (texts: readonly string[]) => AsyncGenerator<number[][]>;
	calls: string[][];
} {
	const calls: string[][] = [];
	return {
		calls,
		async *embed(texts) {
			calls.push([...texts]);
			yield texts.map(text => [text.length]);
		},
	};
}

function expectWithinTokenBudget(text: string | undefined, maxTokens: number): void {
	expect(text).toBeDefined();
	expect(estimateTokens(text ?? "")).toBeLessThanOrEqual(maxTokens);
}

const ENV_KEY = "MNEMOPI_EMBEDDING_MAX_INPUT_CHARS";

function withEnvValue<T>(value: string | undefined, fn: () => Promise<T>): Promise<T> {
	const previous = process.env[ENV_KEY];
	if (value === undefined) delete process.env[ENV_KEY];
	else process.env[ENV_KEY] = value;
	return fn().finally(() => {
		if (previous === undefined) delete process.env[ENV_KEY];
		else process.env[ENV_KEY] = previous;
	});
}

afterEach(() => {
	resetEmbeddingProviderForTests();
});

describe("embed() input cap (#3126)", () => {
	it("truncates oversized inputs to the default character and token caps", async () => {
		const provider = captureProvider();
		setEmbeddingProviderForTests(provider);

		const huge = "x".repeat(40_000);
		await withEnvValue(undefined, () => embed(["short", huge]));

		expect(provider.calls).toHaveLength(1);
		const [seenShort, seenHuge] = provider.calls[0] ?? [];
		expect(seenShort).toBe("short");
		expect(seenHuge?.length).toBeLessThan(8192);
		expectWithinTokenBudget(seenHuge, 2048);
	});

	it("shrinks CJK input by token estimate even when it fits the character cap", async () => {
		const provider = captureProvider();
		setEmbeddingProviderForTests(provider);

		// 10k CJK characters are under the 8192-character cap's neighborhood but
		// tokenize at ~1 token per character, far above the 2048-token budget.
		const cjk = "中".repeat(10_000);
		await withEnvValue(undefined, () => embed([cjk]));

		const seen = provider.calls[0]?.[0];
		expect(seen?.length).toBeLessThan(8192);
		expectWithinTokenBudget(seen, 2048);
	});

	it("honors MNEMOPI_EMBEDDING_MAX_INPUT_CHARS env override in both caps", async () => {
		const provider = captureProvider();
		setEmbeddingProviderForTests(provider);

		await withEnvValue("1024", () => embed(["y".repeat(5000)]));

		const seen = provider.calls[0]?.[0];
		expect(seen?.length).toBeLessThanOrEqual(1024);
		expectWithinTokenBudget(seen, 256);
	});

	it("disables both caps when the env override is 0", async () => {
		const provider = captureProvider();
		setEmbeddingProviderForTests(provider);

		const huge = "z".repeat(50_000);
		await withEnvValue("0", () => embed([huge]));

		expect(provider.calls[0]?.[0]).toBe(huge);
	});

	it("respects a constructor-scoped maxInputChars override in both caps", async () => {
		const provider = captureProvider();
		setEmbeddingProviderForTests(provider);

		await withEnvValue(undefined, () =>
			withMnemopiRuntimeOptions({ embeddings: { maxInputChars: 256 } }, () => embed(["w".repeat(10_000)])),
		);

		const seen = provider.calls[0]?.[0];
		expect(seen?.length).toBeLessThanOrEqual(256);
		expectWithinTokenBudget(seen, 64);
	});

	it("preserves both ends of a chronological transcript via the head/tail clip", async () => {
		const provider = captureProvider();
		setEmbeddingProviderForTests(provider);

		// `MnemopiSessionState.retainMessages` hands `embed()` the full
		// chronological transcript. Before the head/tail clip, a `slice(0, max)`
		// would land on the oldest turns and drop the most recent (and most
		// semantically loaded) content. Verify both ends survive.
		const earliest = "OPENING_TURN_MARKER";
		const latest = "FINAL_TURN_MARKER";
		const transcript = `${earliest}${"x".repeat(50_000)}${latest}`;

		await withEnvValue(undefined, () => embed([transcript]));

		const seen = provider.calls[0]?.[0] ?? "";
		expect(seen.length).toBeLessThanOrEqual(8192);
		expectWithinTokenBudget(seen, 2048);
		expect(seen.startsWith(earliest)).toBe(true);
		expect(seen.endsWith(latest)).toBe(true);
		expect(seen).toContain("[...]");
	});
});
