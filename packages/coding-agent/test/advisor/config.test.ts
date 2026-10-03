import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fsp from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	advisorConfigFilePath,
	type AdvisorSyncBacklog,
	discoverAdvisorConfigs,
	getOrCreateAdvisorProviderSessionId,
	loadWatchdogConfigFile,
	resolveAdvisorConfigEditPath,
	saveWatchdogConfigFile,
	serializeWatchdogConfig,
	slugifyAdvisorName,
} from "../../src/advisor/config";
import type { WatchdogConfigDoc } from "@oh-my-pi/pi-tui/overlays/advisor-config";

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

	it("parses advisors, the model thinking suffix, cadence, tool filtering, and shared instructions", async () => {
		const yaml = [
			"instructions: Shared baseline for all advisors.",
			"advisors:",
			"  - name: Architecture",
			"    model: x-ai/grok-code-fast:high",
			"    reviewMode: agent-end",
			"    reviewInterval: 3",
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
		expect(arch.reviewMode).toBe("agent-end");
		expect(arch.reviewInterval).toBe(3);
		expect(arch.instructions).toBe("Watch module boundaries.");
		expect(sec.name).toBe("Security Reviewer");
		expect(sec.model).toBeUndefined();
		expect(sec.reviewMode).toBeUndefined();
		expect(sec.reviewInterval).toBeUndefined();
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

	it("ignores a malformed YAML file without throwing", async () => {
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), "advisors: [unclosed bracket");
		const result = await discoverAdvisorConfigs(tmp, agentDir);
		expect(result.advisors).toEqual([]);
		expect(result.sharedInstructions).toBeUndefined();
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("failed to parse YAML");
		// Editor reports the same problem class instead of blanking silently.
		const doc = await loadWatchdogConfigFile(path.join(tmp, "WATCHDOG.yml"));
		expect(doc.advisors).toEqual([]);
		expect(doc.warnings).toHaveLength(1);
		expect(doc.warnings?.[0]).toContain("failed to parse YAML");
	});

	it("skips a file whose shape fails the schema (advisors must be a list)", async () => {
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), "advisors: not-an-array");
		const result = await discoverAdvisorConfigs(tmp, agentDir);
		expect(result.advisors).toEqual([]);
		expect(result.warnings).toHaveLength(1);
		expect(result.warnings[0]).toContain("advisors must be a list");
		const doc = await loadWatchdogConfigFile(path.join(tmp, "WATCHDOG.yml"));
		expect(doc.advisors).toEqual([]);
		expect(doc.warnings).toHaveLength(1);
		expect(doc.warnings?.[0]).toContain("advisors must be a list");
	});

	it("drops only the malformed entry and reports one warning per problem", async () => {
		await Bun.write(
			path.join(tmp, "WATCHDOG.yml"),
			[
				"advisors:",
				"  - name: Good",
				"    reviewMode: agent-end",
				"  - name: Bad",
				"    reviewMode: every-step",
				"  - name: Also Bad",
				"    reviewInterval: 0",
			].join("\n"),
		);
		const result = await discoverAdvisorConfigs(tmp, agentDir);
		expect(result.advisors.map(a => a.name)).toEqual(["Good"]);
		expect(result.warnings).toHaveLength(2);
		expect(result.warnings[0]).toContain('"Bad"');
		expect(result.warnings[1]).toContain('"Also Bad"');
	});

	it("rejects malformed review intervals consistently during discovery and editing", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		for (const interval of ["0", "-1", "1.5", "'3'", ".nan", ".inf", "9007199254740992"]) {
			await Bun.write(file, `advisors:\n  - name: Invalid\n    reviewInterval: ${interval}\n`);
			const doc = await loadWatchdogConfigFile(file);
			expect(doc.advisors).toEqual([]);
			expect(doc.warnings).toHaveLength(1);
			expect(doc.warnings?.[0]).toContain('"Invalid"');
			expect((await discoverAdvisorConfigs(tmp, agentDir)).advisors).toEqual([]);
		}
	});

	it("editor load drops only the malformed entry, like discovery", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await Bun.write(file, "advisors:\n  - name: Good\n  - name: Bad\n    reviewMode: bogus\n");
		const doc = await loadWatchdogConfigFile(file);
		expect(doc.advisors.map(a => a.name)).toEqual(["Good"]);
		expect(doc.warnings).toHaveLength(1);
		expect(doc.warnings?.[0]).toContain('"Bad"');
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

	const doc: WatchdogConfigDoc = {
		instructions: 'Shared baseline.\n\nSecond line with: a colon and "quotes".',
		advisors: [
			{
				name: "Architecture",
				model: "x-ai/grok-code-fast:high",
				reviewMode: "agent-end",
				reviewInterval: 3,
				instructions: "Watch module boundaries.\nReport coupling.",
			},
			{ name: "Security", tools: ["read", "grep"], reviewInterval: 2 },
		],
	};

	it("saves and reloads a doc byte-equivalently (incl. multiline and special chars)", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await saveWatchdogConfigFile(file, doc);
		const loaded = await loadWatchdogConfigFile(file);
		expect(loaded).toEqual(doc);
	});

	it("round-trips positive safe-integer interval boundaries through editing and discovery", async () => {
		const boundaryDoc: WatchdogConfigDoc = {
			advisors: [
				{ name: "Minimum", reviewInterval: 1 },
				{ name: "Maximum", reviewInterval: Number.MAX_SAFE_INTEGER },
			],
		};
		await saveWatchdogConfigFile(path.join(tmp, "WATCHDOG.yml"), boundaryDoc);
		expect(await loadWatchdogConfigFile(path.join(tmp, "WATCHDOG.yml"))).toEqual(boundaryDoc);
		const { advisors } = await discoverAdvisorConfigs(tmp, tmp);
		expect(advisors.map(advisor => advisor.reviewInterval)).toEqual([1, Number.MAX_SAFE_INTEGER]);
	});

	it("rejects invalid intervals on save without replacing the existing roster", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await saveWatchdogConfigFile(file, doc);
		for (const interval of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, Number.MAX_SAFE_INTEGER + 1]) {
			await expect(
				saveWatchdogConfigFile(file, { advisors: [{ name: "Invalid", reviewInterval: interval }] }),
			).rejects.toThrow();
			expect(await loadWatchdogConfigFile(file)).toEqual(doc);
		}
	});

	it("serializes block-style YAML that the discovery path also parses", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await saveWatchdogConfigFile(file, doc);
		const text = await Bun.file(file).text();
		// Block style (not the flow `{...}` form), so it stays hand-editable.
		expect(text).toContain("advisors:");
		expect(text).not.toMatch(/^\{/);
		expect(text).toContain("reviewMode: agent-end");
		expect(text).toContain("reviewInterval: 3");
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

describe("per-advisor syncBacklog override", () => {
	let tmp: string;
	beforeEach(async () => {
		tmp = await fsp.mkdtemp(path.join(os.tmpdir(), "omp-advisor-sync-backlog-"));
		await fsp.mkdir(path.join(tmp, ".git"));
	});
	afterEach(async () => {
		await fsp.rm(tmp, { recursive: true, force: true });
	});

	it("expresses turn-async and final-strict independently; omitted stays unset for inheritance", async () => {
		const yaml = [
			"advisors:",
			"  - name: Turn Reviewer",
			"    reviewMode: turn",
			"    syncBacklog: off",
			"  - name: Final Reviewer",
			"    reviewMode: agent-end",
			"    syncBacklog: strict",
			"  - name: Numeric Threshold",
			"    syncBacklog: 3",
			"  - name: Inheriting",
		].join("\n");
		await Bun.write(path.join(tmp, "WATCHDOG.yml"), yaml);

		const { advisors } = await discoverAdvisorConfigs(tmp, tmp);
		expect(advisors).toHaveLength(4);
		const turn = advisors.find(a => a.name === "Turn Reviewer");
		const final = advisors.find(a => a.name === "Final Reviewer");
		const numeric = advisors.find(a => a.name === "Numeric Threshold");
		const inheriting = advisors.find(a => a.name === "Inheriting");
		// Explicit off is preserved, not collapsed into undefined: the runtime must
		// distinguish "this advisor never waits" from "follow the global setting".
		expect(turn?.reviewMode).toBe("turn");
		expect(turn?.syncBacklog).toBe("off");
		expect(final?.reviewMode).toBe("agent-end");
		expect(final?.syncBacklog).toBe("strict");
		// Unquoted YAML thresholds parse as numbers and normalize to the string enum.
		expect(numeric?.syncBacklog).toBe("3");
		expect(inheriting?.syncBacklog).toBeUndefined();
	});

	it("drops entries with an out-of-set syncBacklog while healthy entries load", async () => {
		await Bun.write(
			path.join(tmp, "WATCHDOG.yml"),
			[
				"advisors:",
				"  - name: Good",
				"    syncBacklog: '3'",
				"  - name: Bad Value",
				"    syncBacklog: sometimes",
				"  - name: Bad Threshold",
				"    syncBacklog: 2",
			].join("\n"),
		);

		const result = await discoverAdvisorConfigs(tmp, tmp);
		expect(result.advisors.map(a => a.name)).toEqual(["Good"]);
		expect(result.advisors[0]?.syncBacklog).toBe("3");
		expect(result.warnings).toHaveLength(2);
		expect(result.warnings[0]).toContain('"Bad Value"');
		expect(result.warnings[1]).toContain('"Bad Threshold"');

		const doc = await loadWatchdogConfigFile(path.join(tmp, "WATCHDOG.yml"));
		expect(doc.advisors.map(a => a.name)).toEqual(["Good"]);
		expect(doc.warnings).toHaveLength(2);
	});

	it("round-trips explicit off and strict through save, load, and discovery", async () => {
		const doc: WatchdogConfigDoc = {
			advisors: [
				{ name: "Never Wait", syncBacklog: "off" },
				{ name: "Gate Final", reviewMode: "agent-end", syncBacklog: "strict" },
				{ name: "Inherit" },
			],
		};
		const file = path.join(tmp, "WATCHDOG.yml");
		await saveWatchdogConfigFile(file, doc);

		const text = await Bun.file(file).text();
		expect(text).toContain('syncBacklog: "off"');
		expect(text).toContain("syncBacklog: strict");
		expect(text.match(/syncBacklog:/g)).toHaveLength(2);

		expect(await loadWatchdogConfigFile(file)).toEqual(doc);
		const { advisors } = await discoverAdvisorConfigs(tmp, tmp);
		expect(advisors.map(a => a.syncBacklog)).toEqual(["off", "strict", undefined]);
	});

	it("rejects an invalid syncBacklog on save without replacing the existing roster", async () => {
		const doc: WatchdogConfigDoc = { advisors: [{ name: "Healthy", syncBacklog: "1" }] };
		const file = path.join(tmp, "WATCHDOG.yml");
		await saveWatchdogConfigFile(file, doc);
		await expect(
			saveWatchdogConfigFile(file, {
				advisors: [{ name: "Invalid", syncBacklog: "sometimes" as AdvisorSyncBacklog }],
			}),
		).rejects.toThrow();
		expect(await loadWatchdogConfigFile(file)).toEqual(doc);
	});

	it("reports a non-mapping document in the editor just like discovery does", async () => {
		const file = path.join(tmp, "WATCHDOG.yml");
		await Bun.write(file, "- just\n- a\n- list\n");

		const discovered = await discoverAdvisorConfigs(tmp, tmp);
		expect(discovered.advisors).toEqual([]);
		expect(discovered.warnings).toHaveLength(1);
		expect(discovered.warnings[0]).toContain("expected a YAML mapping");

		const doc = await loadWatchdogConfigFile(file);
		expect(doc.advisors).toEqual([]);
		expect(doc.warnings).toHaveLength(1);
		expect(doc.warnings?.[0]).toContain("expected a YAML mapping");
	});
});
