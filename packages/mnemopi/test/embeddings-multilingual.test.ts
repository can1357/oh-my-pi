import { describe, expect, it } from "bun:test";

import {
	cosineSimilarity,
	embed,
	embeddingDimFor,
	isApiModel,
	resetEmbeddingProviderForTests,
	setEmbeddingProviderForTests,
} from "@oh-my-pi/pi-mnemopi/core/embeddings";

function withEnvValue<T>(key: string, value: string | undefined, fn: () => T): T {
	const previous = process.env[key];
	try {
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
		return fn();
	} finally {
		if (previous === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = previous;
		}
	}
}

function withEnvValues<T>(updates: Record<string, string | undefined>, fn: () => T): T {
	const previous: Record<string, string | undefined> = {};
	for (const key in updates) {
		previous[key] = process.env[key];
		const value = updates[key];
		if (value === undefined) {
			delete process.env[key];
		} else {
			process.env[key] = value;
		}
	}
	try {
		return fn();
	} finally {
		for (const key in previous) {
			const value = previous[key];
			if (value === undefined) {
				delete process.env[key];
			} else {
				process.env[key] = value;
			}
		}
	}
}

describe("multilingual embedding metadata", () => {
	it("detects English, Chinese, multilingual, Jina, and OpenAI dimensions", () => {
		withEnvValue("MNEMOPI_EMBEDDING_DIM", undefined, () => {
			expect(embeddingDimFor("BAAI/bge-small-en-v1.5")).toBe(384);
			expect(embeddingDimFor("BAAI/bge-base-en-v1.5")).toBe(768);
			expect(embeddingDimFor("BAAI/bge-large-en-v1.5")).toBe(1024);
			expect(embeddingDimFor("BAAI/bge-small-zh-v1.5")).toBe(512);
			expect(embeddingDimFor("BAAI/bge-base-zh-v1.5")).toBe(768);
			expect(embeddingDimFor("BAAI/bge-large-zh-v1.5")).toBe(1024);
			expect(embeddingDimFor("intfloat/multilingual-e5-small")).toBe(384);
			expect(embeddingDimFor("intfloat/multilingual-e5-base")).toBe(768);
			expect(embeddingDimFor("intfloat/multilingual-e5-large")).toBe(1024);
			expect(embeddingDimFor("BAAI/bge-m3")).toBe(1024);
			expect(embeddingDimFor("jina-embeddings-v5-omni-nano")).toBe(768);
			expect(embeddingDimFor("jina-embeddings-v5-omni-small")).toBe(1024);
			expect(embeddingDimFor("openai/text-embedding-3-small")).toBe(1536);
			expect(embeddingDimFor("text-embedding-3-large")).toBe(3072);
			expect(embeddingDimFor("some/unknown-model")).toBe(384);
		});
	});
	it("allows MNEMOPI_EMBEDDING_DIM to override model dimensions", () => {
		withEnvValue("MNEMOPI_EMBEDDING_DIM", "768", () => {
			expect(embeddingDimFor("BAAI/bge-small-en-v1.5")).toBe(768);
			expect(embeddingDimFor("unknown-model")).toBe(768);
		});
	});

	it("routes only explicit API models or custom endpoints to the API", () => {
		withEnvValues(
			{
				MNEMOPI_EMBEDDING_API_URL: undefined,
				MNEMOPI_EMBEDDINGS_VIA_API: undefined,
				OPENROUTER_BASE_URL: undefined,
			},
			() => {
				expect(isApiModel("openai/text-embedding-3-small")).toBe(true);
				expect(isApiModel("text-embedding-3-large")).toBe(true);
				expect(isApiModel("my-org/text-embedding-custom")).toBe(true);
				expect(isApiModel("BAAI/bge-small-en-v1.5")).toBe(false);
				expect(isApiModel("jina-embeddings-v5-omni-nano")).toBe(false);
			},
		);

		withEnvValues(
			{
				MNEMOPI_EMBEDDING_API_URL: undefined,
				MNEMOPI_EMBEDDINGS_VIA_API: undefined,
				OPENROUTER_BASE_URL: "https://llama.example/v1",
			},
			() => {
				expect(isApiModel("BAAI/bge-small-en-v1.5")).toBe(true);
				expect(isApiModel("some/random-model")).toBe(true);
			},
		);

		withEnvValues(
			{
				MNEMOPI_EMBEDDING_API_URL: undefined,
				MNEMOPI_EMBEDDINGS_VIA_API: undefined,
				OPENROUTER_BASE_URL: "https://openrouter.ai/api/v1",
			},
			() => {
				expect(isApiModel("jina-embeddings-v5-omni-nano")).toBe(false);
				expect(isApiModel("openai/text-embedding-3-small")).toBe(true);
			},
		);
	});
});

describe("multilingual embedding ordering", () => {
	it("preserves semantic ordering with a deterministic fake multilingual provider", async () => {
		setEmbeddingProviderForTests({
			async *embed(texts) {
				yield texts.map(text => {
					if (text.includes("猫") || text.toLowerCase().includes("cat") || text.toLowerCase().includes("gato")) {
						return [1, 0, 0];
					}
					if (text.includes("犬") || text.toLowerCase().includes("dog")) {
						return [0, 1, 0];
					}
					return [0, 0, 1];
				});
			},
		});

		try {
			const query = await embed(["猫について"]);
			const docs = ["the cat sleeps", "犬が走る", "el gato come", "unrelated astronomy"];
			const docVectors = await embed(docs);
			expect(query).not.toBeNull();
			expect(docVectors).not.toBeNull();
			if (query === null || docVectors === null) {
				throw new Error("fake provider returned no vectors");
			}

			const scored = docs.map((doc, index) => ({
				doc,
				score: cosineSimilarity(query[0] ?? [], docVectors[index] ?? []),
			}));
			scored.sort((a, b) => b.score - a.score || a.doc.localeCompare(b.doc));

			expect(scored[0]?.doc).toBe("el gato come");
			expect(scored[1]?.doc).toBe("the cat sleeps");
			expect(scored[0]?.score).toBeGreaterThan(scored[2]?.score ?? 0);
		} finally {
			resetEmbeddingProviderForTests();
		}
	});
});
