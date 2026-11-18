/**
 * The daemon `predict` module with the real `ngram` `TextPredictor`, driven
 * through the module's `open`/`call`/`flush`/`stop` contract in a temp agent dir.
 *
 * The ngram engine ignores `feedback` by design (`crates/predict/src/ngram/mod.rs`:
 * accepted words are learned when the prompt is submitted), so learning is
 * observed through `history.db` ingestion.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { Database } from "bun:sqlite";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModuleClient, ModuleContext, ModuleUnit } from "../../src/daemon/module";
import { predictModule } from "../../src/daemon/modules/predict";
import { GLOBAL_SCOPE, type UnitSnapshot } from "../../src/daemon/protocol";
import * as foreignHistory from "../../src/predict/foreign-history";
import {
	type TextPredictCallMethod,
	type TextPredictCalls,
	type TextPredictOpenParams,
	textPredictKey,
} from "../../src/predict/protocol";

const CLIENT: ModuleClient = { connectionId: "predict-test", pid: process.pid, build: "test" };
// The predict module uses no core services.
const CONTEXT = {} as ModuleContext;

/** Prompts teaching the non-dictionary word `zqorbit` (graduates after a few typed uses). */
const ZQORBIT_PROMPTS = [
	"please check the zqorbit value",
	"now check the zqorbit value again",
	"can you check the zqorbit value once more",
	"check the zqorbit value before the release",
];
const BEFORE = "please check the ";
const PREFIX = "zq";

function paramsFor(agentDir: string): TextPredictOpenParams {
	return {
		agentDir,
		historyDbPath: path.join(agentDir, "history.db"),
		modelDir: path.join(agentDir, "models", "smollm"),
		stateDirs: {
			ngram: path.join(agentDir, "predict", "ngram"),
			smollm: path.join(agentDir, "predict", "smollm"),
			apple: path.join(agentDir, "predict", "apple"),
		},
	};
}

function appendHistory(agentDir: string, prompts: string[]): void {
	const db = new Database(path.join(agentDir, "history.db"));
	try {
		db.run(
			"CREATE TABLE IF NOT EXISTS history (id INTEGER PRIMARY KEY AUTOINCREMENT, prompt TEXT NOT NULL UNIQUE, created_at INTEGER NOT NULL DEFAULT 0)",
		);
		const insert = db.query("INSERT INTO history (prompt) VALUES (?)");
		for (const prompt of prompts) insert.run(prompt);
	} finally {
		db.close();
	}
}

describe("daemon predict module", () => {
	let root: string;
	const open: ModuleUnit[] = [];

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-predict-module-"));
		// Empty-state engines would otherwise learn this machine's Claude Code / Codex prompts.
		vi.spyOn(foreignHistory, "readForeignPrompts").mockResolvedValue([]);
	});

	afterEach(async () => {
		for (const unit of open.splice(0)) await unit.stop("test done");
		vi.restoreAllMocks();
		await fs.rm(root, { recursive: true, force: true });
	});

	async function agentDir(name: string): Promise<string> {
		const dir = path.join(root, name);
		await fs.mkdir(dir, { recursive: true });
		return dir;
	}

	async function openUnit(dir: string): Promise<ModuleUnit> {
		const unit = await predictModule.open(CONTEXT, {
			unitId: `predict-${open.length}`,
			scope: GLOBAL_SCOPE,
			key: textPredictKey(dir),
			params: paramsFor(dir),
			client: CLIENT,
		});
		open.push(unit);
		return unit;
	}

	function call<M extends TextPredictCallMethod>(
		unit: ModuleUnit,
		method: M,
		params: TextPredictCalls[M]["params"],
	): Promise<TextPredictCalls[M]["result"]> {
		const snapshot = { id: "predict-unit" } as UnitSnapshot;
		return predictModule.call!(CONTEXT, method, params, CLIENT, { snapshot, unit }) as Promise<
			TextPredictCalls[M]["result"]
		>;
	}

	async function suggestion(unit: ModuleUnit): Promise<string | undefined> {
		const word = await call(unit, "complete", { method: "ngram", before: BEFORE, prefix: PREFIX });
		return word?.suffix;
	}

	it("learns history rows added after open once `sync` runs, within the same unit", async () => {
		const dir = await agentDir("learn");
		appendHistory(dir, ["start the build"]);
		const unit = await openUnit(dir);
		expect(await suggestion(unit)).not.toBe("orbit");

		appendHistory(dir, ZQORBIT_PROMPTS);
		expect(await call(unit, "sync", {})).toEqual({ ingested: ZQORBIT_PROMPTS.length });
		expect(await suggestion(unit)).toBe("orbit");
	});

	it("`sync` ingests only rows past the cursor (re-feeding history would skew counts)", async () => {
		const dir = await agentDir("cursor");
		appendHistory(dir, ZQORBIT_PROMPTS);
		const unit = await openUnit(dir);
		// The first call opens the engine, which ingests the existing rows.
		await suggestion(unit);
		expect(await call(unit, "sync", {})).toEqual({ ingested: 0 });

		appendHistory(dir, ["deploy the service", "rotate the keys"]);
		expect(await call(unit, "sync", {})).toEqual({ ingested: 2 });
		expect(await call(unit, "sync", {})).toEqual({ ingested: 0 });
	});

	it("keeps two agent dirs isolated: one dir's history never leaks into the other's suggestions", async () => {
		const taught = await agentDir("taught");
		const fresh = await agentDir("fresh");
		appendHistory(taught, ZQORBIT_PROMPTS);
		appendHistory(fresh, ["start the build"]);
		const taughtUnit = await openUnit(taught);
		const freshUnit = await openUnit(fresh);

		expect(await suggestion(taughtUnit)).toBe("orbit");
		expect(await suggestion(freshUnit)).not.toBe("orbit");
		expect(textPredictKey(taught)).not.toBe(textPredictKey(fresh));
	});

	it.each(["flush", "stop"] as const)(
		"`%s` persists learned state: a reopened unit completes the same without re-ingesting",
		async how => {
			const dir = await agentDir(`persist-${how}`);
			appendHistory(dir, ZQORBIT_PROMPTS);
			const first = await openUnit(dir);
			const before = await call(first, "complete", {
				method: "ngram",
				before: BEFORE,
				prefix: PREFIX,
			});
			expect(before?.suffix).toBe("orbit");
			if (how === "flush") await first.flush!();
			else {
				await first.stop("idle");
				open.splice(open.indexOf(first), 1);
			}
			// Without history the only source of `zqorbit` is the persisted state.
			await fs.rm(path.join(dir, "history.db"));

			const reopened = await openUnit(dir);
			const after = await call(reopened, "complete", {
				method: "ngram",
				before: BEFORE,
				prefix: PREFIX,
			});
			expect(after).toEqual(before);
			expect(await call(reopened, "sync", {})).toEqual({ ingested: 0 });
		},
	);
});
