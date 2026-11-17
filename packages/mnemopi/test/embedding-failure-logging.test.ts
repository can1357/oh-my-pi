import { afterEach, describe, expect, it, spyOn } from "bun:test";
import {
	available,
	embed,
	resetEmbeddingProviderForTests,
	setEmbeddingProviderForTests,
	setLocalModelInitializerForTests,
} from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { logger } from "@oh-my-pi/pi-utils";

const ENV_KEYS = [
	"NODE_ENV",
	"BUN_ENV",
	"MNEMOPI_NO_EMBEDDINGS",
	"MNEMOPI_EMBEDDING_MODEL",
	"MNEMOPI_EMBEDDING_API_URL",
	"MNEMOPI_EMBEDDING_API_KEY",
	"OPENROUTER_BASE_URL",
	"OPENROUTER_API_KEY",
	"OPENAI_API_KEY",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

/** Force the local-fastembed path: not a test runtime, local model, no API config. */
async function withLocalModelEnv<T>(fn: () => Promise<T>): Promise<T> {
	const snapshot: Partial<Record<EnvKey, string>> = {};
	for (const key of ENV_KEYS) {
		const value = process.env[key];
		if (value !== undefined) snapshot[key] = value;
		delete process.env[key];
	}
	process.env.MNEMOPI_EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5";
	resetEmbeddingProviderForTests();
	try {
		return await fn();
	} finally {
		for (const key of ENV_KEYS) {
			const value = snapshot[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
		resetEmbeddingProviderForTests();
	}
}

afterEach(() => {
	resetEmbeddingProviderForTests();
});

describe("embedding failure logging (#2322)", () => {
	it("logs local model load failures at debug level with model context", async () => {
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			await withLocalModelEnv(async () => {
				setLocalModelInitializerForTests(async () => {
					throw new Error("onnx init blew up");
				});

				expect(await embed(["hello"])).toBeNull();

				expect(debugSpy).toHaveBeenCalledWith(
					"mnemopi: local embedding model failed to load",
					expect.objectContaining({
						model: expect.any(String),
						error: expect.stringContaining("onnx init blew up"),
					}),
				);
				expect(warnSpy).not.toHaveBeenCalledWith(
					"mnemopi: local embedding model failed to load",
					expect.anything(),
				);
			});
		} finally {
			debugSpy.mockRestore();
			warnSpy.mockRestore();
		}
	});

	it("escalates the same failure to warn when runtime debug is enabled", async () => {
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			await withLocalModelEnv(async () => {
				setLocalModelInitializerForTests(async () => {
					throw new Error("onnx init blew up again");
				});

				expect(await withMnemopiRuntimeOptions({ debug: true }, () => embed(["hello"]))).toBeNull();

				expect(warnSpy).toHaveBeenCalledWith(
					"mnemopi: local embedding model failed to load",
					expect.objectContaining({ error: expect.stringContaining("onnx init blew up again") }),
				);
				expect(debugSpy).not.toHaveBeenCalledWith(
					"mnemopi: local embedding model failed to load",
					expect.anything(),
				);
			});
		} finally {
			debugSpy.mockRestore();
			warnSpy.mockRestore();
		}
	});
});

describe("embedding provider failure logging", () => {
	// Fails mid-stream, the way a provider whose backend drops does.
	const failingProvider = (message: string) => ({
		embed: async function* (_texts: readonly string[]): AsyncGenerator<number[][]> {
			yield* [];
			throw new Error(message);
		},
	});

	it("logs a failing runtime provider at debug level and still returns null", async () => {
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const result = await withMnemopiRuntimeOptions(
				{ embeddings: { provider: failingProvider("provider exploded") } },
				() => embed(["one", "two"]),
			);

			expect(result).toBeNull();
			expect(debugSpy).toHaveBeenCalledWith(
				"mnemopi: embedding provider failed",
				expect.objectContaining({ textCount: 2, error: expect.stringContaining("provider exploded") }),
			);
			expect(warnSpy).not.toHaveBeenCalledWith("mnemopi: embedding provider failed", expect.anything());
		} finally {
			debugSpy.mockRestore();
			warnSpy.mockRestore();
		}
	});

	it("escalates a failing runtime provider to warn when runtime debug is enabled", async () => {
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const result = await withMnemopiRuntimeOptions(
				{ debug: true, embeddings: { provider: failingProvider("provider exploded again") } },
				() => embed(["hello"]),
			);

			expect(result).toBeNull();
			expect(warnSpy).toHaveBeenCalledWith(
				"mnemopi: embedding provider failed",
				expect.objectContaining({ error: expect.stringContaining("provider exploded again") }),
			);
			expect(debugSpy).not.toHaveBeenCalledWith("mnemopi: embedding provider failed", expect.anything());
		} finally {
			debugSpy.mockRestore();
			warnSpy.mockRestore();
		}
	});

	it("logs a failing provider installed with setEmbeddingProvider", async () => {
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
		try {
			setEmbeddingProviderForTests(failingProvider("override exploded"));

			expect(await embed(["hello"])).toBeNull();
			expect(debugSpy).toHaveBeenCalledWith(
				"mnemopi: embedding provider failed",
				expect.objectContaining({ textCount: 1, error: expect.stringContaining("override exploded") }),
			);
		} finally {
			debugSpy.mockRestore();
		}
	});

	it("logs a provider whose availability check throws and reports it unavailable", async () => {
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
		try {
			setEmbeddingProviderForTests({
				embed: async function* (texts: readonly string[]): AsyncGenerator<number[][]> {
					yield texts.map(() => [0.1]);
				},
				available: () => {
					throw new Error("availability probe exploded");
				},
			});

			expect(await available()).toBe(false);
			expect(debugSpy).toHaveBeenCalledWith(
				"mnemopi: embedding provider availability check failed",
				expect.objectContaining({ error: expect.stringContaining("availability probe exploded") }),
			);
		} finally {
			debugSpy.mockRestore();
		}
	});
});
