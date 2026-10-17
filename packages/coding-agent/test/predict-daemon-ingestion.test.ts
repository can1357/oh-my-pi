import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { TextPredictor } from "@oh-my-pi/pi-natives";
import { pathToFileURL } from "node:url";
import { Engine, readCursor } from "../src/predict/daemon";

function createHistory(dbPath: string, count: number, finalPrompt = `prompt ${count}`): void {
	const db = new Database(dbPath);
	try {
		db.run("CREATE TABLE history (id INTEGER PRIMARY KEY, prompt)");
		using insert = db.prepare("INSERT INTO history (id, prompt) VALUES (?, ?)");
		for (let id = 1; id <= count; id++) insert.run(id, id === count ? finalPrompt : `prompt ${id}`);
	} finally {
		db.close();
	}
}

function engine(observe: (prompts: string[]) => Promise<void>): Engine {
	const predictor = { observe, persist: async () => {} } as unknown as TextPredictor;
	return new Engine("ngram", "", predictor, { historyId: "0" });
}

describe("text-predict history ingestion", () => {
	it("releases each history lease before observe and reopens to see a replacement database", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-predict-ingest-"));
		const dbPath = path.join(dir, "history.db");
		const replacementPath = path.join(dir, "replacement.db");
		createHistory(dbPath, 1_001, "old final prompt");
		expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
		expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
		const { promise: observePending, resolve: releaseObserve } = Promise.withResolvers<void>();
		const { promise: firstBatchSeen, resolve: firstBatch } = Promise.withResolvers<string[]>();
		let batches = 0;
		const instance = engine(async prompts => {
			batches++;
			if (batches === 1) {
				firstBatch(prompts);
				await observePending;
			}
		});

		let ingestion: Promise<number> | undefined;
		let child: Bun.Subprocess | undefined;
		try {
			ingestion = instance.ingest(dbPath);
			const observed = await firstBatchSeen;
			expect(observed).toHaveLength(1_000);
			expect(instance.cursor).toBe("0");
			createHistory(replacementPath, 1, "fresh low-id prompt");
			const sqliteModule = pathToFileURL(path.resolve(import.meta.dir, "../../utils/src/sqlite.ts")).href;
			const script = `import * as fs from "node:fs";
import { withSqliteStoreLease } from ${JSON.stringify(sqliteModule)};
withSqliteStoreLease(${JSON.stringify(dbPath)}, () => {
	fs.rmSync(${JSON.stringify(dbPath)});
	fs.renameSync(${JSON.stringify(replacementPath)}, ${JSON.stringify(dbPath)});
});`;
			child = Bun.spawn([process.execPath, "--eval", script], { stdout: "ignore", stderr: "pipe" });
			expect(await child.exited).toBe(0);
			expect(fs.existsSync(`${dbPath}-wal`)).toBe(false);
			expect(fs.existsSync(`${dbPath}-shm`)).toBe(false);
			releaseObserve();
			expect(await ingestion).toBe(1_001);
			expect(instance.cursor).toBe("1");
			expect(batches).toBe(2);
		} finally {
			releaseObserve();
			child?.kill();
			if (child) await child.exited;
			await ingestion?.catch(() => {});
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("does not advance the cursor when observe rejects, so retry receives the same prompts", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-predict-ingest-"));
		const dbPath = path.join(dir, "history.db");
		createHistory(dbPath, 1, "retry me");
		const seen: string[][] = [];
		let reject = true;
		const instance = engine(async prompts => {
			seen.push(prompts);
			if (reject) {
				reject = false;
				throw new Error("observe failed");
			}
		});
		try {
			await expect(instance.ingest(dbPath)).rejects.toThrow("observe failed");
			expect(instance.cursor).toBe("0");
			expect(await instance.ingest(dbPath)).toBe(1);
			expect(instance.cursor).toBe("1");
			expect(seen).toEqual([["retry me"], ["retry me"]]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("learns new low-id prompts after recovery even when the old allocation sequence was lost", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-predict-reset-"));
		const dbPath = path.join(dir, "history.db");
		const replacementPath = path.join(dir, "replacement.db");
		createHistory(dbPath, 1_001);
		const seen: string[] = [];
		const instance = engine(async prompts => {
			seen.push(...prompts);
		});
		try {
			expect(await instance.ingest(dbPath)).toBe(seen.length);
			createHistory(replacementPath, 1, "fresh replacement prompt");
			fs.renameSync(replacementPath, dbPath);
			expect(await instance.ingest(dbPath)).toBe(1);
			expect(seen.at(-1)).toBe("fresh replacement prompt");
			expect(instance.cursor).toBe("1");
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("persists the store identity with the cursor so restart skips learned rows but not a replacement", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-predict-persist-"));
		const dbPath = path.join(dir, "history.db");
		const replacementPath = path.join(dir, "replacement.db");
		createHistory(dbPath, 1, "already learned");
		const seen: string[] = [];
		const predictor = {
			observe: async (prompts: string[]) => {
				seen.push(...prompts);
			},
			persist: async () => {},
		} as unknown as TextPredictor;
		try {
			const first = new Engine("ngram", dir, predictor, { historyId: "0" });
			await first.ingest(dbPath);
			await first.persist();
			const checkpoint = await readCursor(dir);
			const restarted = new Engine("ngram", dir, predictor, checkpoint);
			expect(await restarted.ingest(dbPath)).toBe(0);
			createHistory(replacementPath, 1, "replacement prompt");
			fs.renameSync(replacementPath, dbPath);
			expect(await restarted.ingest(dbPath)).toBe(1);
			expect(seen).toEqual(["already learned", "replacement prompt"]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("keeps ids above JavaScript's safe range exact across persist and restart", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-predict-wide-cursor-"));
		const dbPath = path.join(dir, "history.db");
		const db = new Database(dbPath);
		try {
			db.run("CREATE TABLE history (id INTEGER PRIMARY KEY, prompt)");
			db.run("INSERT INTO history VALUES (9007199254740993, 'wide cursor prompt')");
		} finally {
			db.close();
		}
		const seen: string[] = [];
		const predictor = {
			observe: async (prompts: string[]) => {
				seen.push(...prompts);
			},
			persist: async () => {},
		} as unknown as TextPredictor;
		try {
			const first = new Engine("ngram", dir, predictor, { historyId: "0" });
			await first.ingest(dbPath);
			expect(first.cursor).toBe("9007199254740993");
			await first.persist();
			expect((await Bun.file(path.join(dir, "cursor.json")).json()).historyId).toBe("9007199254740993");
			const restarted = new Engine("ngram", dir, predictor, await readCursor(dir));
			expect(await restarted.ingest(dbPath)).toBe(0);
			const writer = new Database(dbPath);
			try {
				writer.run("INSERT INTO history VALUES (9007199254740994, 'next wide prompt')");
			} finally {
				writer.close();
			}
			expect(await restarted.ingest(dbPath)).toBe(1);
			expect(restarted.cursor).toBe("9007199254740994");
			expect(seen).toEqual(["wide cursor prompt", "next wide prompt"]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("restarts learning from an oversized checkpoint but preserves SQLite's maximum cursor", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-predict-invalid-cursor-"));
		const dbPath = path.join(dir, "history.db");
		createHistory(dbPath, 1, "learn after invalid checkpoint");
		const seen: string[] = [];
		const predictor = {
			observe: async (prompts: string[]) => {
				seen.push(...prompts);
			},
			persist: async () => {},
		} as unknown as TextPredictor;
		try {
			const first = new Engine("ngram", dir, predictor, { historyId: "0" });
			await first.ingest(dbPath);
			await first.persist();
			const checkpoint = await readCursor(dir);
			await Bun.write(
				path.join(dir, "cursor.json"),
				JSON.stringify({ ...checkpoint, historyId: "9223372036854775808" }),
			);
			seen.length = 0;
			const restarted = new Engine("ngram", dir, predictor, await readCursor(dir));
			expect(await restarted.ingest(dbPath)).toBe(1);
			const writer = new Database(dbPath);
			try {
				writer.run("INSERT INTO history VALUES (9223372036854775807, 'maximum prompt')");
			} finally {
				writer.close();
			}
			expect(await restarted.ingest(dbPath)).toBe(1);
			await restarted.persist();
			const atMaximum = new Engine("ngram", dir, predictor, await readCursor(dir));
			expect(await atMaximum.ingest(dbPath)).toBe(0);
			expect(seen).toEqual(["learn after invalid checkpoint", "maximum prompt"]);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});

	it("skips non-text prompts and does not create a missing history database", async () => {
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), "omp-predict-ingest-"));
		const dbPath = path.join(dir, "history.db");
		const db = new Database(dbPath);
		try {
			db.run("CREATE TABLE history (id INTEGER PRIMARY KEY, prompt)");
			db.run("INSERT INTO history VALUES (1, 'valid'), (2, X'0102'), (3, NULL)");
		} finally {
			db.close();
		}
		const seen: string[][] = [];
		const instance = engine(async prompts => {
			seen.push(prompts);
		});
		try {
			expect(await instance.ingest(dbPath)).toBe(1);
			expect(seen).toEqual([["valid"]]);
			const missingPath = path.join(dir, "missing.db");
			expect(await instance.ingest(missingPath)).toBe(0);
			expect(fs.existsSync(missingPath)).toBe(false);
		} finally {
			fs.rmSync(dir, { recursive: true, force: true });
		}
	});
});
