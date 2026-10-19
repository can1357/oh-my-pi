/** Mnemopi adapter: runs `BeamMemory` in the harness process with the same embedding model as upstream Mnemosyne. */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import { embed } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import {
	type MnemopiEmbeddingProvider,
	type ResolvedMnemopiRuntimeOptions,
	withMnemopiRuntimeOptions,
} from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { getFastembedCacheDir } from "@oh-my-pi/pi-utils";
import type { EngineAdapter, MnemopiRecall, ProtocolName, RecallHit } from "../engine";
import { envName, PythonProcess } from "./python-process";
import { enginePython, resolveCacheRoot } from "../paths";

const EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5";
/** Where Mnemopi's JS fastembed keeps this model under its cache dir (`packages/mnemopi/src/core/fastembed-model-cache.ts`). */
const JS_MODEL_DIR = "Qdrant_bge-small-en-v1.5-onnx-Q";
const REPO_ROOT = path.resolve(import.meta.dir, "../../../../..");
const PACKAGE_JSON = path.join(REPO_ROOT, "packages", "mnemopi", "package.json");
const EMBED_SCRIPT = path.resolve(import.meta.dir, "../py/embed_server.py");

/**
 * `js`: Mnemopi's own local fastembed (production behaviour).
 * `python`: the same model through Python fastembed, about 20-40x faster here; Mnemopi's retrieval code is unchanged.
 */
export type MnemopiEmbedder = "js" | "python";

export interface MnemopiEngineOptions {
	embedder?: MnemopiEmbedder;
	/** Venv and Python-embedder model cache root. */
	cacheRoot?: string;
	recall?: MnemopiRecall;
	/** Polyphonic recall (omp's `mnemopi.polyphonicRecall`); only `recallEnhanced` runs it. */
	polyphonic?: boolean;
	/** Overrides for the embedding server process (tests use a stub). */
	embedPython?: string;
	embedScript?: string;
}

/** Mnemopi runs in this process and reads these itself, so they cannot be scrubbed: refuse instead. */
export function assertMnemopiEnvClean(): void {
	// OPENROUTER_BASE_URL is the one non-MNEMOPI_ variable that can route its embeddings to an API.
	const set = Object.keys(Bun.env).filter(key => {
		const name = envName(key);
		return (name.startsWith("MNEMOPI_") || name === "OPENROUTER_BASE_URL") && Bun.env[key];
	});
	if (set.length > 0) {
		throw new Error(`refusing to run mnemopi with MNEMOPI_* or OPENROUTER_BASE_URL set: ${set.join(", ")}`);
	}
}

function tierOf(label: string | undefined, summaryOf: string | undefined): RecallHit["tier"] {
	const tier = label ?? (summaryOf ? "episodic" : "working");
	if (tier !== "working" && tier !== "episodic" && tier !== "fact") {
		throw new Error(`unexpected mnemopi recall tier "${tier}"`);
	}
	return tier;
}

/** The files fastembed loads from a model directory; anything else there is a cache byproduct, not the model. */
const LOADED_JSON = new Set(["config.json", "special_tokens_map.json", "tokenizer.json", "tokenizer_config.json"]);
const isLoaded = (name: string) => LOADED_JSON.has(name) || name.endsWith(".onnx") || name.endsWith(".onnx_data");

/**
 * Digest of the model files in `modelDir`, so two runs with different model or tokenizer bytes cannot share a config.
 * Must match `model_dir_digest` in py/model_digest.py: SHA-256 over `<name>\0<sha256 of bytes>\n` for every loaded
 * file (`*.onnx`, `*.onnx_data`, the tokenizer/config JSON; symlinks followed), in sorted name order. A quarantined
 * `*.onnx.corrupt-<time>` download left by Mnemopi's healer, or a lock file, does not count.
 */
export async function modelDirDigest(modelDir: string): Promise<string> {
	const outer = new Bun.CryptoHasher("sha256");
	for (const name of (await fs.readdir(modelDir)).filter(isLoaded).sort()) {
		const file = path.join(modelDir, name);
		if (!(await fs.stat(file)).isFile()) continue;
		const inner = new Bun.CryptoHasher("sha256").update(await Bun.file(file).bytes()).digest("hex");
		outer.update(`${name}\0${inner}\n`);
	}
	return outer.digest("hex");
}

export function mnemopiEngine(options: MnemopiEngineOptions = {}): EngineAdapter {
	const cacheRoot = resolveCacheRoot(options.cacheRoot);
	const embedder = options.embedder ?? "js";
	const recallMode = options.recall ?? "recall";
	const polyphonic = options.polyphonic ?? false;
	let beam: BeamMemory | undefined;
	let embedProc: PythonProcess | undefined;

	const startEmbedder = (): PythonProcess => {
		embedProc ??= new PythonProcess(
			"embedding server",
			options.embedPython ?? enginePython(cacheRoot),
			options.embedScript ?? EMBED_SCRIPT,
			{
				...Bun.env,
				MEMORY_EVAL_EMBED_MODEL: EMBEDDING_MODEL,
				MEMORY_EVAL_EMBED_CACHE_DIR: path.join(cacheRoot, "fastembed"),
			},
		);
		return embedProc;
	};
	const provider: MnemopiEmbeddingProvider = {
		async *embed(texts) {
			yield (await startEmbedder().call("embed", { texts })) as number[][];
		},
	};
	const runtimeOptions = (protocol: ProtocolName): ResolvedMnemopiRuntimeOptions => ({
		embeddings: {
			model: EMBEDDING_MODEL,
			disabled: protocol === "fts-only",
			...(embedder === "python" ? { provider } : {}),
		},
	});
	let opts = runtimeOptions("standard");

	const open = (): BeamMemory => {
		if (!beam) throw new Error("mnemopi engine is not open");
		return beam;
	};
	// The scope is an AsyncLocalStorage: it must wrap the whole async operation, flushExtractions included.
	// Mnemopi swallows provider errors (the row just gets no vector), so a dead embedding server is surfaced here.
	const scoped = async <T>(fn: () => Promise<T>): Promise<T> => {
		const result = await withMnemopiRuntimeOptions(opts, fn);
		if (embedProc?.failure) throw embedProc.failure;
		return result;
	};
	let warmDigest: string | undefined;
	const currentModelDigest = async (): Promise<string> =>
		embedder === "python"
			? ((await startEmbedder().call("model_digest")) as string)
			: modelDirDigest(path.join(getFastembedCacheDir(), JS_MODEL_DIR));

	return {
		name: "mnemopi",
		describe: async () => {
			const pkg: { version: string } = await Bun.file(PACKAGE_JSON).json();
			// The Python embedder's numerical runtime decides near-tie order, so it is part of the configuration;
			// fts-only never starts the embedder, and asking it for versions must not either.
			const embedding = opts.embeddings?.disabled !== true;
			const runtime =
				embedder === "python" && embedding
					? Object.fromEntries(
							Object.entries((await startEmbedder().call("versions")) as Record<string, string>).map(
								([name, version]) => [`${name}_version`, version],
							),
						)
					: {};
			// The model files actually loaded: the name maps to an unversioned download. Warmup loaded them, so the
			// digest taken there is the one that produced the vectors; a different one now means they were replaced.
			const modelDigest: Record<string, string> = {};
			if (embedding) {
				const now = await currentModelDigest();
				if (warmDigest !== undefined && now !== warmDigest) {
					throw new Error(
						`embedding model files changed during the run (${warmDigest} → ${now}); result not written`,
					);
				}
				modelDigest.embedding_model_sha256 = now;
			}
			return {
				package_version: pkg.version,
				embedding_model: EMBEDDING_MODEL,
				embedder,
				embeddings_disabled: String(!embedding),
				git_commit: (await vcs.requireGit(REPO_ROOT).headSha()) ?? "unknown",
				...runtime,
				...modelDigest,
			};
		},
		open: async (_evalCase, { storeDir, protocol }) => {
			opts = runtimeOptions(protocol);
			beam = await scoped(async () => {
				const config = {
					// No eviction (production keeps the newest 1000 rows): both engines must hold the whole conversation.
					workingMemoryLimit: 0,
					polyphonicRecall: polyphonic,
					...(protocol === "with-sleep" ? { workingMemoryTtlHours: 0 } : {}),
				};
				return new BeamMemory({ dbPath: path.join(storeDir, "mnemopi.db"), sessionId: "eval", config });
			});
		},
		remember: items =>
			scoped(async () => {
				const b = open();
				const ids = items.map(item =>
					b.remember(item.content, { source: item.source, importance: item.importance }),
				);
				await b.flushExtractions();
				return ids;
			}),
		vectorCount: () =>
			scoped(async () => {
				const b = open();
				await b.flushExtractions();
				return b.db.query<{ n: number }, []>("SELECT COUNT(*) AS n FROM memory_embeddings").get()?.n ?? 0;
			}),
		sleep: () =>
			scoped(async () => {
				const b = open();
				await b.flushExtractions();
				b.sleep(false);
				await b.flushExtractions();
			}),
		unembeddedSummaries: () =>
			scoped(async () => {
				const b = open();
				await b.flushExtractions();
				return (
					b.db
						.query<{ n: number }, []>(
							"SELECT COUNT(*) AS n FROM episodic_memory e WHERE NOT EXISTS (SELECT 1 FROM memory_embeddings m WHERE m.memory_id = e.id)",
						)
						.get()?.n ?? 0
				);
			}),
		recall: (question, k) =>
			scoped(async () => {
				const b = open();
				await b.flushExtractions();
				// `enhanced` is the call omp's auto-recall makes (packages/coding-agent/src/mnemopi/state.ts).
				const rows =
					recallMode === "enhanced"
						? await b.recallEnhanced(question.text, k, { includeFacts: true })
						: await b.recall(question.text, k);
				return rows.map(row => ({
					engineId: row.id,
					tier: tierOf(row.tier_label, row.summary_of),
					content: row.content,
					summaryOf: row.summary_of?.split(",").filter(Boolean) ?? [],
				}));
			}),
		close: async () => {
			beam?.close();
			beam = undefined;
		},
		dispose: async () => {
			beam?.close();
			beam = undefined;
			await embedProc?.shutdown();
			embedProc = undefined;
		},
		warmup: async protocol => {
			opts = runtimeOptions(protocol);
			if (protocol === "fts-only") return;
			if (embedder === "python") startEmbedder();
			await scoped(() => embed(["warmup"]));
			warmDigest = await currentModelDigest();
		},
	};
}
