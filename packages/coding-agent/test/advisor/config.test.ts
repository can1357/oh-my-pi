import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	advisorConfigFilePath,
	discoverAdvisorConfigs,
	getOrCreateAdvisorProviderSessionId,
	loadWatchdogConfigFile,
	parseAgentWatchdogs,
	resolveAdvisorConfigEditPath,
	saveWatchdogConfigFile,
	serializeWatchdogConfig,
	slugifyAdvisorName,
	type WatchdogConfigDoc,
} from "../../src/advisor/config";

describe("discoverAdvisorConfigs", () => {
	let tmp: string;
	let agentDir: string;

	beforeEach(async () => {
		tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-advisor-config-"));
		await fsp.mkdir(path.join(tmp, ".git"));
		// Empty agent dir so the user-level search path can't pick up a real ~/.omp/WATCHDOG.yml.
		agentDir = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-advisor-agentdir-"));
	});

	afterEach(async () => {
		await fsp.rm(tmp, { recursive: true, force: true });
		await fsp.rm(agentDir, { recursive: true, force: true });
	});

	it("keeps equal display names and local IDs distinct across agent namespaces", async () => {
		const result = await discoverAdvisorConfigs(tmp, agentDir, {
			agentName: "one",
			agentDefinitions: [
				{ name: "one", watchdogs: [{ id: "check", name: "Review" }, { ref: "two/check" }] },
				{ name: "two", watchdogs: [{ id: "check", name: "Review" }] },
			],
		});
		expect(result.advisors.map(a => [a.id, a.name])).toEqual([
			["one/check", "Review"],
			["two/check", "Review"],
		]);
	});

	it("preserves valid agent names without lossy namespace collisions", async () => {
		const names = ["Code Reviewer", "code_reviewer", "code-reviewer", "team/reviewer"];
		const agentDefinitions = names.map(name => ({
			name,
			watchdogs: [{ id: "check", instructions: name }],
		}));
		const unrelated = await discoverAdvisorConfigs(tmp, agentDir, {
			agentName: "main",
			agentDefinitions,
		});
		expect(unrelated.advisors).toEqual([]);
		const inline = await discoverAdvisorConfigs(tmp, agentDir, {
			agentName: "Code Reviewer",
			agentDefinitions,
		});
		expect(inline.advisors.map(advisor => advisor.instructions)).toEqual(["Code Reviewer"]);
		const consumer = await discoverAdvisorConfigs(tmp, agentDir, {
			agentName: "consumer",
			agentDefinitions: [
				...agentDefinitions,
				{
					name: "consumer",
					watchdogs: names.map(name => ({ ref: `${name}/check` })),
				},
			],
		});
		expect(consumer.advisors.map(advisor => [advisor.id, advisor.instructions])).toEqual(
			names.map(name => [`${name.toLowerCase()}/check`, name]),
		);
	});

	it("resolves explicit shared IDs through project precedence and deduplicates references", async () => {
		await saveWatchdogConfigFile(path.join(agentDir, "WATCHDOG.yml"), {
			advisors: [{ id: "check", name: "User name", instructions: "User" }],
		});
		await saveWatchdogConfigFile(path.join(tmp, "WATCHDOG.yml"), {
			instructions: "Shared",
			advisors: [{ id: "check", name: "Project name", instructions: "Project", agents: [] }, { name: "Unselected" }],
		});
		const result = await discoverAdvisorConfigs(tmp, agentDir, {
			agentName: "worker",
			agentDefinitions: [{ name: "worker", watchdogs: [{ ref: " GLOBAL/CHECK " }, { ref: "global/check" }] }],
		});
		expect(result.advisors.map(a => [a.id, a.name, a.instructions, a.agents])).toEqual([
			["global/check", "Project name", "Project", undefined],
		]);
		expect(result.sharedInstructions).toBe("Shared");
	});

	it("rejects missing selected references without activating ordinary assignments", async () => {
		await saveWatchdogConfigFile(path.join(tmp, "WATCHDOG.yml"), { advisors: [{ name: "Ordinary" }] });
		await expect(
			discoverAdvisorConfigs(tmp, agentDir, {
				agentName: "worker",
				agentDefinitions: [{ name: "worker", watchdogs: [{ ref: "global/missing" }] }],
			}),
		).rejects.toThrow("global/missing");
	});

	it("does not resolve unrelated agent references or unselected roster assignments", async () => {
		await saveWatchdogConfigFile(path.join(tmp, "WATCHDOG.yml"), {
			advisors: [{ ref: "global/missing", agents: ["other"] }, { name: "Ordinary" }],
		});
		const result = await discoverAdvisorConfigs(tmp, agentDir, {
			agentName: "main",
			agentDefinitions: [{ name: "other", watchdogs: [{ ref: "global/also-missing" }] }],
		});
		expect(result.advisors.map(a => a.id)).toEqual(["global/ordinary"]);
	});

	it("retains explicit empty selection and shared baseline", async () => {
		await saveWatchdogConfigFile(path.join(tmp, "WATCHDOG.yml"), {
			instructions: "Shared",
			advisors: [{ name: "Ordinary" }],
		});
		const result = await discoverAdvisorConfigs(tmp, agentDir, {
			agentName: "worker",
			agentDefinitions: [{ name: "worker", watchdogs: [] }],
		});
		expect(result.advisors).toEqual([]);
		expect(result.explicitSelection).toBe(true);
		expect(result.sharedInstructions).toBe("Shared");
	});

	it("resolves inline imports relative to the defining agent rather than the selected agent", async () => {
		const sourceDir = path.join(tmp, "definitions");
		await fsp.mkdir(sourceDir);
		await Bun.write(path.join(sourceDir, "review.md"), "Source-relative review");
		const result = await discoverAdvisorConfigs(tmp, agentDir, {
			agentName: "consumer",
			agentDefinitions: [
				{ name: "consumer", watchdogs: [{ ref: "owner/check" }] },
				{
					name: "owner",
					filePath: path.join(sourceDir, "owner.md"),
					watchdogs: [{ id: "check", instructions: "@review.md" }],
				},
			],
		});
		expect(result.advisors[0].instructions).toContain("Source-relative review");
	});

	it("rejects normalized duplicate IDs and mixed reference definitions", () => {
		expect(() => parseAgentWatchdogs([{ id: " CHECK " }, { id: "check" }])).toThrow("Duplicate");
		expect(() => parseAgentWatchdogs([{ ref: "global/check", model: "override" }])).toThrow("cannot contain");
		expect(() => parseAgentWatchdogs([{ ref: "owner/" }])).toThrow("Invalid watchdog ID");
	});

	it("rejects duplicate shared IDs within one file", async () => {
		await Bun.write(
			path.join(tmp, "WATCHDOG.yml"),
			"advisors:\n  - id: check\n    name: First\n  - id: CHECK\n    name: Second\n",
		);
		await expect(discoverAdvisorConfigs(tmp, agentDir)).rejects.toThrow("duplicate watchdog ID");
	});

	it("parses advisors, the model thinking suffix, tool filtering, and shared instructions", async () => {
		const yaml = [
			"instructions: Shared baseline for all advisors.",
			"advisors:",
			"  - name: Architecture",
			"    model: x-ai/grok-code-fast:high",
			"    instructions: Watch module boundaries.",
			"  - name: Security Reviewer",
			"    tools: [read, definitely-not-a-tool]",
		].join("\n");
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), yaml);

		const { advisors, sharedInstructions } = await discoverAdvisorConfigs(tmp, agentDir);
		expect(advisors).toHaveLength(2);
		const [arch, sec] = advisors;
		expect(arch.name).toBe("Architecture");
		// The model selector (incl. the `:high` thinking suffix) is stored verbatim;
		// resolution happens later in the session, not here.
		expect(arch.model).toBe("x-ai/grok-code-fast:high");
		expect(arch.instructions).toBe("Watch module boundaries.");
		expect(sec.name).toBe("Security Reviewer");
		expect(sec.model).toBeUndefined();
		// The unknown/non-read-only tool is dropped; only `read` survives.
		expect(sec.tools).toEqual(["read"]);
		expect(sharedInstructions).toBe("Shared baseline for all advisors.");
	});

	it("distinguishes omitted tools, explicit no-tools, and invalid-only lists", async () => {
		const yaml = [
			"advisors:",
			"  - name: No Tools",
			"    tools: []",
			"  - name: Default Tools",
			"  - name: Invalid Only",
			"    tools: [reed]",
		].join("\n");
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), yaml);

		const { advisors } = await discoverAdvisorConfigs(tmp, agentDir);
		const noTools = advisors.find(a => a.name === "No Tools");
		const defaultTools = advisors.find(a => a.name === "Default Tools");
		const invalidOnly = advisors.find(a => a.name === "Invalid Only");

		expect(noTools?.tools).toEqual([]);
		expect(defaultTools?.tools).toBeUndefined();
		expect(invalidOnly?.tools).toBeUndefined();
	});

	it("keeps project slug overrides authoritative regardless of agent targeting", async () => {
		await saveWatchdogConfigFile(path.join(agentDir, "WATCHDOG.yml"), {
			advisors: [{ name: "Task Execution", agents: ["main"], instructions: "User baseline" }],
		});
		await saveWatchdogConfigFile(path.join(tmp, "WATCHDOG.yml"), {
			advisors: [{ name: "task-execution", agents: ["orc-implementer"], instructions: "Project override" }],
		});
		const { advisors } = await discoverAdvisorConfigs(tmp, agentDir);
		expect(advisors).toMatchObject([
			{ name: "task-execution", agents: ["orc-implementer"], instructions: "Project override" },
		]);
	});

	it("rejects non-list agent selectors at the file boundary", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await Bun.write(file, "advisors:\n  - name: Scoped\n    agents: main\n");
		expect((await discoverAdvisorConfigs(tmp, agentDir)).advisors).toEqual([]);
		expect(await loadWatchdogConfigFile(file)).toEqual({ advisors: [] });
	});

	it("ignores a malformed YAML file without throwing", async () => {
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), "advisors: [unclosed bracket");
		const result = await discoverAdvisorConfigs(tmp, agentDir);
		expect(result.advisors).toEqual([]);
		expect(result.sharedInstructions).toBeUndefined();
	});

	it("skips a file whose shape fails the schema (advisors must be a list)", async () => {
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), "advisors: not-an-array");
		const result = await discoverAdvisorConfigs(tmp, agentDir);
		expect(result.advisors).toEqual([]);
	});

	it("returns an empty roster when no config file exists", async () => {
		const result = await discoverAdvisorConfigs(tmp, agentDir);
		expect(result.advisors).toEqual([]);
		expect(result.sharedInstructions).toBeUndefined();
	});
});

describe("slugifyAdvisorName", () => {
	it("lowercases and collapses non-alphanumeric runs to single hyphens", () => {
		expect(slugifyAdvisorName("Security Reviewer")).toBe("security-reviewer");
		expect(slugifyAdvisorName("  Arch/Boundaries!  ")).toBe("arch-boundaries");
	});

	it("falls back to 'advisor' when nothing alphanumeric survives", () => {
		expect(slugifyAdvisorName("!!!")).toBe("advisor");
	});
});

describe("getOrCreateAdvisorProviderSessionId", () => {
	const primarySessionA = "018f8f5d-75b0-7cc6-8a6f-2f1c0b8e4c9d";
	const primarySessionB = "018f8f5d-75b1-7cc6-8a6f-2f1c0b8e4c9d";

	it("returns the generated UUIDv7 instead of a local advisor label", () => {
		const generated = "0193c8f2-7b1a-7c4d-9e2f-123456789abc";

		const providerSessionId = getOrCreateAdvisorProviderSessionId(
			new Map<string, string>(),
			primarySessionA,
			"security-advisor",
			() => generated,
		);

		expect(providerSessionId).toBe(generated);
		expect(providerSessionId).not.toContain("-advisor");
	});

	it("reuses the same generated UUIDv7 for repeated calls with the same primary session and slug", () => {
		const generatedIds = ["0193c8f2-7b1a-7c4d-9e2f-123456789abc", "0193c8f2-7b1b-7c4d-9e2f-123456789abc"];
		let nextGeneratedIdIndex = 0;
		const ids = new Map<string, string>();

		const first = getOrCreateAdvisorProviderSessionId(ids, primarySessionA, "architecture", () => {
			const generated = generatedIds[nextGeneratedIdIndex];
			if (!generated) throw new Error("unexpected generator call");
			nextGeneratedIdIndex += 1;
			return generated;
		});
		const second = getOrCreateAdvisorProviderSessionId(ids, primarySessionA, "architecture", () => {
			const generated = generatedIds[nextGeneratedIdIndex];
			if (!generated) throw new Error("unexpected generator call");
			nextGeneratedIdIndex += 1;
			return generated;
		});

		expect(first).toBe(generatedIds[0]);
		expect(second).toBe(generatedIds[0]);
		expect(nextGeneratedIdIndex).toBe(1);
	});

	it("creates distinct UUIDv7 values for different advisor slugs or primary sessions", () => {
		const generatedIds = [
			"0193c8f2-7b1a-7c4d-9e2f-123456789abc",
			"0193c8f2-7b1b-7c4d-9e2f-123456789abc",
			"0193c8f2-7b1c-7c4d-9e2f-123456789abc",
		];
		let nextGeneratedIdIndex = 0;
		const ids = new Map<string, string>();
		const nextGeneratedId = () => {
			const generated = generatedIds[nextGeneratedIdIndex];
			if (!generated) throw new Error("unexpected generator call");
			nextGeneratedIdIndex += 1;
			return generated;
		};

		const architecture = getOrCreateAdvisorProviderSessionId(ids, primarySessionA, "architecture", nextGeneratedId);
		const security = getOrCreateAdvisorProviderSessionId(ids, primarySessionA, "security", nextGeneratedId);
		const architectureForOtherSession = getOrCreateAdvisorProviderSessionId(
			ids,
			primarySessionB,
			"architecture",
			nextGeneratedId,
		);

		expect(architecture).toBe(generatedIds[0]);
		expect(security).toBe(generatedIds[1]);
		expect(architectureForOtherSession).toBe(generatedIds[2]);
		expect(new Set([architecture, security, architectureForOtherSession]).size).toBe(3);
	});

	it("rejects generated values that are not UUIDv7", () => {
		expect(() =>
			getOrCreateAdvisorProviderSessionId(
				new Map<string, string>(),
				primarySessionA,
				"architecture",
				() => "550e8400-e29b-41d4-a716-446655440000",
			),
		).toThrow("non-UUIDv7");
	});
});

describe("WATCHDOG.yml file round-trip", () => {
	let tmp: string;
	beforeEach(async () => {
		tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-advisor-file-"));
		await fsp.mkdir(path.join(tmp, ".git"));
	});
	afterEach(async () => {
		await fsp.rm(tmp, { recursive: true, force: true });
	});

	it("preserves definition IDs and reference assignments without materializing referenced definitions", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		const original: WatchdogConfigDoc = {
			advisors: [
				{ id: "stable-id", name: "Editable display", instructions: "@local.md" },
				{ ref: "worker/check", agents: ["main"], enabled: false },
				{ ref: "global/stable-id", agents: [] },
			],
		};
		await saveWatchdogConfigFile(file, original);
		const edited = await loadWatchdogConfigFile(file);
		edited.instructions = "Updated baseline";
		await saveWatchdogConfigFile(file, edited);
		expect(await loadWatchdogConfigFile(file)).toEqual({ ...original, instructions: "Updated baseline" });
	});

	const doc: WatchdogConfigDoc = {
		instructions: 'Shared baseline.\n\nSecond line with: a colon and "quotes".',
		advisors: [
			{
				name: "Architecture",
				model: "x-ai/grok-code-fast:high",
				instructions: "Watch module boundaries.\nReport coupling.",
			},
			{ name: "Security", tools: ["read", "grep"] },
		],
	};

	it("saves and reloads a doc byte-equivalently (incl. multiline and special chars)", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await saveWatchdogConfigFile(file, doc);
		const loaded = await loadWatchdogConfigFile(file);
		expect(loaded).toEqual(doc);
	});

	it("preserves agent selectors through unrelated file edits and discovery", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		const scopedDoc: WatchdogConfigDoc = {
			advisors: [
				{ name: "Primary", agents: [" MAIN ", "operator:#1"] },
				{ name: "Nobody", agents: [] },
				{ name: "Everyone" },
			],
		};
		await saveWatchdogConfigFile(file, scopedDoc);
		const edited = await loadWatchdogConfigFile(file);
		edited.advisors[0].instructions = "Updated instructions";
		await saveWatchdogConfigFile(file, edited);
		const expected = [[" MAIN ", "operator:#1"], [], undefined];
		expect((await loadWatchdogConfigFile(file)).advisors.map(advisor => advisor.agents)).toEqual(expected);
		expect((await discoverAdvisorConfigs(tmp, tmp)).advisors.map(advisor => advisor.agents)).toEqual(expected);
	});

	it("serializes block-style YAML that the discovery path also parses", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await saveWatchdogConfigFile(file, doc);
		const text = await Bun.file(file).text();
		// Block style (not the flow `{...}` form), so it stays hand-editable.
		expect(text).toContain("advisors:");
		expect(text).not.toMatch(/^\{/);
		expect(text).toContain('instructions: |2-\n  Shared baseline.\n  \n  Second line with: a colon and "quotes".');
		expect(text).toContain("    instructions: |2-\n      Watch module boundaries.\n      Report coupling.");
		expect(text).not.toContain("\\n");
		const { advisors, sharedInstructions } = await discoverAdvisorConfigs(tmp, tmp);
		expect(advisors.map(a => a.name)).toEqual(["Architecture", "Security"]);
		expect(sharedInstructions).toContain("Shared baseline.");
	});

	it("preserves significant leading whitespace and trailing newlines in block scalars", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		const whitespaceDoc: WatchdogConfigDoc = {
			instructions: "  indented first line\nplain second line\n\n",
			advisors: [{ name: "Whitespace", instructions: "\n  indented after blank\nplain" }],
		};

		await saveWatchdogConfigFile(file, whitespaceDoc);
		expect(await loadWatchdogConfigFile(file)).toEqual(whitespaceDoc);
	});

	it("round-trips an explicit empty tools list without collapsing it into the default", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		const explicitNoToolsDoc: WatchdogConfigDoc = {
			advisors: [{ name: "No Tools", tools: [] }, { name: "Default Tools" }],
		};

		await saveWatchdogConfigFile(file, explicitNoToolsDoc);
		const serializedDoc = await loadWatchdogConfigFile(file);
		expect(serializedDoc).toEqual(explicitNoToolsDoc);

		const { advisors } = await discoverAdvisorConfigs(tmp, tmp);
		expect(advisors.find(a => a.name === "No Tools")?.tools).toEqual([]);
		expect(advisors.find(a => a.name === "Default Tools")?.tools).toBeUndefined();
	});

	it("removes the file when the doc is empty so legacy discovery resumes", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await saveWatchdogConfigFile(file, doc);
		await saveWatchdogConfigFile(file, { advisors: [] });
		expect(await Bun.file(file).exists()).toBe(false);
		// Loading a missing file yields an empty doc, never throws.
		expect(await loadWatchdogConfigFile(file)).toEqual({ advisors: [] });
	});

	it("returns an empty serialization for an empty doc", () => {
		expect(serializeWatchdogConfig({ advisors: [] })).toBe("");
	});

	it("resolves project and user scope paths", () => {
		expect(advisorConfigFilePath("project", { projectDir: "/repo", agentDir: "/home/.omp" })).toBe(
			path.join("/repo", "WATCHDOG.yml"),
		);
		expect(advisorConfigFilePath("user", { projectDir: "/repo", agentDir: "/home/.omp" })).toBe(
			path.join("/home/.omp", "WATCHDOG.yml"),
		);
	});
});

describe("resolveAdvisorConfigEditPath", () => {
	let tmp: string;
	beforeEach(async () => {
		tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-advisor-resolve-"));
	});
	afterEach(async () => {
		await fsp.rm(tmp, { recursive: true, force: true });
	});

	const dirs = (d: string) => ({ projectDir: d, agentDir: d });

	it("defaults to .yml when neither file exists", async () => {
		expect(await resolveAdvisorConfigEditPath("project", dirs(tmp))).toBe(path.join(tmp, "WATCHDOG.yml"));
	});

	it("edits an existing .yaml in place when only it exists", async () => {
		await Bun.write(path.join(tmp, "WATCHDOG.yaml"), "advisors: []\n");
		expect(await resolveAdvisorConfigEditPath("project", dirs(tmp))).toBe(path.join(tmp, "WATCHDOG.yaml"));
	});

	it("prefers the canonical .yml when both exist", async () => {
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), "advisors: []\n");
		await Bun.write(path.join(tmp, "WATCHDOG.yaml"), "advisors: []\n");
		expect(await resolveAdvisorConfigEditPath("project", dirs(tmp))).toBe(path.join(tmp, "WATCHDOG.yml"));
	});
});

describe("per-advisor enabled field", () => {
	it("preserves explicit true, explicit false, and absence through save and discovery", async () => {
		const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-advisor-enabled-"));
		await fsp.mkdir(path.join(tmp, ".git"));
		try {
			const doc: WatchdogConfigDoc = {
				advisors: [
					{ name: "Explicit On", model: "test/model-a", enabled: true },
					{ name: "Explicit Off", model: "test/model-b", enabled: false },
					{ name: "Default", model: "test/model-c" },
				],
			};
			const file = path.join(tmp, "WATCHDOG.yml");
			await saveWatchdogConfigFile(file, doc);

			const loaded = await loadWatchdogConfigFile(file);
			expect(loaded.advisors.map(advisor => advisor.enabled)).toEqual([true, false, undefined]);

			const { advisors } = await discoverAdvisorConfigs(tmp, tmp);
			expect(advisors.map(advisor => advisor.enabled)).toEqual([true, false, undefined]);
		} finally {
			await fsp.rm(tmp, { recursive: true, force: true });
		}
	});

	it("emits explicit boolean values but omits an absent enabled field", () => {
		const text = serializeWatchdogConfig({
			advisors: [
				{ name: "Explicit On", enabled: true },
				{ name: "Explicit Off", enabled: false },
				{ name: "Default" },
			],
		});
		expect(text).toContain("enabled: true");
		expect(text).toContain("enabled: false");
		expect(text.match(/enabled:/g)).toHaveLength(2);
	});
});

describe("maxNotesPerUpdate configuration", () => {
	it("discovers shared and per-advisor maxNotesPerUpdate from WATCHDOG.yml", async () => {
		const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-advisor-max-notes-"));
		await fsp.mkdir(path.join(tmp, ".git"));
		try {
			const yaml = [
				"maxNotesPerUpdate: 4",
				"advisors:",
				"  - name: High Throughput",
				"    maxNotesPerUpdate: 5",
				"  - name: Default Budget",
			].join("\n");
			await Bun.write(path.join(tmp, "WATCHDOG.yml"), yaml);

			const { advisors, sharedMaxNotesPerUpdate } = await discoverAdvisorConfigs(tmp, tmp);
			expect(sharedMaxNotesPerUpdate).toBe(4);
			expect(advisors).toHaveLength(2);
			expect(advisors.find(a => a.name === "High Throughput")?.maxNotesPerUpdate).toBe(5);
			expect(advisors.find(a => a.name === "Default Budget")?.maxNotesPerUpdate).toBeUndefined();
		} finally {
			await fsp.rm(tmp, { recursive: true, force: true });
		}
	});

	it("round-trips maxNotesPerUpdate through save and load", async () => {
		const tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-advisor-max-notes-roundtrip-"));
		try {
			const doc: WatchdogConfigDoc = {
				maxNotesPerUpdate: 3,
				advisors: [{ name: "High", maxNotesPerUpdate: 5 }, { name: "Default" }],
			};
			const file = path.join(tmp, "WATCHDOG.yml");
			await saveWatchdogConfigFile(file, doc);

			const loaded = await loadWatchdogConfigFile(file);
			expect(loaded.maxNotesPerUpdate).toBe(3);
			expect(loaded.advisors[0]?.maxNotesPerUpdate).toBe(5);
			expect(loaded.advisors[1]?.maxNotesPerUpdate).toBeUndefined();
		} finally {
			await fsp.rm(tmp, { recursive: true, force: true });
		}
	});
});
