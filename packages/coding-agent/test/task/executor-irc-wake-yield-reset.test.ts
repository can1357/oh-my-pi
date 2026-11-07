import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AsyncJobManager } from "@oh-my-pi/pi-coding-agent/async/job-manager";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { ArtifactManager } from "@oh-my-pi/pi-coding-agent/session/artifacts";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { AgentSession, AgentSessionEvent } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { YieldTool } from "@oh-my-pi/pi-coding-agent/tools/yield";
import { attachIrcWakeTurnMonitor } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { createSessionDefaults } from "../helpers/session-defaults";

function toolSession(overrides: Partial<ToolSession> = {}): ToolSession {
	return {
		cwd: "/tmp",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		...overrides,
	};
}

const wakeAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("IRC wake turn yield reset", () => {
	it("retains the typed partial report when a real wake job rejects a schema-invalid result", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-wake-report-"));
		const artifacts = new ArtifactManager(root);
		const manager = new AsyncJobManager({});
		const childManager = SessionManager.inMemory(root);
		childManager.adoptArtifactManager(artifacts);
		AgentRegistry.resetGlobalForTests();
		try {
			let observer: ((records: unknown[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined;
			const listeners = new Set<(event: AgentSessionEvent) => void>();
			const session = {
				...createSessionDefaults(),
				sessionManager: childManager,
				asyncJobManager: manager,
				subscribe: (listener: (event: AgentSessionEvent) => void) => {
					listeners.add(listener);
					return () => {
						listeners.delete(listener);
					};
				},
				setIrcWakeTurnObserver: (value: typeof observer) => {
					observer = value;
				},
				trackIrcReply: () => {},
			} as unknown as AgentSession;
			AgentRegistry.global().register({
				id: "wake-report",
				displayName: "wake-report",
				kind: "sub",
				parentId: "Parent",
				session,
				status: "idle",
			});
			attachIrcWakeTurnMonitor(session, {
				id: "wake-report",
				agent: wakeAgent,
				parentArtifactManager: artifacts,
				outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
				outputSchemaMode: "strict",
			});
			if (!observer) throw new Error("wake-turn observer was not registered");
			const finish = observer([{ role: "user", content: "publish the wake report" }]);
			if (!finish) throw new Error("wake turn was not started");
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "invalid-wake-yield",
					toolName: "yield",
					isError: false,
					result: {
						content: [{ type: "text", text: "Result submitted." }],
						details: { status: "success", data: { ok: "wake-invalid-value" } },
					},
				});
			}
			// The observer itself creates and rejects the AsyncJobError; the test never constructs one.
			await finish();
			await manager.waitForAll();
			const job = manager.getJob("wake-report");
			expect(job?.status).toBe("failed");
			expect(job?.structured).toMatchObject({ status: "invalid", data: { ok: "wake-invalid-value" } });
			expect(job?.errorText).toContain("schema_violation");
			expect(job?.report).toMatchObject({ status: "partial", reason: "schema-invalid" });
			const report = job?.report;
			if (!report?.artifact) throw new Error("Rejected wake job lost its numeric report artifact");
			expect(report.runId).toMatch(/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i);
			expect(report.artifact.uri).toBe(`artifact://${report.artifact.id}`);
			const file = await artifacts.getPath(report.artifact.id);
			if (!file) throw new Error("Rejected wake report cannot be recovered");
			expect(await Bun.file(file).text()).toContain("wake-invalid-value");
		} finally {
			await manager.dispose();
			await childManager.close();
			AgentRegistry.resetGlobalForTests();
			AsyncJobManager.resetForTests();
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("re-arms the empty-last-turn guard at the start of an autonomous wake turn", async () => {
		// The same kept-alive session tool that runSubagentFollowUpTurn reuses is
		// also driven by autonomous IRC wake turns through this observer. A prior
		// run that emitted an incremental section leaves #hasIncrementalSections
		// set; without a per-wake reset a later thinking-only {type:"result"}
		// would skip the guard and finalize with the null-yield warning.
		const yieldTool = new YieldTool(toolSession({ getLastAssistantText: () => undefined }));
		let observer: ((records: unknown[]) => ((error?: unknown) => void | Promise<void>) | undefined) | undefined;
		const session = {
			...createSessionDefaults(),
			getToolByName: (name: string) => (name === "yield" ? yieldTool : undefined),
			subscribe: () => () => {},
			setIrcWakeTurnObserver: (obs: typeof observer) => {
				observer = obs;
			},
			trackIrcReply: () => {},
		} as unknown as AgentSession;

		attachIrcWakeTurnMonitor(session, { id: "wake-1", agent: wakeAgent });
		if (!observer) throw new Error("wake-turn observer was not registered");

		// A prior run's incremental section sets the flag on the reused tool.
		await yieldTool.execute("prior-section", { type: ["findings"], data: "one finding" } as never);

		// Starting the wake turn must clear it.
		observer([{ role: "user", content: "wake up" }]);

		await expect(yieldTool.execute("wake-empty", { type: "result" } as never)).rejects.toThrow(
			/no text \(thinking only\)/,
		);
	});
});
