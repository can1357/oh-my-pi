import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Context } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { runPrintMode } from "@oh-my-pi/pi-coding-agent/modes/print-mode";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { createTools, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { Snowflake } from "@oh-my-pi/pi-utils";

// Regression for #8272: with plan.defaultOnStartup:true, a headless `omp -p`
// used to arm plan mode before the initial prompt. The only headless plan-exit
// was a watcher that fires on a successful `xd://propose` execute-dispatch, so a
// model that never emits exactly that dispatch (the natural plan-mode behavior:
// keep trying to finalize the plan) left the turn hanging until the deadline.
//
// The mock below mirrors that: while plan mode is enabled it keeps attempting to
// finalize a plan (write xd://propose) without a plan artifact, which errors and
// never produces the propose/execute dispatch. Out of plan mode it answers.
describe("print mode + plan.defaultOnStartup (#8272)", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let stdoutOutput: string[];

	const holder: { session?: AgentSession } = {};

	beforeEach(async () => {
		tempDir = path.join(os.tmpdir(), `omp-8272-${Snowflake.next()}`);
		fs.mkdirSync(tempDir, { recursive: true });
		stdoutOutput = [];
		vi.spyOn(process.stdout, "write").mockImplementation((...args: unknown[]) => {
			const chunk = args[0];
			if (typeof chunk === "string") stdoutOutput.push(chunk);
			const last = args[args.length - 1];
			if (typeof last === "function") (last as () => void)();
			return true;
		});
		vi.spyOn(process.stderr, "write").mockImplementation(() => true);

		const settingsOverrides = { "plan.defaultOnStartup": true, "plan.enabled": true } as const;
		const toolSession: ToolSession = {
			cwd: tempDir,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated(settingsOverrides),
		};
		const tools = await createTools(toolSession);

		const model = createMockModel({
			id: "mock-plan",
			handler: (_context: Context) => {
				// Reflect the real model's plan-mode behavior: driven by the plan
				// prompt, it keeps trying to finalize a plan. Headless there is no
				// artifact and no surface to fix one, so this never succeeds.
				if (holder.session?.getPlanModeState?.()?.enabled) {
					return {
						content: [
							{ type: "toolCall", name: "write", arguments: { path: "xd://propose", content: "the-plan" } },
						],
					};
				}
				return { content: ["OK"] };
			},
		});
		const agent = new Agent({
			getApiKey: () => "mock-key",
			initialState: { model, systemPrompt: ["Test"], tools },
			streamFn: (m, context, options) => model.stream(m, context, options),
		});

		authStorage = await AuthStorage.create(path.join(tempDir, "auth.db"));
		authStorage.setRuntimeApiKey("mock", "mock-key");
		const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir, "models.yml"));
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated(settingsOverrides),
			modelRegistry,
		});
		holder.session = session;
	});

	afterEach(async () => {
		await session.abort().catch(() => {});
		await session.dispose().catch(() => {});
		authStorage.close();
		if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
		vi.restoreAllMocks();
		holder.session = undefined;
	});

	it("completes the turn and prints output instead of hanging to the deadline", async () => {
		// If the startup default re-armed plan mode, the mock would loop on
		// `xd://propose` forever and this await would never resolve — the runner's
		// own per-test timeout then fails it, exactly the #8272 symptom.
		await runPrintMode(session, { mode: "text", initialMessage: "Reply with exactly: OK" });

		expect(stdoutOutput.join("")).toContain("OK");
		expect(session.getPlanModeState()).toBeUndefined();
	});
});
