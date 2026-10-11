/** Mnemosyne adapter: upstream Mnemosyne 4.0.0b4 in a Python child process, driven over JSON lines. */
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { readLines } from "@oh-my-pi/pi-utils";
import type { DroppedRow, EngineAdapter, ProtocolName, RecallHit } from "../engine";

const EMBEDDING_MODEL = "BAAI/bge-small-en-v1.5";
const CACHE_ROOT = path.join(os.homedir(), ".cache", "omp-memory-eval");
const DEFAULT_PYTHON = path.join(CACHE_ROOT, "venv-engine", "bin", "python");
const DEFAULT_SCRIPT = path.resolve(import.meta.dir, "../py/mnemosyne_engine.py");
const REPO_ROOT = path.resolve(import.meta.dir, "../../../../..");
const STDERR_TAIL_CHARS = 4000;
const EXIT_GRACE_MS = 5000;

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

interface WireResponse {
	id: number;
	result?: unknown;
	error?: string;
}

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

/** One Python process. The first failure (error response, bad output, exit, EOF) rejects the pending call and every later call. */
class PythonProcess {
	readonly #proc: Bun.Subprocess<"pipe", "pipe", "pipe">;
	readonly #pending = new Map<number, PromiseWithResolvers<unknown>>();
	readonly #done: Promise<void>;
	#nextId = 1;
	#failure: Error | undefined;
	#stderrTail = "";

	constructor(python: string, script: string, env: Record<string, string | undefined>) {
		this.#proc = Bun.spawn([python, script], { stdin: "pipe", stdout: "pipe", stderr: "pipe", env });
		this.#done = this.#pump(this.#collectStderr());
	}

	async call(op: string, params: object = {}): Promise<unknown> {
		if (this.#failure) throw this.#failure;
		const id = this.#nextId++;
		const waiter = Promise.withResolvers<unknown>();
		this.#pending.set(id, waiter);
		try {
			this.#proc.stdin.write(`${JSON.stringify({ id, op, params })}\n`);
			await this.#proc.stdin.flush();
		} catch (err) {
			// A broken pipe means the process is gone: wait for the pump to attach its exit code and stderr.
			await this.#done;
			this.#fail(err instanceof Error ? err : new Error(String(err)));
		}
		return waiter.promise;
	}

	/** Ends stdin so the script exits, killing it if it does not within the grace period. */
	async shutdown(): Promise<void> {
		const killer = setTimeout(() => this.#proc.kill(), EXIT_GRACE_MS);
		try {
			await this.#proc.stdin.end();
		} catch {
			// The process already exited.
		}
		try {
			await this.#done;
		} finally {
			clearTimeout(killer);
		}
	}

	#fail(error: Error): void {
		this.#failure ??= error;
		for (const waiter of this.#pending.values()) waiter.reject(this.#failure);
		this.#pending.clear();
	}

	#settle(response: WireResponse): void {
		if (response.error !== undefined) return this.#fail(new Error(response.error));
		const waiter = this.#pending.get(response.id);
		if (!waiter) return this.#fail(new Error(`mnemosyne engine answered unknown request ${response.id}`));
		this.#pending.delete(response.id);
		waiter.resolve(response.result);
	}

	async #collectStderr(): Promise<void> {
		const decoder = new TextDecoder();
		for await (const chunk of this.#proc.stderr) {
			this.#stderrTail = (this.#stderrTail + decoder.decode(chunk, { stream: true })).slice(-STDERR_TAIL_CHARS);
		}
	}

	async #pump(stderrDone: Promise<void>): Promise<void> {
		const decoder = new TextDecoder();
		try {
			for await (const bytes of readLines(this.#proc.stdout)) {
				const line = decoder.decode(bytes);
				if (line.trim() === "") continue;
				let response: WireResponse;
				try {
					response = JSON.parse(line);
				} catch {
					this.#fail(new Error(`mnemosyne engine wrote a non-protocol line: ${line.slice(0, 200)}`));
					continue;
				}
				this.#settle(response);
			}
			await stderrDone;
			const code = await this.#proc.exited;
			this.#fail(new Error(`mnemosyne engine exited with code ${code}: ${this.#stderrTail.trim()}`));
		} catch (err) {
			this.#fail(err instanceof Error ? err : new Error(String(err)));
		}
	}
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
		proc = new PythonProcess(python, script, {
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
