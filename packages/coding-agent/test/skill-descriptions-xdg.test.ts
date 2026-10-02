import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { __resetProfileSnapshotForTests, getAgentDir, Snowflake, setAgentDir } from "@oh-my-pi/pi-utils";
import { SkillDescriptionStore } from "../src/extensibility/skill-descriptions";

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
