import { afterEach, describe, expect, it, vi } from "bun:test";
import type { AgentMessage, AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Api, Model } from "@oh-my-pi/pi-ai";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { DecisionRecord } from "@oh-my-pi/pi-coding-agent/decision/records";
import {
	prepareToolPreflight,
	TOOL_CONTRACT_MESSAGE_TYPE,
	TOOL_HINT_MESSAGE_TYPE,
	TOOL_PREFLIGHT_POLICY,
	type ToolContract,
	type ToolPreflightSource,
	toolPreflightMessages,
} from "@oh-my-pi/pi-coding-agent/decision/tool-preflight";
import { createMCPToolName } from "@oh-my-pi/pi-coding-agent/mcp/tool-bridge";
import type { XdevState } from "@oh-my-pi/pi-coding-agent/tools/xdev";
import { isRecord } from "@oh-my-pi/pi-utils";
import { Type } from "@sinclair/typebox";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";
import { asGlobalFetch } from "./helpers/fetch-mock";

const JEV = {
	id: "jev-preview",
	name: "JEV Preview",
	api: "typesafe",
	provider: "typesafe",
	baseUrl: "https://judge.example.test/",
	kind: "judge",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 128_000,
	maxTokens: 4096,
} as Model<Api>;

afterEach(() => vi.restoreAllMocks());

const METRICS = createMCPToolName("netdata", "query_metrics");
const RESTART = createMCPToolName("coolify", "restart_app");

function device(name: string, description: string, mcpServerName?: string): AgentTool {
	return {
		name,
		label: name,
		description,
		parameters: Type.Object({ node: Type.String() }),
		execute: async () => ({ content: [], details: {} }),
		...(mcpServerName && { mcpServerName, mcpToolName: name }),
	};
}

/** A session with omp's own `ast_grep` and `debug` and two MCP server tools mounted under `xd://`. */
function source(enabled: string[] = ["read", "write"]): ToolPreflightSource {
	const tools = [
		device("ast_grep", "Structural code search with AST patterns"),
		device("debug", "Debug a running process with breakpoints"),
		device(METRICS, "Query CPU and memory metrics for a node", "netdata"),
		device(RESTART, "Restart a deployed application", "coolify"),
	];
	const xdev: XdevState = {
		tools: new Map(tools.map(tool => [tool.name, tool])),
		mountedNames: new Set(tools.map(tool => tool.name)),
		builtInNames: new Set(["ast_grep", "debug"]),
		isActive: name => enabled.includes(name),
	};
	return { xdev, enabledNames: [...enabled, ...tools.map(tool => tool.name)] };
}

function judgeDeps(config: Record<string, unknown>) {
	const authStorage = createInMemoryAuthStorage();
	authStorage.keys.setRuntime("typesafe", "ts-key");
	const registry = new ModelRegistry(authStorage, "/nonexistent/decision-tools-models.yml");
	vi.spyOn(registry, "getAvailable").mockReturnValue([JEV]);
	const settings = Settings.isolated({ modelRoles: { judge: "typesafe/jev-preview" }, ...config });
	return { settings, registry };
}

interface JudgeBody {
	state: { candidates: { name: string; server: string }[] };
	questions: Record<string, unknown>;
}

/** Serve relevance Nouls by candidate name and a sufficiency Noul. */
function serveJudge(relevance: Record<string, number>, sufficient = 0.9) {
	const bodies: JudgeBody[] = [];
	vi.spyOn(globalThis, "fetch").mockImplementation(
		asGlobalFetch(async (_url, init) => {
			const body = JSON.parse(String(init?.body)) as JudgeBody;
			bodies.push(body);
			const answers: Record<string, { type: "noul"; noul: number }> = {};
			for (const id of Object.keys(body.questions)) {
				const name = body.state.candidates[Number(id.slice(1))]?.name ?? "";
				answers[id] = { type: "noul", noul: id === "sufficient" ? sufficient : (relevance[name] ?? 0.05) };
			}
			return Response.json({ model: "jev-1.13.0", answers, usage: { input_tokens: 10, output_tokens: 1 } });
		}),
	);
	return bodies;
}

async function preflight(config: Record<string, unknown>, request: string, from = source()) {
	const { settings, registry } = judgeDeps(config);
	const records: DecisionRecord[] = [];
	const result = await prepareToolPreflight({
		settings,
		source: from,
		request,
		isCurrent: () => true,
		judge: { settings, registry },
		onRecord: record => records.push(record),
	});
	return { result, records };
}

const automatic = { "decision.backend": "judge", "decision.tools.mode": "automatic" };

describe("tool preflight", () => {
	it("judges omp and MCP devices by server and delivers selected contracts once", async () => {
		const bodies = serveJudge({ [METRICS]: 0.95, ast_grep: 0.2 });
		const { result, records } = await preflight(automatic, "query cpu metrics for the web node");
		expect(result.selected).toEqual([METRICS]);
		expect(records[0]).toMatchObject({ feature: "tools", reason: "selected", selected: [METRICS] });
		const servers = Object.fromEntries(bodies[0]!.state.candidates.map(item => [item.name, item.server]));
		expect(servers[METRICS]).toBe("netdata");

		const messages = toolPreflightMessages(result, [], 64 * 1024);
		expect(messages.map(message => message.role === "custom" && message.customType)).toEqual([
			TOOL_CONTRACT_MESSAGE_TYPE,
		]);
		const content = messages[0]?.role === "custom" ? String(messages[0].content) : "";
		expect(content).toContain(`Execute by writing JSON to xd://${METRICS}`);
		// Same id and schema revision already in context: nothing is sent again.
		expect(toolPreflightMessages(result, messages, 64 * 1024)).toEqual([]);
	});

	it("selects nothing when the judge doubts the shortlist covers the task", async () => {
		serveJudge({ [METRICS]: 0.95 }, 0.2);
		const { result, records } = await preflight(automatic, "query cpu metrics for the web node");
		expect(result).toEqual({ selected: [], contracts: [] });
		expect(records[0]?.reason).toBe("insufficient");
	});

	it("suggest names the selection without contracts; deterministic takes only named tools", async () => {
		serveJudge({ [RESTART]: 0.9 });
		const suggested = await preflight(
			{ "decision.backend": "judge", "decision.tools.mode": "suggest" },
			"restart the deployed application",
		);
		expect(suggested.result).toEqual({ selected: [RESTART], contracts: [] });
		const hint = toolPreflightMessages(suggested.result, [], 64 * 1024);
		expect(hint.map(message => message.role === "custom" && message.customType)).toEqual([TOOL_HINT_MESSAGE_TYPE]);

		const fetchSpy = vi.spyOn(globalThis, "fetch");
		fetchSpy.mockClear();
		const named = await preflight(
			{ "decision.backend": "deterministic", "decision.tools.mode": "automatic" },
			`run xd://${METRICS} for the web node`,
		);
		expect(named.result.selected).toEqual([METRICS]);
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("has no candidates without the read and write device transport", async () => {
		const fetchSpy = vi.spyOn(globalThis, "fetch");
		const { result, records } = await preflight(automatic, "query cpu metrics", source(["read"]));
		expect(result).toEqual({ selected: [], contracts: [] });
		expect(records[0]).toMatchObject({ reason: "no_candidates", candidates: 0 });
		expect(fetchSpy).not.toHaveBeenCalled();
	});

	it("keeps a candidate only at the relevance threshold", async () => {
		serveJudge({ [METRICS]: 0.7, [RESTART]: 0.69 });
		const { result } = await preflight(automatic, "query cpu metrics, then restart the deployed application");
		expect(result.selected).toEqual([METRICS]);
	});

	it("pins only an xd:// URL or a backticked exact name, never a bare word", async () => {
		const deterministic = { "decision.backend": "deterministic", "decision.tools.mode": "automatic" };
		expect((await preflight(deterministic, "debug why the login test fails")).result.selected).toEqual([]);
		expect((await preflight(deterministic, "use xd://debugger on the login test")).result.selected).toEqual([]);
		expect((await preflight(deterministic, "attach `debug` to the login test")).result.selected).toEqual(["debug"]);
		expect((await preflight(deterministic, "attach xd://debug, then rerun")).result.selected).toEqual(["debug"]);

		// A failed judgment keeps only pinned tools, so a bare word selects nothing.
		vi.spyOn(globalThis, "fetch").mockImplementation(
			asGlobalFetch(async () => new Response("down", { status: 503 })),
		);
		const failed = await preflight(automatic, "debug why the login test fails");
		expect(failed.result.selected).toEqual([]);
		expect(failed.records[0]?.reason).toBe("judge_unavailable");
	});

	it("shadow ranks after returning and only records", async () => {
		serveJudge({ [METRICS]: 0.95 });
		const { settings, registry } = judgeDeps({ "decision.backend": "judge", "decision.tools.mode": "shadow" });
		const recorded = Promise.withResolvers<DecisionRecord>();
		const result = await prepareToolPreflight({
			settings,
			source: source(),
			request: "query cpu metrics for the web node",
			isCurrent: () => true,
			judge: { settings, registry },
			onRecord: recorded.resolve,
		});
		expect(result).toEqual({ selected: [], contracts: [] });
		expect(await recorded.promise).toMatchObject({ mode: "shadow", reason: "shadow: selected", selected: [METRICS] });
	});
});

describe("toolPreflightMessages", () => {
	const contract = (id: string, revision: string, bytes = 100): ToolContract => ({
		id,
		revision,
		body: "x".repeat(bytes),
	});
	const sent = (id: string, revision: string) =>
		toolPreflightMessages({ selected: [id], contracts: [contract(id, revision)] }, [], 64 * 1024);

	const cases: {
		name: string;
		contracts: ToolContract[];
		history?: AgentMessage[];
		budget?: number;
		expected: string[];
	}[] = [
		{ name: "delivers fitting contracts without a hint", contracts: [contract("a", "1")], expected: ["contract:a"] },
		{ name: "skips a contract already sent", contracts: [contract("a", "1")], history: sent("a", "1"), expected: [] },
		{
			name: "re-sends after a schema change",
			contracts: [contract("a", "2")],
			history: sent("a", "1"),
			expected: ["contract:a"],
		},
		{
			name: "omits a contract over the per-contract cap and names it",
			contracts: [contract("a", "1", TOOL_PREFLIGHT_POLICY.contractBytes + 1), contract("b", "1")],
			expected: ["contract:b", "hint"],
		},
		{
			name: "omits what the shared budget cannot hold and names it",
			contracts: [contract("a", "1", 1_000), contract("b", "1", 1_000)],
			budget: 2_000,
			expected: ["contract:a", "hint"],
		},
		{ name: "hints when no contract was prepared", contracts: [], expected: ["hint"] },
	];
	it.each(cases)("$name", ({ contracts, history = [], budget = 64 * 1024, expected }) => {
		const selected = contracts.length > 0 ? contracts.map(item => item.id) : ["a"];
		const messages = toolPreflightMessages({ selected, contracts }, history, budget);
		expect(
			messages.map(message =>
				message.role === "custom" && isRecord(message.details) ? `contract:${message.details.id}` : "hint",
			),
		).toEqual(expected);
	});
});
