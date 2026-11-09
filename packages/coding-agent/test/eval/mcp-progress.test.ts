import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import type { AgentTool, AgentToolUpdateCallback } from "@oh-my-pi/pi-agent-core";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { disposeAllVmContexts } from "@oh-my-pi/pi-coding-agent/eval/js/context-manager";
import { callSessionTool } from "@oh-my-pi/pi-coding-agent/eval/js/tool-bridge";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool } from "@oh-my-pi/pi-coding-agent/tools/eval";
import type { EvalStatusEvent, EvalToolDetails } from "@oh-my-pi/pi-tui/tools/eval";
import type { MCPProgress } from "@oh-my-pi/pi-tui/tools/mcp";
import { setAgentDir, TempDir, untilAborted } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

let temp: TempDir;
let settingsState: SettingsTestState;
const managers: AsyncJobManager[] = [];

beforeEach(() => {
	settingsState = beginSettingsTest();
	temp = TempDir.createSync("@eval-mcp-progress-");
	setAgentDir(path.join(temp.path(), "agent"));
});

afterEach(async () => {
	await Promise.all(managers.splice(0).map(manager => manager.dispose()));
	await disposeAllVmContexts();
	restoreSettingsTestState(settingsState);
	temp.removeSync();
});

function makeSession(tool: AgentTool): ToolSession {
	const id = `mcp-progress-${crypto.randomUUID()}`;
	return {
		cwd: temp.path(),
		hasUI: false,
		settings: Settings.isolated({ "async.enabled": false, "eval.autoProvision": false }),
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => null,
		getSessionId: () => id,
		getEvalSessionId: () => id,
		getToolByName: name => (name === tool.name ? tool : undefined),
	};
}

function gatedMcpTool(heartbeat = false) {
	const gate = Promise.withResolvers<void>();
	let update: AgentToolUpdateCallback | undefined;
	const report = (progress: MCPProgress) =>
		update?.({
			content: [{ type: "text", text: progress.message ?? "working" }],
			details: { progress },
		});
	const tool: AgentTool & { mcpServerName: string } = {
		name: "mcp__fixture_progress",
		label: "MCP fixture",
		description: "A gated MCP call",
		parameters: type({}),
		mcpServerName: "fixture",
		async execute(_id, _args, signal, onUpdate) {
			update = onUpdate;
			report({ progress: 1, total: 4, message: "connecting" });
			let amount = 1;
			const timer = heartbeat
				? setInterval(() => report({ progress: ++amount, message: "working" }), 20)
				: undefined;
			try {
				await untilAborted(signal, () => gate.promise);
				return { content: [{ type: "text", text: "complete" }], details: { final: true } };
			} finally {
				clearInterval(timer);
			}
		},
	};
	return { tool, release: gate.resolve, report };
}

// The real Bun worker has its own clock; host fake timers cannot drive its status frames or watchdog.
async function poll(predicate: () => boolean): Promise<boolean> {
	const deadline = Date.now() + 600;
	while (!predicate() && Date.now() < deadline) await Bun.sleep(5);
	return predicate();
}

function progressEvents(details: EvalToolDetails | undefined): EvalStatusEvent[] {
	return details?.cells?.flatMap(cell => cell.statusEvents ?? []).filter(event => event.op === "mcp_progress") ?? [];
}

async function warm(tool: EvalTool): Promise<void> {
	await tool.execute("warm", { language: "js", code: "print('ready')", timeout: 0 });
}

describe("MCP progress through the shared Eval tool bridge", () => {
	it("streams progress into a real JS Eval card before the cell completes", async () => {
		const mcp = gatedMcpTool();
		const evalTool = new EvalTool(makeSession(mcp.tool));
		await warm(evalTool);
		const frames: EvalToolDetails[] = [];
		const pending = evalTool.execute(
			"foreground",
			{
				language: "js",
				code: "print(await tool.mcp__fixture_progress({}))",
				timeout: 0,
			},
			undefined,
			partial => {
				if (partial.details) frames.push(structuredClone(partial.details));
			},
		);
		try {
			expect(await poll(() => frames.some(frame => progressEvents(frame).length > 0))).toBe(true);
			const frame = frames.find(frame => progressEvents(frame).length > 0);
			expect(frame?.cells?.[0]?.status).toBe("running");
			expect(progressEvents(frame)).toEqual([
				expect.objectContaining({
					op: "mcp_progress",
					tool: mcp.tool.name,
					progress: 1,
					total: 4,
					message: "connecting",
				}),
			]);
		} finally {
			mcp.release();
			await pending;
		}
		const final = await pending;
		expect(final.details?.cells?.[0]?.status).toBe("complete");
		expect(final.details?.cells?.[0]?.output).toContain("complete");
		// Status events are stored once, on the cell that produced them.
		expect(progressEvents(final.details).length).toBeGreaterThan(0);
		expect(final.details?.statusEvents).toBeUndefined();
	});

	it("keeps streaming MCP status into running job frames after auto-backgrounding", async () => {
		const mcp = gatedMcpTool();
		const session = makeSession(mcp.tool);
		await warm(new EvalTool(session));
		const manager = new AsyncJobManager({});
		managers.push(manager);
		const evalTool = new EvalTool({
			...session,
			asyncJobManager: manager,
			settings: Settings.isolated({
				"eval.autoProvision": false,
				"eval.autoBackground.enabled": true,
				"eval.autoBackground.thresholdMs": 10,
			}),
		});
		const frames: EvalToolDetails[] = [];
		try {
			const result = await evalTool.execute(
				"background",
				{
					language: "js",
					code: "print(await tool.mcp__fixture_progress({}))",
					timeout: 0,
				},
				undefined,
				partial => {
					if (partial.details) frames.push(structuredClone(partial.details));
				},
			);
			expect(result.details?.async?.state).toBe("running");
			const start = frames.length;
			expect(
				await poll(() => {
					mcp.report({ progress: 2, total: 4, message: "fetching after background" });
					return frames
						.slice(start)
						.some(
							frame =>
								frame.async?.state === "running" &&
								progressEvents(frame).some(event => event.message === "fetching after background"),
						);
				}),
			).toBe(true);
		} finally {
			mcp.release();
			await manager.waitForAll();
		}
	});

	it("still times out an MCP call that continuously reports progress", async () => {
		const mcp = gatedMcpTool(true);
		const evalTool = new EvalTool(makeSession(mcp.tool));
		await warm(evalTool);
		const frames: EvalToolDetails[] = [];
		try {
			const result = await evalTool.execute(
				"timeout",
				{
					language: "js",
					code: "await tool.mcp__fixture_progress({})",
					timeout: 1,
				},
				undefined,
				partial => {
					if (partial.details) frames.push(structuredClone(partial.details));
				},
			);
			expect(result.details?.cells?.[0]?.output).toContain("timed out");
			expect(result.details?.cells?.[0]?.status).toBe("error");
			expect(frames.filter(frame => progressEvents(frame).length > 0).length).toBeGreaterThan(3);
		} finally {
			mcp.release();
		}
	}, 5000);

	it("ignores invalid partials and late callbacks while preserving the bridge return and final summary", async () => {
		let update: AgentToolUpdateCallback | undefined;
		const mcp = gatedMcpTool();
		mcp.tool.execute = async (_id, _args, _signal, onUpdate) => {
			update = onUpdate;
			for (const progress of [undefined, {}, { progress: Infinity }, { progress: "1" }]) {
				onUpdate?.({ content: [], details: { progress } });
			}
			onUpdate?.({ content: [], details: { progress: { progress: 0, total: Infinity, message: 4 } } });
			return { content: [{ type: "text", text: "complete" }], details: { final: true } };
		};
		const events: EvalStatusEvent[] = [];
		const result = await callSessionTool(
			mcp.tool.name,
			{},
			{
				session: makeSession(mcp.tool),
				emitStatus: event => events.push(event),
			},
		);
		expect(result).toEqual({ text: "complete", details: { final: true } });
		expect(events).toHaveLength(2);
		expect(events[0]).toEqual({ op: "mcp_progress", id: expect.any(String), tool: mcp.tool.name, progress: 0 });
		expect(events[1]).toMatchObject({ op: mcp.tool.name });
		update?.({ content: [], details: { progress: { progress: 9 } } });
		expect(events).toHaveLength(2);
	});

	it("does not opt ordinary tools or sinkless MCP calls into progress", async () => {
		for (const mcpShaped of [false, true]) {
			const mcp = gatedMcpTool();
			if (!mcpShaped) Reflect.deleteProperty(mcp.tool, "mcpServerName");
			let callback: AgentToolUpdateCallback | undefined;
			mcp.tool.execute = async (_id, _args, _signal, onUpdate) => {
				callback = onUpdate;
				return { content: [{ type: "text", text: "complete" }] };
			};
			await callSessionTool(
				mcp.tool.name,
				{},
				{
					session: makeSession(mcp.tool),
					emitStatus: mcpShaped ? undefined : () => {},
				},
			);
			expect(callback).toBeUndefined();
		}
	});
});
