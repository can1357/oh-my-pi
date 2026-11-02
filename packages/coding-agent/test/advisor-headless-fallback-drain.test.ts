/**
 * Contract: the print-mode advisor drain (`waitForAdvisorCatchup` with
 * `waitThroughRecovery`, run before disposing the session) waits through a
 * failing advisor's `retry.fallbackChains` recovery. A regression abandons the
 * review the moment the primary advisor model fails: the drain reports an
 * incomplete catch-up, disposal aborts the fallback switch mid-flight, and the
 * configured backup reviewer never runs.
 *
 * The default drain (subagent teardown, 5s shared with `dispose()`) must keep
 * releasing at once on a failing advisor; a regression parks it through
 * recovery and pushes session teardown past its cleanup deadline.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Agent } from "@oh-my-pi/pi-agent-core";
import type { Api, AssistantMessageEventStream, Context, Model, SimpleStreamOptions } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

const PRIMARY_ADVISOR = "claude-sonnet-4-5";
const BACKUP_ADVISOR = "claude-opus-4-5";

describe("headless advisor drain with a fallback reviewer", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	beforeAll(() => {
		tempDir = TempDir.createSync("@pi-advisor-fallback-drain-");
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			authStorage?.close();
			authStorage = undefined;
		}
	});

	afterAll(async () => {
		await tempDir?.remove();
	});

	async function startSessionWithFailingAdvisor(backupDelayMs = 0) {
		const primaryModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!primaryModel) throw new Error("Expected bundled anthropic/claude-sonnet-4-5");
		if (!getBundledModel("anthropic", BACKUP_ADVISOR))
			throw new Error(`Expected bundled anthropic/${BACKUP_ADVISOR}`);

		const primary = createMockModel({ responses: [{ content: ["primary answer"], stopReason: "stop" }] });
		// The configured advisor endpoint is down: every call fails like an outage.
		const unavailableAdvisor = createMockModel({
			handler: () => ({ stopReason: "error", errorMessage: "503 Service Unavailable: upstream connect error" }),
		});
		const backupAdvisor = createMockModel({
			handler: () => ({ content: [], stopReason: "stop", delayMs: backupDelayMs }),
		});
		const advisorStreamFn = (
			model: Model<Api>,
			context: Context,
			options?: SimpleStreamOptions,
		): AssistantMessageEventStream =>
			model.id === BACKUP_ADVISOR
				? backupAdvisor.stream(model, context, options)
				: unavailableAdvisor.stream(model, context, options);

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: primaryModel, systemPrompt: ["Test"], tools: [] },
			streamFn: primary.stream,
		});
		const settings = Settings.isolated({
			"compaction.enabled": false,
			"retry.baseDelayMs": 1,
			"retry.fallbackChains": { advisor: [`anthropic/${BACKUP_ADVISOR}`] },
		});
		settings.setModelRole("advisor", `anthropic/${PRIMARY_ADVISOR}`);
		authStorage = await AuthStorage.create(":memory:");
		authStorage.keys.setRuntime("anthropic", "test-key");
		const advised = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings,
			modelRegistry: new ModelRegistry(authStorage, tempDir.join("models.yml")),
			advisorTools: [],
			advisorStreamFn,
		});
		session = advised;
		expect(advised.setAdvisorEnabled(true)).toBe(true);

		advised.prepareForHeadlessAdvisorDrain();
		await advised.prompt("answer in one line");
		return { advised, unavailableAdvisor, backupAdvisor };
	}

	it("waits for the fallback advisor model to finish the review before reporting catch-up", async () => {
		const { advised, unavailableAdvisor, backupAdvisor } = await startSessionWithFailingAdvisor();

		expect(await advised.waitForAdvisorCatchup(10_000, { waitThroughRecovery: true })).toBe(true);
		expect(unavailableAdvisor.calls.length).toBeGreaterThanOrEqual(1);
		expect(backupAdvisor.calls).toHaveLength(1);
	}, 20_000);

	it("releases the default drain promptly while fallback recovery is still running", async () => {
		// The backup reviewer hangs until disposal aborts it, so only the
		// deadline could release a drain that waits through recovery.
		const { advised } = await startSessionWithFailingAdvisor(60_000);

		const started = performance.now();
		expect(await advised.waitForAdvisorCatchup(10_000)).toBe(false);
		expect(performance.now() - started).toBeLessThan(2_000);
	}, 20_000);
});
