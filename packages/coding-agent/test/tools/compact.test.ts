import { describe, expect, it } from "bun:test";
import { type SettingPath, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { CompactTool } from "@oh-my-pi/pi-coding-agent/tools/compact";

function createToolSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		// Default the opt-in gate on so the top-level/subagent/advisor dimension
		// tests below exercise that logic rather than the default-off gate; the
		// gate itself has its own describe block.
		settings: Settings.isolated({ "compact.enabled": true }),
		...overrides,
	};
}

describe("compact tool factory (BUILTIN_TOOLS.compact / CompactTool.createIf)", () => {
	it("returns a tool for a top-level session (taskDepth undefined)", () => {
		const tool = CompactTool.createIf(createToolSession());
		expect(tool).not.toBeNull();
		expect(tool?.name).toBe("compact");
	});

	it("returns a tool for a top-level session (taskDepth 0)", () => {
		expect(CompactTool.createIf(createToolSession({ taskDepth: 0 }))).not.toBeNull();
	});

	it("returns null for a subagent session (taskDepth >= 1)", () => {
		expect(CompactTool.createIf(createToolSession({ taskDepth: 1 }))).toBeNull();
		expect(CompactTool.createIf(createToolSession({ taskDepth: 3 }))).toBeNull();
	});

	it("returns null for a subagent identity session (parentTaskPrefix set, taskDepth 0)", () => {
		// A `/tan` background clone copies the parent's tools and sets
		// parentTaskPrefix but leaves taskDepth at 0. It is a disposable subagent
		// and must not receive the compact tool despite its zero depth.
		expect(CompactTool.createIf(createToolSession({ parentTaskPrefix: "clone", taskDepth: 0 }))).toBeNull();
		expect(CompactTool.createIf(createToolSession({ parentTaskPrefix: "clone" }))).toBeNull();
	});

	it("returns null for an advisor tool session (spread from top-level, getAgentId 'advisor')", () => {
		// The advisor tool session is built by spreading the primary top-level
		// session, so it inherits taskDepth 0 and no parentTaskPrefix — both the
		// depth and prefix checks pass. But it runs its own Agent and never runs
		// the primary's turn-settle marker consumer, so a compact tool there is
		// inert: it returns "scheduled" while no compaction ever runs. Its
		// getAgentId === "advisor" is the SDK's own primary/advisor discriminator.
		const advisorSession = createToolSession({ taskDepth: 0, getAgentId: () => "advisor" });
		expect(CompactTool.createIf(advisorSession)).toBeNull();
		// Also with taskDepth left undefined (the plain spread of a top-level session).
		expect(CompactTool.createIf(createToolSession({ getAgentId: () => "advisor" }))).toBeNull();
	});

	it("still returns a tool for a top-level session with a non-advisor agent id", () => {
		// The exclusion must be advisor-specific: a genuine top-level primary
		// carries getAgentId (e.g. "Main") and must keep the compact tool.
		expect(CompactTool.createIf(createToolSession({ taskDepth: 0, getAgentId: () => "Main" }))).not.toBeNull();
	});
});

describe("compact tool default-off gate (compact.enabled)", () => {
	it("returns null for a top-level session when compact.enabled is unset (default off)", () => {
		// The tool ships opt-in: an isolated session with no override must not get
		// it even though the session is a genuine top-level primary.
		const session = createToolSession({ settings: Settings.isolated() });
		expect(CompactTool.createIf(session)).toBeNull();
	});

	it("returns null for a top-level session when compact.enabled is explicitly false", () => {
		const session = createToolSession({ settings: Settings.isolated({ "compact.enabled": false }) });
		expect(CompactTool.createIf(session)).toBeNull();
	});

	it("returns a tool for a top-level session when compact.enabled is true", () => {
		const session = createToolSession({ settings: Settings.isolated({ "compact.enabled": true }) });
		expect(CompactTool.createIf(session)).not.toBeNull();
	});

	it("keeps excluding a subagent even when compact.enabled is true", () => {
		// The opt-in gate does not override the top-level guard: a subagent with
		// the tool explicitly enabled must still be refused.
		const session = createToolSession({ settings: Settings.isolated({ "compact.enabled": true }), taskDepth: 1 });
		expect(CompactTool.createIf(session)).toBeNull();
	});
});

describe("compact tool advertisement through createTools (schema reaching the model)", () => {
	// `CompactTool.createIf` returning null is necessary but not sufficient: the
	// maintainer's ask is that a default session never advertises the tool at
	// all. `createTools` filters `isToolAllowed` BEFORE invoking any factory, so
	// these assert the observable end state — the name is absent from the active
	// set and from the built tool list, hence no schema and no rendered
	// description ever reach the provider.
	function advertisingSession(settingsOverrides: Partial<Record<SettingPath, unknown>> = {}): ToolSession {
		return {
			cwd: "/tmp/test",
			hasUI: false,
			skipPythonPreflight: true,
			enableLsp: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(settingsOverrides),
		};
	}

	it("does NOT advertise compact under a default config", async () => {
		const session = advertisingSession();
		const names = (await createTools(session)).map(tool => tool.name);
		expect(names).not.toContain("compact");
		// Absent from the active-name set too, so nothing can later resolve or
		// mount it as an xd:// device either.
		expect(session.isToolActive?.("compact")).toBe(false);
	});

	it("advertises compact as a working essential tool once compact.enabled is set", async () => {
		const session = advertisingSession({ "compact.enabled": true });
		const tools = await createTools(session);
		const compact = tools.find(tool => tool.name === "compact");
		expect(compact).toBeDefined();
		expect(session.isToolActive?.("compact")).toBe(true);
		// `essential` is what keeps it top-level rather than demoted under xdev,
		// which is why the name is registered in ESSENTIAL_BUILTIN_TOOL_NAMES.
		expect(compact?.loadMode).toBe("essential");
		// A non-empty rendered description is exactly what default-off must
		// withhold, so assert the enabled path really does ship one.
		expect(compact?.description.length).toBeGreaterThan(0);
	});

	it("does NOT advertise compact even when explicitly requested while disabled", async () => {
		// An explicit tool list must not bypass the opt-in gate: `isToolAllowed`
		// filters `filteredRequestedTools` on the same predicate.
		const names = (await createTools(advertisingSession(), ["read", "compact"])).map(tool => tool.name);
		expect(names).not.toContain("compact");
		expect(names).toContain("read");
	});
});

describe("compact tool metadata", () => {
	it("exposes name/approval/loadMode contract", () => {
		const tool = new CompactTool(createToolSession());
		expect(tool.name).toBe("compact");
		expect(tool.approval).toBe("read");
		expect(tool.loadMode).toBe("essential");
	});
});

describe("compact tool execute (signal-only, no inline compaction)", () => {
	it("returns details.requested === true and does not compact inline", async () => {
		const session = createToolSession();
		const tool = new CompactTool(session);
		// The tool must be a pure signal: the ToolSession stub has no compaction
		// machinery, so any attempt to actually compact from execute() would throw
		// or touch session state. A clean resolve with requested:true proves the
		// deferral — the session runs compaction later at turn settle. The confirmation
		// text is user-facing copy, not a contract; the deferred-compaction behaviour is
		// covered by the session-level tests.
		const result = await tool.execute("call_compact", {});

		expect(result.details?.requested).toBe(true);
		expect(result.isError).toBeUndefined();
	});

	it("trims instructions into details.instructions", async () => {
		const tool = new CompactTool(createToolSession());
		const result = await tool.execute("call_compact", { instructions: "  keep the API contract  " });
		expect(result.details?.instructions).toBe("keep the API contract");
	});

	it("normalizes blank/whitespace-only instructions to undefined", async () => {
		const tool = new CompactTool(createToolSession());
		const blank = await tool.execute("call_compact", { instructions: "   " });
		expect(blank.details?.instructions).toBeUndefined();

		const omitted = await tool.execute("call_compact", {});
		expect(omitted.details?.instructions).toBeUndefined();
	});

	it("throws when invoked in a subagent (defense in depth beyond createIf)", async () => {
		const tool = new CompactTool(createToolSession({ taskDepth: 2 }));
		await expect(tool.execute("call_compact", {})).rejects.toThrow("subagent");
	});
});
