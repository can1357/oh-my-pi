/**
 * Regression coverage for the `<id>.json` structured-output sidecar
 * lifecycle: a replacement write failure must not leave a stale sidecar from
 * an earlier turn answering `agent://<id>/<field>` with superseded data, and
 * a schema-invalid yield with parsed data must still get a sidecar so its
 * full payload stays recoverable via `agent://<id>` (PR #10625 review).
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { CreateAgentSessionResult } from "@oh-my-pi/pi-coding-agent/sdk";
import type { LoadExtensionsResult } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/types";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession, AgentSessionEvent, PromptOptions } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { runSubprocess } from "@oh-my-pi/pi-coding-agent/task/executor";
import type { AgentDefinition } from "@oh-my-pi/pi-coding-agent/task/types";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";

function createMockSession(onPrompt: (params: { emit: (event: AgentSessionEvent) => void }) => void): AgentSession {
	const listeners: Array<(event: AgentSessionEvent) => void> = [];
	const emit = (event: AgentSessionEvent) => {
		for (const listener of listeners) listener(event);
	};
	const session = {
		state: { messages: [] },
		agent: { state: { systemPrompt: ["test"] } },
		model: undefined,
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["read", "yield"],
		getEnabledToolNames: () => ["read", "yield"],
		setActiveToolsByName: async (_toolNames: string[]) => {},
		subscribe: (listener: (event: AgentSessionEvent) => void) => {
			listeners.push(listener);
			return () => {
				const index = listeners.indexOf(listener);
				if (index >= 0) listeners.splice(index, 1);
			};
		},
		prompt: async (_text: string, _options?: PromptOptions) => {
			onPrompt({ emit });
		},
		waitForIdle: async () => {},
		prepareForHeadlessAdvisorDrain: () => {},
		waitForAdvisorCatchup: async () => true,
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
		setIrcWakeTurnObserver: () => {},
		subscribeRunState: () => () => {},
	};
	return session as unknown as AgentSession;
}

function yieldEmittingSession(data: unknown): AgentSession {
	return createMockSession(({ emit }) => {
		emit({
			type: "tool_execution_end",
			toolCallId: "tool-sidecar",
			toolName: "yield",
			result: {
				content: [{ type: "text", text: "Result submitted." }],
				details: { status: "success", data },
			},
			isError: false,
		});
	});
}

function createSessionResult(session: AgentSession): CreateAgentSessionResult {
	return {
		session,
		extensionsResult: { extensions: [], errors: [], runtime: {} as unknown } as unknown as LoadExtensionsResult,
		setToolUIContext: () => {},
		eventBus: new EventBus(),
	};
}

const baseAgent: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

describe("structured output sidecar lifecycle", () => {
	let artifactsDir: string | undefined;

	afterEach(async () => {
		vi.restoreAllMocks();
		if (artifactsDir) await fs.rm(artifactsDir, { recursive: true, force: true });
		artifactsDir = undefined;
	});

	it("drops a stale sidecar instead of leaving it behind when the replacement write fails", async () => {
		artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidecar-test-"));
		const id = "SidecarProbe";
		const sidecarPath = path.join(artifactsDir, `${id}.json`);
		await fs.writeFile(sidecarPath, JSON.stringify({ summary: "stale from an earlier turn" }));

		const session = yieldEmittingSession({ ok: true });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const originalWrite = Bun.write.bind(Bun);
		vi.spyOn(Bun, "write").mockImplementation(((dest: unknown, ...rest: unknown[]) => {
			if (typeof dest === "string" && dest.includes(`${id}.json.tmp-`)) {
				return Promise.reject(new Error("simulated disk failure"));
			}
			return (originalWrite as (...args: unknown[]) => unknown)(dest, ...rest);
		}) as typeof Bun.write);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.exitCode).toBe(0);
		expect(result.structuredOutput).toMatchObject({ status: "valid", data: { ok: true } });
		// The <id>.md artifact republished successfully...
		expect(result.outputPath).toBe(path.join(artifactsDir, `${id}.md`));
		// ...but the sidecar write failed, so the stale sidecar must not survive
		// to keep answering agent://<id>/<field> with the superseded payload.
		await expect(fs.stat(sidecarPath)).rejects.toThrow();
	});

	it("removes a stale sidecar instead of leaving it when the serialized data is undefined", async () => {
		// Regression: `Object.hasOwn(structured, "data")` can be true while
		// `JSON.stringify(structured.data, null, 2)` itself returns
		// `undefined` (e.g. `structured.data === undefined`) — previously
		// neither a write nor a removal happened, leaving a stale sidecar
		// from an earlier turn behind (PR #10625 review).
		artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidecar-test-"));
		const id = "UndefinedDataProbe";
		const sidecarPath = path.join(artifactsDir, `${id}.json`);
		await fs.writeFile(sidecarPath, JSON.stringify({ summary: "stale from an earlier turn" }));

		const session = yieldEmittingSession({ ok: true });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const originalStringify = JSON.stringify.bind(JSON);
		vi.spyOn(JSON, "stringify").mockImplementation(((value: unknown, ...rest: unknown[]) => {
			// Narrowly target only the yielded `{ ok: true }` payload so other
			// concurrent JSON.stringify calls in the pipeline are unaffected.
			if (
				value !== null &&
				typeof value === "object" &&
				!Array.isArray(value) &&
				Object.keys(value).length === 1 &&
				"ok" in value &&
				value.ok === true
			) {
				return undefined as unknown as string;
			}
			return (originalStringify as (...args: unknown[]) => unknown)(value, ...rest) as string;
		}) as typeof JSON.stringify);

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.structuredOutput?.data).toEqual({ ok: true });
		await expect(fs.stat(sidecarPath)).rejects.toThrow();
	});

	it("persists the sidecar for a schema-invalid yield that still carries parsed data", async () => {
		// Regression: previously the sidecar was written only for
		// `status === "valid"`, so an oversized invalid payload had no
		// recovery path beyond the truncated inline preview.
		artifactsDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-sidecar-test-"));
		const id = "InvalidSidecarProbe";

		// `ok` is a string, not a boolean — violates the schema below, but the
		// data still parses and must be preserved.
		const session = yieldEmittingSession({ ok: "not-a-boolean" });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: baseAgent,
			task: "do work",
			index: 0,
			id,
			settings: Settings.isolated(),
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			artifactsDir,
			outputSchema: { type: "object", properties: { ok: { type: "boolean" } }, required: ["ok"] },
		});

		expect(result.structuredOutput?.status).toBe("invalid");
		const sidecarPath = path.join(artifactsDir, `${id}.json`);
		await expect(fs.stat(sidecarPath)).resolves.toBeDefined();
		const sidecar = JSON.parse(await fs.readFile(sidecarPath, "utf-8"));
		expect(sidecar).toEqual({ ok: "not-a-boolean" });
	});
});
