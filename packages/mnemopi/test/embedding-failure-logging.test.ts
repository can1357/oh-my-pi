import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import {
	embed,
	resetEmbeddingProviderForTests,
	setLocalModelInitializerForTests,
} from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { withMnemopiRuntimeOptions } from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import { logger } from "@oh-my-pi/pi-utils";
import { installEnvRestores } from "../../utils/test/helpers/mock-restores";

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

// Puts the variables back at the end of each test, at the next test, and when the file ends.
installEnvRestores(ENV_KEYS, { afterPutBack: resetEmbeddingProviderForTests });

/** Force the local-fastembed path for the rest of the test: not a test runtime, local model, no API config. */
async function withLocalModelEnv<T>(fn: () => Promise<T>): Promise<T> {
	for (const key of ENV_KEYS) delete process.env[key];
	process.env.MNEMOPI_EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5";
	resetEmbeddingProviderForTests();
	return await fn();
}

afterEach(() => {
	vi.restoreAllMocks();
	resetEmbeddingProviderForTests();
});

describe("embedding failure logging (#2322)", () => {
	it("logs local model load failures at debug level with model context", async () => {
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
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
			expect(warnSpy).not.toHaveBeenCalledWith("mnemopi: local embedding model failed to load", expect.anything());
		});
	});

	it("escalates the same failure to warn when runtime debug is enabled", async () => {
		const debugSpy = spyOn(logger, "debug").mockImplementation(() => {});
		const warnSpy = spyOn(logger, "warn").mockImplementation(() => {});
		await withLocalModelEnv(async () => {
			setLocalModelInitializerForTests(async () => {
				throw new Error("onnx init blew up again");
			});

			expect(await withMnemopiRuntimeOptions({ debug: true }, () => embed(["hello"]))).toBeNull();

			expect(warnSpy).toHaveBeenCalledWith(
				"mnemopi: local embedding model failed to load",
				expect.objectContaining({ error: expect.stringContaining("onnx init blew up again") }),
			);
			expect(debugSpy).not.toHaveBeenCalledWith("mnemopi: local embedding model failed to load", expect.anything());
		});
	});
});
