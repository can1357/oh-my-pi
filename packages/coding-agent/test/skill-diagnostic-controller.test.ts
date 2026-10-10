import { afterEach, beforeEach, expect, test, spyOn, mock } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as ai from "@oh-my-pi/pi-ai";
import * as snapshots from "../src/extensibility/resource-snapshot";
import * as decisions from "../src/extensibility/resource-decisions";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings, resetSettingsForTest } from "../src/config/settings";
import { cfgResourceExclusions, cfgUserResourceExclusions } from "../src/extensibility/resource-settings";
import { createAgentSession } from "../src/sdk";
import type { AgentSession } from "../src/session/agent-session";
import { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createAssistantMessage } from "./helpers/agent-session-setup";

let temp: TempDir;
let auth: AuthStorage;
let session: AgentSession;
let preferredRoot: string;
beforeEach(async () => {
	resetSettingsForTest();
	temp = await TempDir.create("@diagnostic-controller-");
	const root = await fs.realpath(temp.path());
	const directories = [path.join(root, "generic"), path.join(root, "adapted")];
	for (const [index, directory] of directories.entries()) {
		await Bun.write(
			path.join(directory, "review", "SKILL.md"),
			`---\nname: review\ndescription: Review behavior\n---\n${index === 1 ? "Use OMP bash to verify changes." : "Use Claude Bash to verify changes."}\n`,
		);
	}
	preferredRoot = path.join(directories[1], "review");
	auth = await AuthStorage.create(path.join(root, "auth.db"));
	auth.keys.setRuntime("anthropic", "test-key");
	const registry = new ModelRegistry(auth, path.join(root, "models.yml"));
	const model = registry.find("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Test model missing");
	spyOn(registry, "getAvailable").mockReturnValue([model]);
	const created = await createAgentSession({
		cwd: root,
		agentDir: path.join(root, "agent"),
		sessionManager: SessionManager.inMemory(root),
		modelRegistry: registry,
		model,
		settings: Settings.isolated({
			disabledProviders: ["omp-plugins", "agent-plugins", "claude-plugins"],
			modelRoles: { smol: "anthropic/claude-sonnet-4-5" },
			"skills.enablePiUser": false,
			"skills.enablePiProject": false,
			"skills.enableClaudeUser": false,
			"skills.enableClaudeProject": false,
			"skills.enableCodexUser": false,
			"skills.enableAgentsUser": false,
			"skills.enableAgentsProject": false,
			"skills.customDirectories": directories,
		}),
		disableExtensionDiscovery: true,
		enableMCP: false,
		enableLsp: false,
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		rules: [],
	});
	session = created.session;
});
afterEach(async () => {
	mock.restore();
	await session?.dispose();
	auth?.close();
	await temp?.remove();
	resetSettingsForTest();
});

function responseFor(candidates: { id: string; root: string }[]): ai.AssistantMessage {
	return createAssistantMessage(
		JSON.stringify({
			relationship: "adaptation",
			evidence: candidates.map(candidate => ({
				candidateId: candidate.id,
				file: "SKILL.md",
				quote:
					candidate.root === preferredRoot
						? "Use OMP bash to verify changes."
						: "Use Claude Bash to verify changes.",
				explanation: "Tool-specific instructions",
			})),
			differences: ["The adapted copy names OMP bash rather than Claude Bash."],
			recommendation: {
				action: "prefer",
				preferredId: candidates.find(candidate => candidate.root === preferredRoot)?.id,
				reason: "Retain the OMP-specific verification workflow.",
			},
			limitations: [],
		}),
	);
}

test("preparing a selected diagnostic discloses the plan without billing or changing selection", async () => {
	const complete = spyOn(ai, "completeSimple");
	const controller = session.skillDiagnosticController;
	const item = controller.items().find(item => item.name === "review");
	expect(item?.canAnalyze).toBe(true);
	const prepared = await controller.prepare("review");
	expect(prepared.status).toBe("prepared");
	expect(prepared.candidates.map(candidate => candidate.root).sort()).toEqual(
		session.skills.map(skill => skill.baseDir).sort(),
	);
	expect(complete).not.toHaveBeenCalled();
	expect(() => controller.start(prepared.id, false)).toThrow();
	expect(complete).not.toHaveBeenCalled();
	expect(cfgUserResourceExclusions.get(session.settings)).toEqual({});
});

test("a consented analysis starts once, retains results, and needs independent confirmation to apply", async () => {
	const controller = session.skillDiagnosticController;
	const plan = await controller.prepare("review");
	const complete = spyOn(ai, "completeSimple").mockResolvedValue(responseFor(plan.candidates));
	controller.start(plan.id, true);
	controller.start(plan.id, true);
	const done = await controller.wait(plan.id);
	expect(done.status).toBe("complete");
	expect(complete).toHaveBeenCalledTimes(1);
	expect(controller.items().find(item => item.name === "review")?.analysis?.result?.recommendation.action).toBe(
		"prefer",
	);
	expect(cfgUserResourceExclusions.get(session.settings)).toEqual({});
	await expect(controller.apply(plan.id, false)).rejects.toThrow();
	expect(session.skills).toHaveLength(2);
	const applied = await controller.apply(plan.id, true);
	expect(applied.status).toBe("applied");
	expect(session.skills.map(skill => skill.baseDir)).toEqual([preferredRoot]);
	await controller.apply(plan.id, true);
	expect(complete).toHaveBeenCalledTimes(1);
});

test("changed content invalidates a prepared consent plan before any model request", async () => {
	const controller = session.skillDiagnosticController;
	const plan = await controller.prepare("review");
	await Bun.write(path.join(preferredRoot, "SKILL.md"), "Changed workflow\n");
	const complete = spyOn(ai, "completeSimple");
	controller.start(plan.id, true);
	const result = await controller.wait(plan.id);
	expect(result.status).toBe("stale");
	expect(complete).not.toHaveBeenCalled();
	expect(cfgUserResourceExclusions.get(session.settings)).toEqual({});
});

test("a session switch invalidates old plans and cannot expose their result to the new session", async () => {
	const controller = session.skillDiagnosticController;
	const plan = await controller.prepare("review");
	const complete = spyOn(ai, "completeSimple");
	await session.newSession();
	expect(() => controller.start(plan.id, true)).toThrow();
	expect(complete).not.toHaveBeenCalled();
	expect(controller.items().every(item => item.analysis === undefined)).toBe(true);
});

test("running cancellation resolves wait without saving a preference", async () => {
	const controller = session.skillDiagnosticController;
	const plan = await controller.prepare("review");
	const entered = Promise.withResolvers<void>();
	const provider = Promise.withResolvers<ai.AssistantMessage>();
	const complete = spyOn(ai, "completeSimple").mockImplementation(async () => {
		entered.resolve();
		return provider.promise;
	});
	controller.start(plan.id, true);
	await entered.promise;
	expect(controller.cancel(plan.id).status).toBe("cancelled");
	expect((await controller.wait(plan.id)).result).toBeUndefined();
	provider.resolve(responseFor(plan.candidates));
	await complete.mock.results[0].value;
	expect(controller.items().find(item => item.name === "review")?.analysis?.result).toBeUndefined();
	expect(complete).toHaveBeenCalledTimes(1);
});

test("new preparations preserve prior results without accepting superseded consent ids", async () => {
	const controller = session.skillDiagnosticController;
	const first = await controller.prepare("review");
	spyOn(ai, "completeSimple").mockResolvedValue(responseFor(first.candidates));
	controller.start(first.id, true);
	await controller.wait(first.id);
	const next = await controller.prepare("review");
	controller.cancel(next.id);
	const row = controller.items().find(item => item.name === "review");
	expect(row?.analysis?.status).toBe("cancelled");
	expect(row?.lastAnalysis?.result?.relationship).toBe("adaptation");
	expect(() => controller.start(first.id, true)).toThrow();
	await expect(controller.apply(first.id, true)).rejects.toThrow();
});

test("public plan mutation cannot change server-owned snapshots or model", async () => {
	const controller = session.skillDiagnosticController;
	const plan = await controller.prepare("review");
	const expected = responseFor(plan.candidates);
	plan.model = "forged/model";
	plan.candidates[0].root = temp.join("not-reviewed");
	plan.candidates[0].fingerprint = "forged";
	const complete = spyOn(ai, "completeSimple").mockResolvedValue(expected);
	controller.start(plan.id, true);
	expect((await controller.wait(plan.id)).status).toBe("complete");
	expect(complete.mock.calls[0][0].provider).toBe("anthropic");
	await controller.apply(plan.id, true);
	expect(session.skills.map(skill => skill.baseDir)).toEqual([preferredRoot]);
});

test("changed files invalidate a completed recommendation without saving a preference", async () => {
	const controller = session.skillDiagnosticController;
	const plan = await controller.prepare("review");
	spyOn(ai, "completeSimple").mockResolvedValue(responseFor(plan.candidates));
	controller.start(plan.id, true);
	await controller.wait(plan.id);
	await Bun.write(path.join(preferredRoot, "SKILL.md"), "Changed after analysis\n");
	await expect(controller.apply(plan.id, true)).rejects.toThrow();
	expect(controller.items().find(item => item.name === "review")?.analysis?.status).toBe("stale");
	expect(cfgUserResourceExclusions.get(session.settings)).toEqual({});
});

test("preparing a running name cannot supersede its consented request", async () => {
	const controller = session.skillDiagnosticController;
	const plan = await controller.prepare("review");
	const entered = Promise.withResolvers<void>();
	const provider = Promise.withResolvers<ai.AssistantMessage>();
	spyOn(ai, "completeSimple").mockImplementation(async () => {
		entered.resolve();
		return provider.promise;
	});
	controller.start(plan.id, true);
	await entered.promise;
	const refused = controller.prepare("review");
	await expect(refused).rejects.toThrow();
	provider.resolve(responseFor(plan.candidates));
	expect((await controller.wait(plan.id)).status).toBe("complete");
});

test("an overlapping preparation cannot orphan a newer running analysis", async () => {
	const controller = session.skillDiagnosticController;
	const realSnapshot = snapshots.snapshotResource;
	const paused = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	let gateNext = true;
	spyOn(snapshots, "snapshotResource").mockImplementation(async candidate => {
		if (gateNext) {
			gateNext = false;
			paused.resolve();
			await resume.promise;
		}
		return realSnapshot(candidate);
	});
	const slow = controller.prepare("review");
	await paused.promise;
	const fast = await controller.prepare("review");
	const entered = Promise.withResolvers<void>();
	const provider = Promise.withResolvers<ai.AssistantMessage>();
	spyOn(ai, "completeSimple").mockImplementation(async () => {
		entered.resolve();
		return provider.promise;
	});
	controller.start(fast.id, true);
	await entered.promise;
	const refusal = slow.then(
		() => false,
		() => true,
	);
	resume.resolve();
	const rejected = await refusal;
	provider.resolve(responseFor(fast.candidates));
	expect(rejected).toBe(true);
	expect((await controller.wait(fast.id)).status).toBe("complete");
});

test("session change aborts the provider immediately without a diagnostics getter", async () => {
	const controller = session.skillDiagnosticController;
	const plan = await controller.prepare("review");
	const entered = Promise.withResolvers<AbortSignal | undefined>();
	const provider = Promise.withResolvers<ai.AssistantMessage>();
	spyOn(ai, "completeSimple").mockImplementation(async (_model, _context, options) => {
		entered.resolve(options?.signal);
		return provider.promise;
	});
	controller.start(plan.id, true);
	const signal = await entered.promise;
	await session.newSession();
	const aborted = signal?.aborted;
	provider.resolve(responseFor(plan.candidates));
	expect(aborted).toBe(true);
	expect(cfgUserResourceExclusions.get(session.settings)).toEqual({});
});

test("session change inside the writer prevents saving old-context approval", async () => {
	const controller = session.skillDiagnosticController;
	const plan = await controller.prepare("review");
	spyOn(ai, "completeSimple").mockResolvedValue(responseFor(plan.candidates));
	controller.start(plan.id, true);
	await controller.wait(plan.id);
	const write = decisions.excludeReviewedResources;
	const entered = Promise.withResolvers<void>();
	const resume = Promise.withResolvers<void>();
	spyOn(decisions, "excludeReviewedResources").mockImplementation(
		async (reviewed, preferred, settings, authorized) => {
			entered.resolve();
			await resume.promise;
			return write(reviewed, preferred, settings, authorized);
		},
	);
	const applying = controller.apply(plan.id, true);
	const refused = applying.then(
		() => false,
		() => true,
	);
	await entered.promise;
	await session.newSession();
	resume.resolve();
	expect(await refused).toBe(true);
	expect(cfgUserResourceExclusions.get(session.settings)).toEqual({});
});

test("saved choice and reload failure are distinguishable, and successful retry clears the error", async () => {
	const controller = session.skillDiagnosticController;
	const plan = await controller.prepare("review");
	spyOn(ai, "completeSimple").mockResolvedValue(responseFor(plan.candidates));
	controller.start(plan.id, true);
	await controller.wait(plan.id);
	const refresh = session.refreshSkills.bind(session);
	const reload = spyOn(session, "refreshSkills").mockRejectedValueOnce(new Error("reload failed"));
	await expect(controller.apply(plan.id, true)).rejects.toThrow();
	const saved = controller.items().find(item => item.name === "review")?.analysis;
	expect(saved?.applied).toBe(true);
	expect(saved?.error).toBeDefined();
	expect(Object.keys(cfgUserResourceExclusions.get(session.settings))).toHaveLength(1);
	reload.mockImplementation(refresh);
	const applied = await controller.apply(plan.id, true);
	expect(applied.status).toBe("applied");
	expect(applied.error).toBeUndefined();
	expect(session.skills.map(skill => skill.baseDir)).toEqual([preferredRoot]);
});

test("restored copies invalidate current applied status while preserving the reviewed result", async () => {
	const controller = session.skillDiagnosticController;
	const plan = await controller.prepare("review");
	spyOn(ai, "completeSimple").mockResolvedValue(responseFor(plan.candidates));
	controller.start(plan.id, true);
	await controller.wait(plan.id);
	await controller.apply(plan.id, true);
	cfgResourceExclusions.set(session.settings, {});
	await session.refreshSkills();
	const restored = controller.items().find(item => item.name === "review");
	expect(restored?.canAnalyze).toBe(true);
	expect(restored?.analysis?.status).toBe("stale");
	expect(restored?.analysis?.applied).toBe(false);
	expect(restored?.analysis?.result?.relationship).toBe("adaptation");
	await expect(controller.apply(plan.id, true)).rejects.toThrow();
});
