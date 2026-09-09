import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdRemember, cmdStats, memoryStats, runCli } from "@oh-my-pi/pi-mnemopi/cli";
import { BeamMemory } from "@oh-my-pi/pi-mnemopi/core/beam";
import { runDiagnostics } from "@oh-my-pi/pi-mnemopi/diagnose";

let root: string;

beforeEach(() => {
	root = mkdtempSync(join(tmpdir(), "mnemopi-ts-cli-stats-parity-"));
	process.env.MNEMOPI_DATA_DIR = root;
	process.env.MNEMOPI_NO_EMBEDDINGS = "1";
});

afterEach(() => {
	rmSync(root, { recursive: true, force: true });
	delete process.env.MNEMOPI_DATA_DIR;
	delete process.env.MNEMOPI_NO_EMBEDDINGS;
});

function capture() {
	let stdout = "";
	let stderr = "";
	return {
		context(dataDir = root) {
			return {
				dataDir,
				stdout: { write: (data: string) => (stdout += data) },
				stderr: { write: (data: string) => (stderr += data) },
			};
		},
		get stdout() {
			return stdout;
		},
		get stderr() {
			return stderr;
		},
	};
}

function seed(dbPath: string): BeamMemory {
	const memory = new BeamMemory({ sessionId: "stats-parity", dbPath });
	const id = memory.remember("Working memory item", { source: "user", importance: 0.5 });
	memory.consolidateToEpisodic("Episodic summary", [id], "consolidation", 0.6);
	memory.db.run("INSERT INTO triples (subject, predicate, object, source) VALUES (?, ?, ?, ?)", [
		"alice",
		"likes",
		"typescript",
		"test",
	]);
	return memory;
}

function lineValue(output: string, prefix: string): number {
	const line = output
		.split("\n")
		.map(candidate => candidate.trim())
		.find(candidate => candidate.startsWith(`${prefix}:`));
	expect(line).toBeDefined();
	const value = Number(line?.split(":", 2)[1]?.trim());
	expect(Number.isInteger(value)).toBe(true);
	return value;
}

describe("CLI stats parity", () => {
	it("prints real working, episodic, triple, bank, and database counts", async () => {
		const dbPath = join(root, "mnemopi.db");
		const memory = seed(dbPath);
		memory.close();

		const io = capture();
		expect(await cmdStats([], io.context())).toBe(0);
		expect(lineValue(io.stdout, "Working memory")).toBeGreaterThanOrEqual(1);
		expect(lineValue(io.stdout, "Episodic memory")).toBeGreaterThanOrEqual(1);
		expect(lineValue(io.stdout, "Knowledge triples")).toBeGreaterThanOrEqual(1);
		expect(io.stdout).toContain("Banks: default");
		expect(io.stdout).toContain(dbPath);
		expect(io.stdout).not.toContain("DB path: N/A");
		expect(io.stderr).toBe("");
	});

	it("prints zero triples on a fresh initialized DB", async () => {
		const dbPath = join(root, "mnemopi.db");
		const memory = new BeamMemory({ sessionId: "fresh-stats", dbPath });
		memory.close();
		const io = capture();
		expect(await cmdStats([], io.context())).toBe(0);
		expect(lineValue(io.stdout, "Knowledge triples")).toBe(0);
	});

	it("memoryStats exposes triples under beam and banks at top level", () => {
		const dbPath = join(root, "mnemopi.db");
		const memory = seed(dbPath);
		try {
			const stats = memoryStats(memory, root) as {
				beam: {
					triples: { total: number };
					working_memory: { total: number };
					episodic_memory: { total: number };
				};
				banks: string[];
				database: string;
			};
			expect(stats.beam.working_memory.total).toBeGreaterThanOrEqual(1);
			expect(stats.beam.episodic_memory.total).toBeGreaterThanOrEqual(1);
			expect(stats.beam.triples.total).toBeGreaterThanOrEqual(1);
			expect(stats.banks).toContain("default");
			expect(stats.database).toBe(dbPath);
		} finally {
			memory.close();
		}
	});

	it("stats commands read the configured data directory, not the default home path", async () => {
		const customDataDir = join(root, "custom-data");
		const io = capture();
		expect(await cmdRemember(["stats data dir probe"], io.context(customDataDir))).toBe(0);
		expect(existsSync(join(customDataDir, "mnemopi.db"))).toBe(true);

		const statsIo = capture();
		expect(await runCli(["stats"], statsIo.context(customDataDir))).toBe(0);
		expect(lineValue(statsIo.stdout, "Working memory")).toBe(1);
		expect(statsIo.stdout).toContain(join(customDataDir, "mnemopi.db"));
	});
});

describe("mnemopi-stats diagnostic behavior parity", () => {
	it("diagnostics return dashboard-ready structure with counts and health bounds", () => {
		const dbPath = join(root, "mnemopi.db");
		const memory = seed(dbPath);
		memory.close();

		const result = runDiagnostics({ dbPath, dataDir: root });
		expect(result.database).toBe(dbPath);
		expect(result.checks_total).toBeGreaterThan(0);
		expect(result.checks_passed).toBeGreaterThan(0);
		expect(result.checks_failed).toBeGreaterThanOrEqual(0);
		expect(result.checks_passed + result.checks_failed).toBeLessThanOrEqual(result.checks_total);
		expect(result.entries.some(entry => entry.check === "working_memory_count" && entry.status === "1")).toBe(true);
		expect(result.entries.some(entry => entry.check === "episodic_memory_count" && entry.status === "1")).toBe(true);
		expect(result.entries.some(entry => entry.check === "triples_count" && entry.status === "1")).toBe(true);
	});

	it("diagnostics initialize missing databases gracefully and report zero counts", () => {
		const dbPath = join(root, "empty", "mnemopi.db");
		mkdirSync(join(root, "empty"), { recursive: true });
		const result = runDiagnostics({ dbPath, dataDir: join(root, "empty") });
		expect(result.database).toBe(dbPath);
		expect(result.key_findings).toEqual([]);
		expect(result.entries.some(entry => entry.check === "working_memory_count" && entry.status === "0")).toBe(true);
		expect(result.entries.some(entry => entry.check === "triples_count" && entry.status === "0")).toBe(true);
	});
});
