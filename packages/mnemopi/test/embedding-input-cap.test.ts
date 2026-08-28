import { afterEach, describe, expect, it } from "bun:test";

import {
	embed,
	resetEmbeddingProviderForTests,
	setEmbeddingProviderForTests,
} from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";

/**
 * Regression coverage for issue #3126: `MnemopiSessionState.retainMessages`
 * passes the entire multi-turn transcript to `embed()`. Long sessions used to
 * overflow whatever ctx the embedding server was started with — llama.cpp
 * rejects oversized requests with `request (N tokens) exceeds the available
 * context size`, OpenAI silently right-truncates. `embed()` now caps each
 * input to `MNEMOPI_EMBEDDING_MAX_INPUT_CHARS` (default 8192) before the
 * provider sees it.
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
	it("truncates oversized inputs to the default cap before reaching the provider", async () => {
		const provider = captureProvider();
		setEmbeddingProviderForTests(provider);

		const huge = "x".repeat(40_000);
		await withEnvValue(undefined, () => embed(["short", huge]));

		expect(provider.calls).toHaveLength(1);
		const [seenShort, seenHuge] = provider.calls[0] ?? [];
		expect(seenShort).toBe("short");
		expect(seenHuge?.length).toBe(8192);
	});

	it("honors MNEMOPI_EMBEDDING_MAX_INPUT_CHARS env override", async () => {
		const provider = captureProvider();
		setEmbeddingProviderForTests(provider);

		await withEnvValue("1024", () => embed(["y".repeat(5000)]));

		expect(provider.calls[0]?.[0]?.length).toBe(1024);
	});

	it("disables the cap when the env override is 0", async () => {
		const provider = captureProvider();
		setEmbeddingProviderForTests(provider);

		const huge = "z".repeat(50_000);
		await withEnvValue("0", () => embed([huge]));

		expect(provider.calls[0]?.[0]).toBe(huge);
	});

	it("respects a constructor-scoped maxInputChars override", async () => {
		const provider = captureProvider();
		setEmbeddingProviderForTests(provider);

		await withEnvValue(undefined, () =>
			withMnemopiRuntimeOptions({ embeddings: { maxInputChars: 256 } }, () => embed(["w".repeat(10_000)])),
		);

		expect(provider.calls[0]?.[0]?.length).toBe(256);
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
		expect(seen.length).toBe(8192);
		expect(seen.startsWith(earliest)).toBe(true);
		expect(seen.endsWith(latest)).toBe(true);
		expect(seen).toContain("[...]");
	});

	it("returns the original array reference when no input needs trimming", async () => {
		const provider = captureProvider();
		setEmbeddingProviderForTests(provider);

		await withEnvValue("1024", () => embed(["fits", "still fits"]));

		expect(provider.calls[0]).toEqual(["fits", "still fits"]);
	});
});
