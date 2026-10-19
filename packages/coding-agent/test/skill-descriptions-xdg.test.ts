import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as agentCore from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { __resetProfileSnapshotForTests, getAgentDir, Snowflake, setAgentDir } from "@oh-my-pi/pi-utils";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import {
	createSkillDescriptionCompressor,
	previewSkillDescription,
	SkillDescriptionCatalog,
	type SkillDescriptionCompressor,
	SkillDescriptionStore,
} from "../src/extensibility/skill-descriptions";
import type { Skill } from "../src/extensibility/skills";
import type { AuthStorage } from "../src/session/auth-storage";
import { createAssistantMessage, createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const ENV_KEYS = ["PI_CONFIG_DIR", "PI_CODING_AGENT_DIR", "XDG_DATA_HOME"] as const;

describe.skipIf(process.platform !== "linux" && process.platform !== "darwin")(
	"skill description cache under XDG",
	() => {
		let tempRoot = "";
		let configDir = "";
		let agentDir = "";
		let xdgData = "";
		let originalAgentDir = "";
		let originalEnv: Partial<Record<(typeof ENV_KEYS)[number], string>> = {};

		beforeEach(async () => {
			originalAgentDir = getAgentDir();
			originalEnv = {};
			for (const key of ENV_KEYS) originalEnv[key] = process.env[key];
			tempRoot = path.join(os.tmpdir(), "omp-skill-descriptions-xdg", Snowflake.next());
			configDir = `.omp-skill-xdg-${Snowflake.next()}`;
			agentDir = path.join(os.homedir(), configDir, "agent");
			xdgData = path.join(tempRoot, "data");
			await fs.promises.mkdir(path.join(xdgData, "omp"), { recursive: true });
			await fs.promises.mkdir(agentDir, { recursive: true });
			process.env.PI_CONFIG_DIR = configDir;
			delete process.env.PI_CODING_AGENT_DIR;
			__resetProfileSnapshotForTests();
		});

		afterEach(async () => {
			vi.restoreAllMocks();
			for (const key of ENV_KEYS) {
				const value = originalEnv[key];
				if (value === undefined) delete process.env[key];
				else process.env[key] = value;
			}
			setAgentDir(originalAgentDir);
			await fs.promises.rm(tempRoot, { recursive: true, force: true });
			await fs.promises.rm(path.join(os.homedir(), configDir), { recursive: true, force: true });
		});

		it("adopts a legacy database, including uncheckpointed WAL rows, when XDG relocates it", () => {
			// An older omp still holds the legacy db open: its latest row lives only in the WAL.
			using legacy = SkillDescriptionStore.open(path.join(agentDir, "skill-descriptions.db"));
			legacy.put("k", "compressed description");

			process.env.XDG_DATA_HOME = xdgData;
			setAgentDir(agentDir);
			using store = SkillDescriptionStore.open();

			expect(store.path).toBe(path.join(xdgData, "omp", "skill-descriptions.db"));
			expect(store.get("k")).toBe("compressed description");
		});

		it("still adopts the legacy database on filesystems without hard links", () => {
			using legacy = SkillDescriptionStore.open(path.join(agentDir, "skill-descriptions.db"));
			legacy.put("k", "compressed description");
			const link = spyOn(fs, "linkSync").mockImplementation(() => {
				throw Object.assign(new Error("operation not permitted"), { code: "EPERM" });
			});

			process.env.XDG_DATA_HOME = xdgData;
			setAgentDir(agentDir);
			using store = SkillDescriptionStore.open();

			expect(link).toHaveBeenCalled();
			expect(store.get("k")).toBe("compressed description");
		});

		it("keeps an existing XDG database instead of overwriting it with the legacy one", () => {
			using legacy = SkillDescriptionStore.open(path.join(agentDir, "skill-descriptions.db"));
			legacy.put("k", "legacy");
			const xdgDb = new Database(path.join(xdgData, "omp", "skill-descriptions.db"), { create: true });
			xdgDb.run("CREATE TABLE skill_descriptions (key TEXT PRIMARY KEY, description TEXT NOT NULL)");
			xdgDb.run("INSERT INTO skill_descriptions VALUES ('k', 'current')");
			xdgDb.close();

			process.env.XDG_DATA_HOME = xdgData;
			setAgentDir(agentDir);
			using store = SkillDescriptionStore.open();

			expect(store.get("k")).toBe("current");
		});
	},
);

describe("skill description failure caching and shutdown", () => {
	let tempDir: string;
	const authStorages: AuthStorage[] = [];
	const description =
		"Use when planning or reviewing multi-step data migrations across services, checking rollout dependencies, preserving data consistency, and preparing safe rollback procedures.";
	const compressed = "Use for planning and reviewing data migrations.";

	beforeEach(async () => {
		tempDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-skill-description-failures-"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		for (const storage of authStorages.splice(0)) storage.close();
		await fs.promises.rm(tempDir, { recursive: true, force: true });
	});

	function skill(name = "migrations"): Skill {
		return {
			name,
			description,
			filePath: path.join(tempDir, name, "SKILL.md"),
			baseDir: path.join(tempDir, name),
			source: "native:project",
		};
	}

	function storedDescriptions(dbPath: string): string[] {
		using db = new Database(dbPath, { readonly: true });
		return db
			.query<{ description: string }, []>("SELECT description FROM skill_descriptions ORDER BY description")
			.all()
			.map(row => row.description);
	}

	function fast(
		compress: SkillDescriptionCompressor["compress"],
		model: string | undefined = "test/fast",
	): SkillDescriptionCompressor {
		return { modelKey: () => model, compress };
	}

	function modelCompressor(stopReason: AssistantMessage["stopReason"]): SkillDescriptionCompressor {
		const authStorage = createInMemoryAuthStorage();
		authStorages.push(authStorage);
		authStorage.keys.setRuntime("anthropic", "test-key");
		const settings = Settings.isolated({ modelRoles: { smol: "anthropic/claude-sonnet-4-5" } });
		const registry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"), { settings });
		vi.spyOn(agentCore, "instrumentedCompleteSimple").mockResolvedValue({
			...createAssistantMessage(compressed),
			stopReason,
		});
		const compressor = createSkillDescriptionCompressor(registry, settings);
		vi.spyOn(compressor, "compress");
		return compressor;
	}

	it.each([
		["more than 12 words", "one two three four five six seven eight nine ten eleven twelve thirteen"],
		["more than 160 characters", "x".repeat(161)],
		["multiple lines", "Use for migrations.\nCheck rollout safety."],
	])("does not ask the same model again after an answer with %s", async (_reason, answer) => {
		using store = SkillDescriptionStore.open(path.join(tempDir, "cache.db"));
		const entry = skill();
		const preview = previewSkillDescription(entry.description);
		const first = new SkillDescriptionCatalog({ store, compress: fast(async () => answer) });
		first.render([entry]);
		await first.waitForPending();

		const retry = vi.fn(async () => compressed);
		const second = new SkillDescriptionCatalog({ store, compress: fast(retry) });
		expect(second.render([entry])[0].description).toBe(preview);
		await second.waitForPending();
		expect(retry).toHaveBeenCalledTimes(0);
	});

	it("asks a newly selected model after the previous model's answer was unusable", async () => {
		using store = SkillDescriptionStore.open(path.join(tempDir, "cache.db"));
		const entry = skill();
		const first = new SkillDescriptionCatalog({ store, compress: fast(async () => "Bad\nanswer", "test/old") });
		first.render([entry]);
		await first.waitForPending();

		const retry = vi.fn(async () => compressed);
		const second = new SkillDescriptionCatalog({ store, compress: fast(retry, "test/new") });
		second.render([entry]);
		await second.waitForPending();
		expect(retry).toHaveBeenCalledTimes(1);
		expect(new SkillDescriptionCatalog({ store }).render([entry])[0].description).toBe(compressed);
	});

	it("does not ask the same model again after a length stop, even when the partial text would pass validation", async () => {
		using store = SkillDescriptionStore.open(path.join(tempDir, "cache.db"));
		const entry = skill();
		const preview = previewSkillDescription(entry.description);
		const compressor = modelCompressor("length");
		const first = new SkillDescriptionCatalog({ store, compress: compressor });
		first.render([entry]);
		await first.waitForPending();

		expect(compressor.compress).toHaveBeenCalledTimes(1);
		const second = new SkillDescriptionCatalog({ store, compress: compressor });
		expect(second.render([entry])[0].description).toBe(preview);
		await second.waitForPending();
		expect(compressor.compress).toHaveBeenCalledTimes(1);
	});

	it("retries a thrown transport failure next session instead of storing a fallback", async () => {
		using store = SkillDescriptionStore.open(path.join(tempDir, "cache.db"));
		const entry = skill();
		const first = new SkillDescriptionCatalog({
			store,
			compress: fast(async () => {
				throw new Error("connection reset");
			}),
		});
		first.render([entry]);
		await first.waitForPending();
		expect(storedDescriptions(store.path)).toEqual([]);

		const retry = vi.fn(async () => compressed);
		const second = new SkillDescriptionCatalog({ store, compress: fast(retry) });
		second.render([entry]);
		await second.waitForPending();
		expect(retry).toHaveBeenCalledTimes(1);
		expect(storedDescriptions(store.path)).toEqual([compressed]);
	});

	it.each(["error", "aborted"] as const)("leaves a model %s stop uncached and retries next session", async reason => {
		using store = SkillDescriptionStore.open(path.join(tempDir, "cache.db"));
		const entry = skill();
		const compressor = modelCompressor(reason);
		const first = new SkillDescriptionCatalog({ store, compress: compressor });
		first.render([entry]);
		await first.waitForPending();
		expect(storedDescriptions(store.path)).toEqual([]);

		const second = new SkillDescriptionCatalog({ store, compress: compressor });
		second.render([entry]);
		await second.waitForPending();
		expect(compressor.compress).toHaveBeenCalledTimes(2);
		expect(storedDescriptions(store.path)).toEqual([]);
	});

	it("retries an edited skill after the same model's answer for it was unusable", async () => {
		using store = SkillDescriptionStore.open(path.join(tempDir, "cache.db"));
		const entry = skill();
		const first = new SkillDescriptionCatalog({ store, compress: fast(async () => "Bad\nanswer") });
		first.render([entry]);
		await first.waitForPending();

		const retry = vi.fn(async () => compressed);
		const edited = { ...entry, description: `${entry.description} Also inspect indexes.` };
		const second = new SkillDescriptionCatalog({ store, compress: fast(retry) });
		second.render([edited]);
		await second.waitForPending();
		expect(retry).toHaveBeenCalledTimes(1);
		expect(new SkillDescriptionCatalog({ store }).render([edited])[0].description).toBe(compressed);
	});

	it("waits for an in-flight compression before closing so its row survives reopening", async () => {
		const store = SkillDescriptionStore.open(path.join(tempDir, "cache.db"));
		const started = Promise.withResolvers<void>();
		const reply = Promise.withResolvers<string>();
		const catalog = new SkillDescriptionCatalog({
			store,
			compress: fast(async () => {
				started.resolve();
				return reply.promise;
			}),
		});
		catalog.render([skill()]);
		await started.promise;
		let closed = false;
		const closing = Promise.resolve(store.close()).then(() => {
			closed = true;
		});
		await Promise.resolve();
		const closedBeforeReply = closed;
		reply.resolve(compressed);
		await closing;
		await catalog.waitForPending();

		using reopened = SkillDescriptionStore.open(store.path);
		expect(closedBeforeReply).toBe(false);
		expect(storedDescriptions(reopened.path)).toEqual([compressed]);
	});

	it("does not send a queued compression request once closing has begun", async () => {
		const store = SkillDescriptionStore.open(path.join(tempDir, "cache.db"));
		const started = Promise.withResolvers<void>();
		const reply = Promise.withResolvers<string>();
		const called: string[] = [];
		const catalog = new SkillDescriptionCatalog({
			store,
			compress: fast(async name => {
				called.push(name);
				if (called.length === 4) started.resolve();
				return reply.promise;
			}),
		});
		catalog.render(Array.from({ length: 5 }, (_, index) => skill(`migrations-${index}`)));
		await started.promise;
		const closing = store.close();
		reply.resolve(compressed);
		await closing;
		await catalog.waitForPending();

		expect(called).toEqual(["migrations-0", "migrations-1", "migrations-2", "migrations-3"]);
		expect(storedDescriptions(store.path)).toHaveLength(4);
	});

	it("closes within the shutdown grace period even if a compression never finishes", async () => {
		const store = SkillDescriptionStore.open(path.join(tempDir, "cache.db"));
		const started = Promise.withResolvers<void>();
		const reply = Promise.withResolvers<string>();
		const catalog = new SkillDescriptionCatalog({
			store,
			compress: fast(async () => {
				started.resolve();
				return reply.promise;
			}),
		});
		catalog.render([skill()]);
		await started.promise;
		const beforeClose = performance.now();
		await store.close();
		const elapsed = performance.now() - beforeClose;
		reply.resolve(compressed);
		await catalog.waitForPending();

		expect(elapsed).toBeLessThan(5_000);
		expect(storedDescriptions(store.path)).toEqual([]);
	}, 6_000);
});
