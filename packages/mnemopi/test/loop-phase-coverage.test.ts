import { Database, type Statement } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import { Mnemopi } from "@oh-my-pi/pi-mnemopi/core/memory";
import { resetEmbeddingProviderForTests, setEmbeddingProviderForTests } from "@oh-my-pi/pi-mnemopi/core/embeddings";
import { currentLoopPhase, TempDir } from "@oh-my-pi/pi-utils";

let checking = false;
let monitoredExecutions = 0;
let violations: { method: string; sql: string; stack: string | undefined }[] = [];
const spies: { mockRestore(): void }[] = [];
let memory: Mnemopi | undefined;
let root: TempDir | undefined;
const featureEnv = ["MNEMOPI_POLYPHONIC_RECALL", "MNEMOPI_ENHANCED_RECALL", "MNEMOPI_PROACTIVE_LINKING"];
let savedEnv: (string | undefined)[] = [];

function record(method: string, sql: string): void {
	if (!checking) return;
	monitoredExecutions++;
	if (!currentLoopPhase()?.startsWith("mnemopi.")) {
		violations.push({ method, sql, stack: new Error().stack?.split("\n").slice(1, 7).join("\n") });
	}
}

function restoreSqlSpies(): void {
	for (const spy of spies.splice(0).reverse()) spy.mockRestore();
}

function spyOnSql(): void {
	const wrapped = new WeakSet<Statement>();
	const wrap = (statement: Statement): Statement => {
		if (wrapped.has(statement)) return statement;
		wrapped.add(statement);
		// Bun installs execution methods on each statement, and query() caches instances.
		for (const method of ["all", "get", "run", "values", "iterate", "raw"] as const) {
			const original = statement[method];
			spies.push(
				spyOn(statement, method).mockImplementation((...args: unknown[]) => {
					record(`Statement.${method}`, String(statement));
					return Reflect.apply(original, statement, args);
				}),
			);
		}
		return statement;
	};
	const query = Database.prototype.query;
	const prepare = Database.prototype.prepare;
	const run = Database.prototype.run;
	const exec = Database.prototype.exec;
	spies.push(
		spyOn(Database.prototype, "query").mockImplementation(function (
			this: Database,
			...args: Parameters<typeof query>
		) {
			return wrap(Reflect.apply(query, this, args));
		} as typeof query),
		spyOn(Database.prototype, "prepare").mockImplementation(function (
			this: Database,
			...args: Parameters<typeof prepare>
		) {
			return wrap(Reflect.apply(prepare, this, args));
		} as typeof prepare),
		spyOn(Database.prototype, "run").mockImplementation(function (this: Database, ...args: Parameters<typeof run>) {
			record("Database.run", args[0]);
			return Reflect.apply(run, this, args);
		} as typeof run),
		spyOn(Database.prototype, "exec").mockImplementation(function (this: Database, ...args: Parameters<typeof exec>) {
			record("Database.exec", args[0]);
			return Reflect.apply(exec, this, args);
		} as typeof exec),
	);
}

beforeEach(() => {
	checking = false;
	monitoredExecutions = 0;
	violations = [];
	savedEnv = featureEnv.map(key => process.env[key]);
	for (const key of featureEnv) delete process.env[key];
	spyOnSql();
	expect(currentLoopPhase()).toBeUndefined();
	checking = true;
	try {
		using control = new Database(":memory:");
		control.query("SELECT 1").get();
	} finally {
		checking = false;
	}
	expect(violations).toHaveLength(1);
	violations = [];
	monitoredExecutions = 0;
	root = TempDir.createSync("@mnemopi-loop-phase-");
	setEmbeddingProviderForTests({
		embed: async function* (texts: readonly string[]) {
			await Promise.resolve();
			yield texts.map(() => [0.1, 0.2, 0.3]);
		},
		available: () => true,
	});
});

afterEach(async () => {
	checking = false;
	try {
		await memory?.flushExtractions();
		memory?.close();
	} finally {
		memory = undefined;
		restoreSqlSpies();
		resetEmbeddingProviderForTests();
		for (const [index, key] of featureEnv.entries()) {
			if (savedEnv[index] === undefined) delete process.env[key];
			else process.env[key] = savedEnv[index];
		}
		await root?.remove();
		root = undefined;
	}
});

describe("Mnemopi SQLite loop-phase coverage", () => {
	for (const polyphonic of [false, true]) {
		it(`labels every statement in ${polyphonic ? "cached polyphonic" : "default linear"} facade flows`, async () => {
			const dbPath = root!.join("mnemopi.db");
			let extractionCalls = 0;
			let consolidatedItems = 0;
			expect(currentLoopPhase()).toBeUndefined();
			checking = true;
			try {
				memory = new Mnemopi({
					dbPath,
					sessionId: "loop-phase-bank",
					channelId: "loop-phase-bank",
					proactiveLinking: true,
					polyphonicRecall: polyphonic,
					enhancedRecall: polyphonic,
					embeddings: { disabled: false, model: "loop-phase-test" },
					llm: {
						enabled: true,
						complete: async () => {
							extractionCalls++;
							await Promise.resolve();
							return JSON.stringify({ facts: ["The user prefers invariant espresso"] });
						},
					},
				});
				const ids = [
					"Alice owns the espresso launch checklist",
					"The espresso launch checklist lives in the ops wiki",
					"The espresso launch checklist covers rollback",
				].map(content => memory!.remember(content, { source: "test", extract: true, scope: "bank" }));
				await memory.flushExtractions();
				expect(await memory.recall("espresso launch checklist", 5)).not.toHaveLength(0);
				const options = { includeFacts: true, channelId: "loop-phase-bank" };
				const first = await memory.recallEnhanced("espresso launch checklist", 5, options);
				expect(first).not.toHaveLength(0);
				if (polyphonic) {
					expect(await memory.recallEnhanced("espresso launch checklist", 5, options)).toEqual(first);
					expect(memory.beam.caches.queryCache?.stats()).toMatchObject({ hits: 1, misses: 1 });
				}
				expect(memory.get(ids[0])).not.toBeNull();
				expect(memory.update(ids[0], "Alice owns the revised espresso launch checklist")).toBe(true);
				await memory.flushExtractions();
				expect(memory.forget(ids[2])).toBe(true);
				expect(memory.getStats().total_memories).toBeGreaterThan(0);
				// sleep() requires timestamps older than half the working-memory TTL.
				checking = false;
				memory.beam.db.run("UPDATE working_memory SET timestamp = ? WHERE id IN (?, ?, ?)", [
					"2000-01-01T00:00:00.000Z",
					...ids,
				]);
				expect(currentLoopPhase()).toBeUndefined();
				checking = true;
				consolidatedItems = memory.sleep(false).items_consolidated ?? 0;
				await memory.flushExtractions();
				memory.close();
				memory = undefined;
			} finally {
				checking = false;
			}

			// Read persisted rows after removing the spy, so fixture SQL is never checked.
			restoreSqlSpies();
			using db = new Database(dbPath, { readonly: true });
			expect(extractionCalls).toBe(3);
			const embeddings = db.query<{ count: number }, []>("SELECT COUNT(*) AS count FROM memory_embeddings").get();
			const facts = db
				.query<{ count: number }, [string]>("SELECT COUNT(*) AS count FROM facts WHERE object = ?")
				.get("The user prefers invariant espresso");
			expect(embeddings!.count).toBeGreaterThan(0);
			expect(facts!.count).toBeGreaterThan(0);
			expect(consolidatedItems).toBeGreaterThan(0);
			expect(monitoredExecutions).toBeGreaterThan(0);
			expect(currentLoopPhase()).toBeUndefined();
			expect(violations).toEqual([]);
		});
	}
});
