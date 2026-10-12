/** Mnemosyne adapter: upstream Mnemosyne 4.0.0b4 in a Python child process, driven over JSON lines. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import type { DroppedRow, EngineAdapter, ProtocolName, RecallHit } from "../engine";
import { PythonProcess } from "./python-process";

const EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5";
const CACHE_ROOT = path.join(os.homedir(), ".cache", "omp-memory-eval");
const DEFAULT_PYTHON = path.join(CACHE_ROOT, "venv-engine", "bin", "python");
const DEFAULT_SCRIPT = path.resolve(import.meta.dir, "../py/mnemosyne_engine.py");
const REPO_ROOT = path.resolve(import.meta.dir, "../../../../..");

export interface MnemosyneEngineOptions {
	python?: string;
	script?: string;
}

/** Task 7's upstream-compat protocol drives the engine through these beyond `EngineAdapter`. */
export type UpstreamCompatOps = {
	oldestWorking(limit: number): Promise<{ engineId: string; content: string }[]>;
	consolidate(
		summary: string,
		ids: string[],
		source: string,
		importance: number,
		scope: string,
	): Promise<string | null>;
	recallRaw(query: string, k: number): Promise<string[]>;
};

interface WireHit {
	engine_id: string;
	tier: RecallHit["tier"];
	content: string;
	summary_of: string[];
}

interface WireDropped {
	tier: string;
	engine_id: string;
	source_memory_id: string | null;
	rank: number;
}

export function mnemosyneEngine(options: MnemosyneEngineOptions = {}): EngineAdapter & UpstreamCompatOps {
	const python = options.python ?? DEFAULT_PYTHON;
	const script = options.script ?? DEFAULT_SCRIPT;
	let proc: PythonProcess | undefined;
	let served: ProtocolName | undefined;
	let dataDir: string | undefined;
	let isOpen = false;
	let lastDropped: DroppedRow[] = [];

	// Embedding settings are read when Python imports Mnemosyne, so the first protocol fixes the process.
	const start = async (protocol: ProtocolName): Promise<PythonProcess> => {
		if (proc) {
			if (protocol !== served) throw new Error(`mnemosyne engine process serves "${served}", not "${protocol}"`);
			return proc;
		}
		dataDir = await fs.mkdtemp(path.join(os.tmpdir(), "mnemosyne-data-"));
		// Parent MNEMOSYNE_* settings (recall weights, prefixes, ...) would silently change ranking or embeddings.
		const inherited = Object.entries(Bun.env).filter(([key]) => !key.startsWith("MNEMOSYNE_"));
		proc = new PythonProcess("mnemosyne engine", python, script, {
			...Object.fromEntries(inherited),
			MNEMOSYNE_DATA_DIR: dataDir,
			MNEMOSYNE_FASTEMBED_CACHE_DIR: path.join(CACHE_ROOT, "fastembed"),
			MNEMOSYNE_EMBEDDING_MODEL: EMBEDDING_MODEL,
			MNEMOSYNE_LLM_ENABLED: "false",
			...(protocol === "fts-only" ? { MNEMOSYNE_NO_EMBEDDINGS: "1" } : {}),
		});
		served = protocol;
		return proc;
	};
	const live = (): PythonProcess => {
		if (!proc) throw new Error("mnemosyne engine is not started");
		return proc;
	};

	return {
		name: "mnemosyne",
		rssScope: "engine-process",
		describe: async () => ({
			...((await live().call("describe")) as Record<string, string>),
			// A fresh temp dir per run: its path would make otherwise identical configs differ.
			MNEMOSYNE_DATA_DIR: "<temp>",
			git_commit: (await vcs.requireGit(REPO_ROOT).headSha()) ?? "unknown",
		}),
		open: async (_evalCase, { storeDir, protocol }) => {
			await (await start(protocol)).call("open", { storePath: path.join(storeDir, "mnemosyne.db") });
			isOpen = true;
		},
		remember: async items => {
			const wireItems = items.map(({ content, source, importance }) => ({ content, source, importance }));
			return (await live().call("remember", { items: wireItems })) as (string | null)[];
		},
		vectorCount: async () => (await live().call("vector_count")) as number,
		sleep: async () => {
			await live().call("sleep");
		},
		recall: async (question, k) => {
			const { hits, dropped } = (await live().call("recall", { query: question.text, k })) as {
				hits: WireHit[];
				dropped: WireDropped[];
			};
			lastDropped = dropped.map(row => ({
				tier: row.tier,
				engineId: row.engine_id,
				sourceMemoryId: row.source_memory_id,
				rank: row.rank,
			}));
			return hits.map(hit => ({
				engineId: hit.engine_id,
				tier: hit.tier,
				content: hit.content,
				summaryOf: hit.summary_of,
			}));
		},
		lastDropped: () => lastDropped,
		close: async () => {
			if (!isOpen) return;
			await live().call("close");
			isOpen = false;
		},
		dispose: async () => {
			const current = proc;
			proc = undefined;
			served = undefined;
			if (current) {
				// A failed run already carries its own error; a close failure must not mask it.
				if (isOpen) await current.call("close").catch(() => undefined);
				await current.shutdown();
			}
			isOpen = false;
			if (dataDir) await fs.rm(dataDir, { recursive: true, force: true });
			dataDir = undefined;
		},
		// The spawn is part of warmup: its time covers interpreter start, imports and model load.
		warmup: async protocol => {
			await (await start(protocol)).call("warmup");
		},
		resources: async () => {
			const rss = (await live().call("resources")) as { peak_rss_bytes: number; baseline_rss_bytes: number };
			return { peakRssBytes: rss.peak_rss_bytes, baselineRssBytes: rss.baseline_rss_bytes };
		},
		oldestWorking: async limit => {
			const rows = (await live().call("oldest_working", { limit })) as { engine_id: string; content: string }[];
			return rows.map(row => ({ engineId: row.engine_id, content: row.content }));
		},
		consolidate: async (summary, ids, source, importance, scope) =>
			(await live().call("consolidate", { summary, ids, source, importance, scope })) as string | null,
		recallRaw: async (query, k) => (await live().call("recall_raw", { query, k })) as string[],
	};
}
