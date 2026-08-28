import { describe, expect, it } from "bun:test";

import {
	type DiscoveryContext,
	discoverExtensionCapabilities,
	discoverMcpCapabilities,
	discoverSkills,
	McpCircuitBreaker,
	type McpServerManifest,
	McpSessionCache,
	parseSkillDocument,
} from "@oh-my-pi/pi-coding-agent/memory-fabric/capability-discovery";

const ctx: DiscoveryContext = { scope: "project", sourcePath: "/proj/.skills/demo/SKILL.md" };

const VALID_DOC = [
	"---",
	"name: Demo Skill",
	"description: A demo skill",
	"version: 2",
	"tags: [alpha, beta]",
	"requires:",
	"  - tool:read-file",
	"conflicts-with: [skill:project:other]",
	"---",
	"# Body",
].join("\n");

describe("capability-discovery: parseSkillDocument", () => {
	it("parses a valid SKILL.md into a normalized descriptor", () => {
		const result = parseSkillDocument(VALID_DOC, ctx);
		expect(result.node?.id).toBe("skill:project:demo-skill");
		expect(result.node?.kind).toBe("skill");
		expect(result.node?.name).toBe("Demo Skill");
		expect(result.node?.version).toBe(2);
		expect(result.node?.tags).toEqual(["alpha", "beta"]);
	});

	it("emits declared edges and mirrors them into shorthand metadata", () => {
		const result = parseSkillDocument(VALID_DOC, ctx);
		expect(result.edges).toEqual([
			{ from: "skill:project:demo-skill", to: "tool:read-file", kind: "requires" },
			{ from: "skill:project:demo-skill", to: "skill:project:other", kind: "conflicts-with" },
		]);
		expect(result.node?.metadata?.requires).toEqual(["tool:read-file"]);
		expect(result.node?.metadata?.conflictsWith).toEqual(["skill:project:other"]);
	});

	it("records a deterministic 8-hex revision hash", () => {
		const a = parseSkillDocument(VALID_DOC, ctx);
		const b = parseSkillDocument(VALID_DOC, ctx);
		expect(a.node?.metadata?.revisionHash).toBe(b.node?.metadata?.revisionHash);
		expect(String(a.node?.metadata?.revisionHash)).toMatch(/^[0-9a-f]{8}$/);
	});

	it("fails with a diagnostic when front matter is missing", () => {
		const result = parseSkillDocument("just a markdown body", ctx);
		expect(result.node).toBeNull();
		expect(result.diagnostics[0]?.level).toBe("error");
	});

	it("fails when the name is missing or empty", () => {
		const result = parseSkillDocument("---\ndescription: x\n---\nbody", ctx);
		expect(result.node).toBeNull();
	});

	it("rejects namespaced names and calls out reserved namespaces", () => {
		const result = parseSkillDocument("---\nname: tool:sneaky\n---\nbody", ctx);
		expect(result.node).toBeNull();
		expect(result.diagnostics[0]?.message).toContain('namespace "tool" is reserved');
	});

	it("requires approval by default for high-risk or write-capable skills", () => {
		const risky = parseSkillDocument("---\nname: risky\ndescription: d\nrisk: high\n---\n", ctx);
		expect(risky.node?.requiresApproval).toBe(true);
		const override = parseSkillDocument(
			"---\nname: risky\ndescription: d\nrisk: high\nrequires-approval: false\n---\n",
			ctx,
		);
		expect(override.node?.requiresApproval).toBe(false);
	});

	it("honours enabled/disabled flags", () => {
		const off = parseSkillDocument("---\nname: s\ndescription: d\ndisabled: true\n---\n", ctx);
		expect(off.node?.enabled).toBe(false);
	});

	it("warns (but succeeds) when the description is missing", () => {
		const result = parseSkillDocument("---\nname: quiet\n---\nbody", ctx);
		expect(result.node).not.toBeNull();
		expect(result.diagnostics.some(d => d.level === "warning")).toBe(true);
	});

	it("fails open on invalid scope", () => {
		const result = parseSkillDocument(VALID_DOC, { scope: "bogus" } as unknown as DiscoveryContext);
		expect(result.node).toBeNull();
	});
});

describe("capability-discovery: discoverSkills", () => {
	it("de-duplicates colliding ids with first-definition-wins", () => {
		const result = discoverSkills([
			{ raw: VALID_DOC, context: ctx },
			{ raw: VALID_DOC, context: { ...ctx, sourcePath: "/other/SKILL.md" } },
		]);
		expect(result.nodes).toHaveLength(1);
		expect(result.diagnostics.some(d => d.message.includes("first definition wins"))).toBe(true);
	});
});

describe("capability-discovery: MCP + extensions", () => {
	const server: McpServerManifest = {
		serverId: "srv",
		serverName: "Server",
		tools: [{ name: "read", description: "reads", readOnly: true }, { name: "write" }],
	};

	it("normalizes MCP tools into descriptors with conservative approval", () => {
		const result = discoverMcpCapabilities([server]);
		expect(result.nodes.map(n => n.id)).toEqual(["mcp:srv:read", "mcp:srv:write"]);
		expect(result.nodes[0]?.requiresApproval).toBe(false);
		expect(result.nodes[1]?.requiresApproval).toBe(true);
	});

	it("reports unreachable servers as error diagnostics", () => {
		const result = discoverMcpCapabilities([{ ...server, unreachable: true, errorReason: "timeout" }]);
		expect(result.nodes).toEqual([]);
		expect(result.diagnostics[0]?.level).toBe("error");
		expect(result.diagnostics[0]?.message).toContain("timeout");
	});

	it("circuit breaker trips after maxFailures and reopens after cooldown", () => {
		let clock = 1000;
		const breaker = new McpCircuitBreaker(2, 100, () => clock);
		breaker.recordFailure("srv");
		expect(breaker.canAttempt("srv")).toBe(true);
		breaker.recordFailure("srv");
		expect(breaker.canAttempt("srv")).toBe(false);
		clock = 1101;
		expect(breaker.canAttempt("srv")).toBe(true);
		breaker.recordSuccess("srv");
		expect(breaker.getState("srv")).toBeUndefined();
	});

	it("tripped breaker makes discovery bypass the server with a warning", () => {
		const breaker = new McpCircuitBreaker(1, 1000, () => 0);
		breaker.recordFailure("srv");
		const result = discoverMcpCapabilities([server], { circuitBreaker: breaker });
		expect(result.nodes).toEqual([]);
		expect(result.diagnostics[0]?.message).toContain("circuit breaker");
	});

	it("session cache stores manifests and expires them by TTL", () => {
		let clock = 0;
		const cache = new McpSessionCache(50, () => clock);
		cache.set("srv", server);
		expect(cache.get("srv")?.serverId).toBe("srv");
		clock = 51;
		expect(cache.get("srv")).toBeUndefined();
	});

	it("normalizes extensions into a sidecar node plus tool nodes with requires edges", () => {
		const result = discoverExtensionCapabilities([
			{ extensionId: "ext1", name: "Ext", description: "d", tools: [{ name: "run" }] },
		]);
		expect(result.nodes.map(n => n.id)).toEqual(["extension:ext1", "extension:ext1:run"]);
		expect(result.nodes[0]?.kind).toBe("sidecar");
		expect(result.edges).toEqual([{ from: "extension:ext1", to: "extension:ext1:run", kind: "requires" }]);
	});
});
