/**
 * `buildJobResult` structured-output rendering (`hub wait`/`jobs`/`cancel`
 * text). Regression coverage: valid results must not inline a truncated JSON
 * block (breaks async-result.md's contract of pointing to `agent://<id>`
 * instead, and can emit invalid JSON once truncated at 4k), and any result
 * carrying data must advertise the `agent://<id>` handle (PR #10625 review).
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import type { AsyncJobRunResult } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { IrcBus } from "@oh-my-pi/pi-coding-agent/irc/bus";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import type { StructuredSubagentOutput } from "@oh-my-pi/pi-coding-agent/task/types";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { HubTool } from "@oh-my-pi/pi-coding-agent/tools/hub";

const SELF_ID = "Main";

function makeSession(manager: AsyncJobManager): ToolSession {
	const stub = {
		cwd: process.cwd(),
		settings: {
			get(key: string): unknown {
				if (key === "async.pollWaitDuration") return "5m";
				if (key === "irc.timeoutMs") return 120_000;
				return undefined;
			},
		},
		agentRegistry: AgentRegistry.global(),
		asyncJobManager: manager,
		getAgentId: () => SELF_ID,
	};
	// Structurally-partial test session: HubTool only touches the fields above.
	return stub as unknown as ToolSession;
}

/** Register a job that immediately settles with the given text + structured payload. */
function registerSettledJob(
	manager: AsyncJobManager,
	label: string,
	text: string,
	structured: StructuredSubagentOutput,
	agentId?: string,
): string {
	return manager.register("task", label, async () => ({ text, structured }), { ownerId: SELF_ID, agentId });
}

describe("hub jobs structured output rendering", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});
	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		IrcBus.resetGlobalForTests();
	});

	test("a schema-valid result advertises the agent:// pointer instead of inlining JSON", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = registerSettledJob(
			manager,
			"ValidJob",
			"<task-result>done</task-result>",
			{ source: "agent", mode: "permissive", status: "valid", data: { ok: true, count: 7 } },
			"ValidJob",
		);
		const tool = new HubTool(makeSession(manager));

		const result = await tool.execute("call_1", { op: "wait", ids: [jobId] });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Structured output: schema valid");
		expect(text).toContain("full payload at agent://ValidJob");
		expect(text).toContain("fields via agent://ValidJob?q=.<field>");
		// The truncated inline JSON block must not appear for a valid result.
		expect(text).not.toContain("```json");
	});

	test("a schema-invalid result keeps the truncated JSON preview alongside the pointer", async () => {
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const jobId = registerSettledJob(
			manager,
			"InvalidJob",
			"<task-result>done</task-result>",
			{ source: "agent", mode: "permissive", status: "invalid", data: { wrong: "shape" }, error: "missing field" },
			"InvalidJob",
		);
		const tool = new HubTool(makeSession(manager));

		const result = await tool.execute("call_2", { op: "wait", ids: [jobId] });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain("Structured output: schema invalid: missing field");
		expect(text).toContain("full payload at agent://InvalidJob");
		expect(text).toContain("```json");
		expect(text).toContain('"wrong": "shape"');
	});

	test("advertises the disambiguated agentId, not the collision-suffixed job id", async () => {
		// A task job can reuse a vibe turn's job id, forcing the manager to
		// suffix `jobId` (e.g. `Foo` -> `Foo-2`) while the task's artifacts
		// are still written under its own agent id.
		const manager = new AsyncJobManager({ onJobComplete: () => {} });
		const { promise: hangs } = Promise.withResolvers<AsyncJobRunResult>();
		manager.register("task", "collider", async () => hangs, { ownerId: SELF_ID, id: "Foo" });
		const jobId = registerSettledJob(
			manager,
			"Foo",
			"<task-result>done</task-result>",
			{ source: "agent", mode: "permissive", status: "valid", data: { ok: true } },
			"Foo",
		);
		expect(jobId).not.toBe("Foo");
		const tool = new HubTool(makeSession(manager));

		const result = await tool.execute("call_3", { op: "wait", ids: [jobId] });
		const text = result.content[0]?.type === "text" ? result.content[0].text : "";

		expect(text).toContain(`full payload at agent://Foo,`);
	});
});
