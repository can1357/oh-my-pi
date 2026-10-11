/** Mnemopi adapter: runs `BeamMemory` in the harness process with the same embedding model as upstream Mnemosyne. */
import * as path from "node:path";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import { embed } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import {
	type ResolvedMnemopiRuntimeOptions,
	withMnemopiRuntimeOptions,
} from "@oh-my-pi/pi-mnemopi/core/runtime-options";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { EngineAdapter, ProtocolName, RecallHit } from "../engine";

const EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5";
const REPO_ROOT = path.resolve(import.meta.dir, "../../../../..");
const PACKAGE_JSON = path.join(REPO_ROOT, "packages", "mnemopi", "package.json");

function runtimeOptions(protocol: ProtocolName): ResolvedMnemopiRuntimeOptions {
	return { embeddings: { model: EMBEDDING_MODEL, disabled: protocol === "fts-only" } };
}

function tierOf(label: string | undefined, summaryOf: string | undefined): RecallHit["tier"] {
	const tier = label ?? (summaryOf ? "episodic" : "working");
	if (tier !== "working" && tier !== "episodic") throw new Error(`unexpected mnemopi recall tier "${tier}"`);
	return tier;
}

export function mnemopiEngine(): EngineAdapter {
	let beam: BeamMemory | undefined;
	let opts: ResolvedMnemopiRuntimeOptions = runtimeOptions("standard");
	let baselineRssBytes = process.memoryUsage().rss;

	const open = (): BeamMemory => {
		if (!beam) throw new Error("mnemopi engine is not open");
		return beam;
	};
	// The scope is an AsyncLocalStorage: it must wrap the whole async operation, flushExtractions included.
	const scoped = <T>(fn: () => Promise<T>): Promise<T> => withMnemopiRuntimeOptions(opts, fn);

	return {
		name: "mnemopi",
		rssScope: "harness-process",
		describe: async () => {
			const pkg: { version: string } = await Bun.file(PACKAGE_JSON).json();
			return {
				package_version: pkg.version,
				embedding_model: EMBEDDING_MODEL,
				embeddings_disabled: String(opts.embeddings?.disabled === true),
				...Object.fromEntries(
					Object.entries(Bun.env).filter(([key, value]) => key.startsWith("MNEMOPI_") && value),
				),
				git_commit: (await vcs.requireGit(REPO_ROOT).headSha()) ?? "unknown",
			};
		},
		open: async (_evalCase, { storeDir, protocol }) => {
			opts = runtimeOptions(protocol);
			beam = await scoped(async () => {
				const config =
					protocol === "with-sleep"
						? { workingMemoryLimit: 0, workingMemoryTtlHours: 0 }
						: { workingMemoryLimit: 0 };
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
		recall: (question, k) =>
			scoped(async () => {
				const b = open();
				await b.flushExtractions();
				const rows = await b.recall(question.text, k);
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
		},
		warmup: async protocol => {
			baselineRssBytes = process.memoryUsage().rss;
			opts = runtimeOptions(protocol);
			if (protocol === "fts-only") return;
			await scoped(() => embed(["warmup"]));
		},
		resources: async () => ({
			// `maxRSS` is in kilobytes on Linux.
			peakRssBytes: process.resourceUsage().maxRSS * 1024,
			baselineRssBytes,
		}),
	};
}
