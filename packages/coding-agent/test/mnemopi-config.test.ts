import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadMnemopiConfig, type MnemopiBackendConfig } from "@oh-my-pi/pi-coding-agent/mnemopi/config";
import { getMemoriesDir } from "@oh-my-pi/pi-utils";

// `mnemopi.embeddingVariant` selects the concrete local embedding model, while an
// explicit `mnemopi.embeddingModel` is an advanced override that wins. Scoping is
// pinned to "global" so the resolver stays pure (no legacy-bank disk probing).
function mnemopiConfigFor(
	overrides: Record<string, unknown>,
	agentDir = "/tmp/mnemopi-config-test",
): MnemopiBackendConfig {
	const settings = Settings.isolated({ "mnemopi.scoping": "global", ...overrides });
	return loadMnemopiConfig(settings, agentDir);
}

function embeddingModelFor(overrides: Record<string, unknown>): string | undefined {
	return mnemopiConfigFor(overrides).providerOptions.embeddingModel;
}

describe("loadMnemopiConfig embedding variant resolution", () => {
	it("maps the en variant to BAAI/bge-base-en-v1.5", () => {
		expect(embeddingModelFor({ "mnemopi.embeddingVariant": "en" })).toBe("BAAI/bge-base-en-v1.5");
	});

	it("maps the multilingual variant to intfloat/multilingual-e5-large", () => {
		expect(embeddingModelFor({ "mnemopi.embeddingVariant": "multilingual" })).toBe("intfloat/multilingual-e5-large");
	});

	it("lets an explicit embeddingModel override win over the variant", () => {
		expect(
			embeddingModelFor({
				"mnemopi.embeddingVariant": "multilingual",
				"mnemopi.embeddingModel": "openai/text-embedding-3-small",
			}),
		).toBe("openai/text-embedding-3-small");
	});

	it("ignores a blank override and falls back to the variant", () => {
		expect(embeddingModelFor({ "mnemopi.embeddingVariant": "en", "mnemopi.embeddingModel": "   " })).toBe(
			"BAAI/bge-base-en-v1.5",
		);
	});

	it("honors MNEMOPI_EMBEDDING_MODEL when no explicit model setting is present", () => {
		const previous = Bun.env.MNEMOPI_EMBEDDING_MODEL;
		Bun.env.MNEMOPI_EMBEDDING_MODEL = "BAAI/bge-large-en-v1.5";
		try {
			// The documented env override must not be shadowed by the variant default.
			expect(embeddingModelFor({ "mnemopi.embeddingVariant": "en" })).toBe("BAAI/bge-large-en-v1.5");
		} finally {
			if (previous === undefined) delete Bun.env.MNEMOPI_EMBEDDING_MODEL;
			else Bun.env.MNEMOPI_EMBEDDING_MODEL = previous;
		}
	});

	it("lets an explicit embeddingModel setting win over the env var", () => {
		const previous = Bun.env.MNEMOPI_EMBEDDING_MODEL;
		Bun.env.MNEMOPI_EMBEDDING_MODEL = "BAAI/bge-large-en-v1.5";
		try {
			expect(embeddingModelFor({ "mnemopi.embeddingModel": "openai/text-embedding-3-small" })).toBe(
				"openai/text-embedding-3-small",
			);
		} finally {
			if (previous === undefined) delete Bun.env.MNEMOPI_EMBEDDING_MODEL;
			else Bun.env.MNEMOPI_EMBEDDING_MODEL = previous;
		}
	});
});

describe("loadMnemopiConfig database path resolution", () => {
	it("resolves a blank dbPath to persistent agent storage", () => {
		const agentDir = "/tmp/mnemopi-blank-db-path-test";
		const defaultPath = path.join(getMemoriesDir(agentDir), "mnemopi", "mnemopi.db");

		expect(mnemopiConfigFor({ "mnemopi.dbPath": "" }, agentDir).dbPath).toBe(defaultPath);
		expect(mnemopiConfigFor({ "mnemopi.dbPath": " \t " }, agentDir).dbPath).toBe(defaultPath);
	});
});
