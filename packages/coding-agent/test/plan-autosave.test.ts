import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "@oh-my-pi/pi-catalog/build";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { resolveLocalUrlToPath } from "@oh-my-pi/pi-coding-agent/internal-urls";
import * as modes from "@oh-my-pi/pi-coding-agent/modes";
import { getSettingsForTab } from "@oh-my-pi/pi-coding-agent/modes/components/settings-defs";
import {
	autosaveApprovedPlan,
	defaultPlanAutosaveDir,
	planSaveFileName,
	resolvePlanAutosaveDir,
} from "@oh-my-pi/pi-coding-agent/plan-mode/plan-autosave";
import type { PlanModeState } from "@oh-my-pi/pi-coding-agent/plan-mode/state";
import type { PlanYolo } from "@oh-my-pi/pi-coding-agent/session/agent-session-types";
import { PrewalkCoordinator, type PrewalkCoordinatorHost } from "@oh-my-pi/pi-coding-agent/session/prewalk";
import type { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";

let tempDir: TempDir | undefined;

beforeEach(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
});

afterEach(() => {
	tempDir?.removeSync();
	tempDir = undefined;
	resetSettingsForTest();
});

function makeCwd(): string {
	tempDir = TempDir.createSync("@pi-plan-autosave-");
	return tempDir.path();
}

describe("plan autosave settings UI", () => {
	it("gates the autosave directory on plan.autosave", () => {
		const defs = getSettingsForTab("tasks");
		const autosave = defs.find(def => def.path === "plan.autosave");
		const autosaveDir = defs.find(def => def.path === "plan.autosaveDir");
		if (!autosave?.condition || !autosaveDir?.condition) {
			throw new Error("plan autosave settings should be gated on plan mode");
		}
		// Fresh defaults: plan mode on, autosave off.
		expect(autosave.condition()).toBe(true);
		expect(autosaveDir.condition()).toBe(false);

		Settings.instance.set("plan.autosave", true);
		expect(autosaveDir.condition()).toBe(true);

		Settings.instance.set("plan.enabled", false);
		expect(autosave.condition()).toBe(false);
		expect(autosaveDir.condition()).toBe(false);
	});
	it("stays reachable from the public modes barrel", () => {
		expect(modes.planSaveFileName).toBe(planSaveFileName);
	});
});

describe("resolvePlanAutosaveDir", () => {
	it("defaults to <project>/.omp/plans when unset", () => {
		const cwd = makeCwd();
		const settings = Settings.isolated();
		expect(resolvePlanAutosaveDir(settings, cwd)).toBe(path.join(cwd, ".omp", "plans"));
		expect(defaultPlanAutosaveDir(cwd)).toBe(path.join(cwd, ".omp", "plans"));
	});

	it("resolves absolute, tilde, and cwd-relative custom dirs", () => {
		const cwd = makeCwd();
		expect(resolvePlanAutosaveDir(Settings.isolated({ "plan.autosaveDir": path.join(cwd, "custom") }), cwd)).toBe(
			path.join(cwd, "custom"),
		);
		expect(resolvePlanAutosaveDir(Settings.isolated({ "plan.autosaveDir": "~/my-plans" }), cwd)).toBe(
			path.join(os.homedir(), "my-plans"),
		);
		expect(resolvePlanAutosaveDir(Settings.isolated({ "plan.autosaveDir": "docs/plans" }), cwd)).toBe(
			path.join(cwd, "docs", "plans"),
		);
		expect(resolvePlanAutosaveDir(Settings.isolated({ "plan.autosaveDir": "   " }), cwd)).toBe(
			path.join(cwd, ".omp", "plans"),
		);
	});
});

describe("autosaveApprovedPlan", () => {
	it("writes nothing when autosave is disabled", async () => {
		const cwd = makeCwd();
		const settings = Settings.isolated();
		const result = await autosaveApprovedPlan({
			settings,
			cwd,
			title: "Auth",
			planContent: "# Plan\n",
		});
		expect(result).toBeNull();
		expect(await Bun.file(path.join(cwd, ".omp", "plans", "AUTH_PLAN.md")).exists()).toBe(false);
	});

	it("saves the approved plan under the default dir", async () => {
		const cwd = makeCwd();
		const settings = Settings.isolated({ "plan.autosave": true });
		const result = await autosaveApprovedPlan({
			settings,
			cwd,
			title: "Auth storage",
			planContent: "# Plan\n\nShip it.\n",
		});
		expect(result).toBe(path.join(cwd, ".omp", "plans", "AUTH_STORAGE_PLAN.md"));
		expect(await Bun.file(result!).text()).toBe("# Plan\n\nShip it.\n");
	});

	it("suffices colliding filenames instead of overwriting", async () => {
		const cwd = makeCwd();
		const settings = Settings.isolated({ "plan.autosave": true });
		const first = await autosaveApprovedPlan({ settings, cwd, title: "Auth", planContent: "# v1\n" });
		const second = await autosaveApprovedPlan({ settings, cwd, title: "Auth", planContent: "# v2\n" });
		expect(first).toBe(path.join(cwd, ".omp", "plans", "AUTH_PLAN.md"));
		expect(second).toBe(path.join(cwd, ".omp", "plans", "AUTH_PLAN-1.md"));
		expect(await Bun.file(first!).text()).toBe("# v1\n");
		expect(await Bun.file(second!).text()).toBe("# v2\n");
	});
	it("keeps both plans when same-titled approvals race", async () => {
		const cwd = makeCwd();
		const settings = Settings.isolated({ "plan.autosave": true });
		const [first, second] = await Promise.all([
			autosaveApprovedPlan({ settings, cwd, title: "Auth", planContent: "# v1\n" }),
			autosaveApprovedPlan({ settings, cwd, title: "Auth", planContent: "# v2\n" }),
		]);
		expect(new Set([first, second]).size).toBe(2);
		expect(new Set([await Bun.file(first!).text(), await Bun.file(second!).text()])).toEqual(
			new Set(["# v1\n", "# v2\n"]),
		);
	});

	it("skips empty plans", async () => {
		const cwd = makeCwd();
		const settings = Settings.isolated({ "plan.autosave": true });
		const result = await autosaveApprovedPlan({ settings, cwd, title: "Auth", planContent: "  \n" });
		expect(result).toBeNull();
	});
});

describe("plan-yolo approval autosave", () => {
	const target = buildModel({
		id: "test-plan-target",
		name: "Test Plan Target",
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://example.invalid",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200_000,
		maxTokens: 8_192,
	});

	function setupPlanYolo(cwd: string, artifactsDir: string, settings: Settings) {
		const notices: Array<{ level: "info" | "warning" | "error"; message: string; source?: string }> = [];
		const modelTemporaryCalls: unknown[][] = [];
		let capturedHandler: ((title: string) => Promise<unknown>) | undefined;
		let planModeState: PlanModeState | undefined;
		const localOptions = { getArtifactsDir: () => artifactsDir, getSessionId: () => "test-session" };
		const host: PrewalkCoordinatorHost = {
			agent: { steer: () => {} } as unknown as PrewalkCoordinatorHost["agent"],
			sessionManager: { getCwd: () => cwd } as unknown as SessionManager,
			settings,
			model: () => undefined,
			configuredThinkingLevel: () => undefined,
			emitNotice: (level, message, source) => {
				notices.push({ level, message, source });
			},
			setModelTemporary: async (...args: unknown[]) => {
				modelTemporaryCalls.push(args);
			},
			setActiveToolsByName: async () => {},
			restoreNonMCPToolPresentation: async () => {},
			getActiveToolNames: () => [],
			getEnabledToolNames: () => [],
			getMountedXdevToolNames: () => [],
			hasBuiltInTool: () => false,
			getPlanModeState: () => planModeState,
			setPlanModeState: state => {
				planModeState = state;
			},
			getPlanReferencePath: () => "",
			setPlanProposalHandler: handler => {
				capturedHandler = handler ?? undefined;
			},
			waitForSessionMessagePersistence: async () => {},
			localProtocolOptions: () => localOptions,
		};
		return { host, notices, modelTemporaryCalls, localOptions, getHandler: () => capturedHandler };
	}

	it("autosaves the approved plan and preserves the plan-yolo transition", async () => {
		const cwd = makeCwd();
		const artifactsDir = path.join(cwd, "artifacts");
		const settings = Settings.isolated({ "plan.autosave": true });
		const t = setupPlanYolo(cwd, artifactsDir, settings);
		const coordinator = new PrewalkCoordinator(t.host, { planYolo: { target } satisfies PlanYolo });
		await coordinator.armPlanYoloIfNeeded();
		const planPath = resolveLocalUrlToPath("local://auth-plan.md", t.localOptions);
		await Bun.write(planPath, "# Plan\n\nYolo.\n");
		const handler = t.getHandler();
		if (!handler) throw new Error("expected a plan proposal handler");
		const result = (await handler("auth")) as {
			content: Array<{ type: string; text: string }>;
			details: { planFilePath: string; title: string; planExists: boolean };
		};
		expect(result.details).toMatchObject({ planFilePath: "local://auth-plan.md", title: "auth", planExists: true });
		expect(result.content[0]?.text).toBe(`Plan approved. Implementing now with ${target.id}.`);
		expect(result.content[0]?.text).not.toContain(cwd);
		expect(await Bun.file(path.join(cwd, ".omp", "plans", "AUTH_PLAN.md")).text()).toBe("# Plan\n\nYolo.\n");
		expect(t.notices).toContainEqual({
			level: "info",
			message: expect.stringContaining("Plan autosaved to"),
			source: "plan-yolo",
		});
		expect(t.modelTemporaryCalls.length).toBe(1);
	});

	it("warns the operator but still implements when autosave fails", async () => {
		const cwd = makeCwd();
		const artifactsDir = path.join(cwd, "artifacts");
		const blocker = path.join(cwd, "blocker");
		await Bun.write(blocker, "x");
		const settings = Settings.isolated({ "plan.autosave": true, "plan.autosaveDir": path.join(blocker, "sub") });
		const t = setupPlanYolo(cwd, artifactsDir, settings);
		const coordinator = new PrewalkCoordinator(t.host, { planYolo: { target } satisfies PlanYolo });
		await coordinator.armPlanYoloIfNeeded();
		const planPath = resolveLocalUrlToPath("local://auth-plan.md", t.localOptions);
		await Bun.write(planPath, "# Plan\n\nYolo.\n");
		const handler = t.getHandler();
		if (!handler) throw new Error("expected a plan proposal handler");
		const result = (await handler("auth")) as { content: Array<{ type: string; text: string }> };
		expect(result.content[0]?.text).toBe(`Plan approved. Implementing now with ${target.id}.`);
		expect(t.modelTemporaryCalls.length).toBe(1);
		expect(t.notices).toContainEqual({
			level: "warning",
			message: expect.stringContaining("Plan autosave failed"),
			source: "plan-yolo",
		});
	});
});
