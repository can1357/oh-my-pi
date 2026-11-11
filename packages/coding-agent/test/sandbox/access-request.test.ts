/**
 * Access requests (`SandboxRuntime.requestAccess`, `grantPath`, `sandbox_request`) and the
 * protection of omp's own settings files from the in-process file tools.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import {
	type SandboxAccessAnswer,
	type SandboxAccessRequest,
	SandboxRuntime,
	sandboxAccessEffect,
} from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import { readSandboxConfig, sandboxEnabled } from "@oh-my-pi/pi-coding-agent/sandbox/policy";
import {
	cfgSandboxAllowedHosts,
	cfgSandboxAllowWrite,
	cfgSandboxDenyRead,
	cfgSandboxEnabled,
	cfgSandboxMode,
	cfgSandboxNetworkMode,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { resolveBuiltinToolPlan, type ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { approvalRestrictions, resolveApproval } from "@oh-my-pi/pi-coding-agent/tools/approval";
import { approvalTargetKey } from "@oh-my-pi/pi-coding-agent/tools/approval-targets";
import { SandboxRequestTool } from "@oh-my-pi/pi-coding-agent/tools/sandbox-request";
import { sandboxSupport } from "@oh-my-pi/pi-natives";
import { isRecord, TempDir } from "@oh-my-pi/pi-utils";
import { buildSandboxPrompt } from "@oh-my-pi/pi-coding-agent/system-prompt";
import { initSandboxSettings, SANDBOX_SUPPORTED } from "../helpers/sandbox-test-state";
import {
	beginSettingsTest,
	restoreEnvValue,
	restoreSettingsTestState,
	type SettingsTestState,
} from "../helpers/settings-test-state";

const backend = sandboxSupport();

let state: SettingsTestState | undefined;
let settings: Settings;
let scratch: TempDir;
let agentDir: string;
/** `<scratch>/workspace`, realpath'd. */
let workspace: string;
/** `<scratch>/outside`, realpath'd: not writable for contained commands. */
let outside: string;
let runtimes: SandboxRuntime[];
/** Requests the installed approver saw. */
let asked: SandboxAccessRequest[];

async function runtime(): Promise<SandboxRuntime> {
	const instance = await SandboxRuntime.for(workspace);
	runtimes.push(instance);
	return instance;
}

/** Installs an approver answering every request with `answer`. */
function answerWith(answer: SandboxAccessAnswer): void {
	SandboxRuntime.setAccessApprover(async request => {
		asked.push(request);
		return answer;
	});
}

function request(kind: "write" | "read" | "host", target: string) {
	return { kind, target, intent: "Build the docs into ../site.", command: "mkdocs build -d ../site" };
}

beforeEach(() => {
	state = beginSettingsTest();
	restoreEnvValue("PI_SANDBOX", undefined);
	scratch = TempDir.createSync("@omp-sandbox-access-");
	const root = fs.realpathSync(scratch.path());
	agentDir = path.join(root, "agent");
	workspace = path.join(root, "workspace");
	outside = path.join(root, "outside");
	const tmp = path.join(root, "tmp");
	for (const dir of [agentDir, workspace, outside, tmp]) fs.mkdirSync(dir);
	// Private temp dirs land (and get cleaned) under the scratch root.
	vi.spyOn(os, "tmpdir").mockReturnValue(tmp);
	runtimes = [];
	asked = [];
	SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
});

afterEach(async () => {
	try {
		for (const instance of runtimes) await instance.dispose();
		SandboxRuntime.resetForTest();
		SandboxRuntime.setAccessApprover(undefined);
	} finally {
		restoreSettingsTestState(state);
		state = undefined;
		// Persisted settings opened <agentDir>/agent.db; Windows cannot delete an open file.
		AgentStorage.close();
		scratch.removeSync();
	}
});

describe("SandboxRuntime.requestAccess", () => {
	beforeEach(async () => {
		settings = await Settings.init({ inMemory: true, agentDir, cwd: workspace });
		cfgSandboxEnabled.set(settings, true);
		cfgSandboxNetworkMode.set(settings, "allowlist");
	});

	it("grants exactly the target for the session, changes the fingerprint and notifies", async () => {
		answerWith({ decision: "session" });
		const instance = await runtime();
		const target = path.join(outside, "site");
		const before = instance.fingerprint();
		let notified = 0;
		instance.onChange(() => notified++);
		const outcome = await instance.requestAccess(request("write", "../outside/site"));
		expect(outcome).toEqual({ status: "granted", scope: "session", target });
		expect(asked).toHaveLength(1);
		expect(asked[0]).toMatchObject({ kind: "write", target, workspace, canAlways: true });
		expect(asked[0].intent).toBe("Build the docs into ../site.");
		expect(instance.sessionPaths()).toEqual({ write: [target], read: [] });
		expect(instance.effectivePolicy().readwritePaths).toContain(target);
		expect(instance.effectivePolicy().readwritePaths).not.toContain(outside);
		expect(instance.fingerprint()).not.toBe(before);
		expect(notified).toBeGreaterThan(0);
		expect(cfgSandboxAllowWrite.get(settings)).not.toContain(target);

		instance.revokePath("write", target);
		expect(instance.sessionPaths().write).toEqual([]);
		expect(instance.effectivePolicy().readwritePaths).not.toContain(target);
		expect(instance.fingerprint()).toBe(before);
	});

	it("persists an always grant to the global allowlist", async () => {
		answerWith({ decision: "always" });
		const instance = await runtime();
		const outcome = await instance.requestAccess(request("write", outside));
		expect(outcome).toEqual({ status: "granted", scope: "always", target: outside });
		expect(cfgSandboxAllowWrite.get(settings)).toContain(outside);
		expect(instance.sessionPaths()).toEqual({ write: [], read: [] });
		expect(instance.effectivePolicy().readwritePaths).toContain(outside);
		const hostOutcome = await instance.requestAccess(request("host", "Docs.Example.com."));
		expect(hostOutcome).toEqual({ status: "granted", scope: "always", target: "docs.example.com" });
		expect(cfgSandboxAllowedHosts.get(settings)).toContain("docs.example.com");
	});

	it("reports targets the policy already allows without asking", async () => {
		answerWith({ decision: "deny" });
		cfgSandboxAllowedHosts.set(settings, ["registry.npmjs.org"]);
		const instance = await runtime();
		expect(await instance.requestAccess(request("write", "build"))).toEqual({
			status: "already-allowed",
			target: path.join(workspace, "build"),
		});
		// A runtime path: readable on every platform (the system temp dir is not a read root on Linux).
		const readable = fs.realpathSync(path.dirname(process.execPath));
		expect(await instance.requestAccess(request("read", readable))).toEqual({
			status: "already-allowed",
			target: readable,
		});
		expect(await instance.requestAccess(request("host", "registry.npmjs.org"))).toEqual({
			status: "already-allowed",
			target: "registry.npmjs.org",
		});
		expect(asked).toEqual([]);
	});

	it("answers host requests from the enforced network mode", async () => {
		answerWith({ decision: "session" });
		const instance = await runtime();
		cfgSandboxNetworkMode.set(settings, "deny");
		expect(await instance.requestAccess(request("host", "example.com"))).toMatchObject({ status: "refused" });
		cfgSandboxNetworkMode.set(settings, "allow");
		expect(await instance.requestAccess(request("host", "example.com"))).toEqual({
			status: "already-allowed",
			target: "example.com",
		});
		// Allowlist degraded to deny (no proxy confinement): network is off, nothing to grant.
		SandboxRuntime.resetForTest({ ...SANDBOX_SUPPORTED, proxy: false });
		cfgSandboxNetworkMode.set(settings, "allowlist");
		expect(await instance.requestAccess(request("host", "example.com"))).toMatchObject({ status: "refused" });
		expect(asked).toEqual([]);
	});

	it("returns the user's denial and instructions without granting or creating anything", async () => {
		const instance = await runtime();
		const missing = path.join(outside, "not-yet");
		answerWith({ decision: "deny" });
		expect(await instance.requestAccess(request("write", missing))).toEqual({ status: "denied", target: missing });
		answerWith({ decision: "instruct", instructions: "Use ./site instead." });
		expect(await instance.requestAccess(request("write", missing))).toEqual({
			status: "instructed",
			target: missing,
			instructions: "Use ./site instead.",
		});
		expect(instance.sessionPaths()).toEqual({ write: [], read: [] });
		expect(instance.effectivePolicy().readwritePaths).not.toContain(missing);
		// Only an approved write grant creates a missing target (policy entries must exist).
		expect(fs.existsSync(missing)).toBe(false);
		answerWith({ decision: "session" });
		expect(await instance.requestAccess(request("write", missing))).toMatchObject({ status: "granted" });
		expect(fs.statSync(missing).isDirectory()).toBe(true);
		expect(instance.effectivePolicy().readwritePaths).toContain(missing);
	});

	it("refuses invalid, protected and ungrantable requests without asking", async () => {
		answerWith({ decision: "session" });
		const secrets = path.join(outside, "secrets");
		fs.mkdirSync(secrets);
		cfgSandboxDenyRead.set(settings, [secrets]);
		const instance = await runtime();
		const refused = async (input: Parameters<SandboxRuntime["requestAccess"]>[0]) =>
			(await instance.requestAccess(input)).status;
		expect(await refused(request("write", "/"))).toBe("refused");
		expect(await refused(request("read", path.join(secrets, "key")))).toBe("refused");
		expect(await refused(request("host", "*.example.com"))).toBe("refused");
		expect(await refused(request("host", "https://example.com"))).toBe("refused");
		expect(await refused({ ...request("write", outside), intent: "  " })).toBe("refused");
		expect(await refused(request("write", `${outside}/a\nb`))).toBe("refused");
		expect(await refused(request("host", "example.com\u001b[2J"))).toBe("refused");
		cfgSandboxMode.set(settings, "read-only");
		expect(await refused(request("write", outside))).toBe("refused");
		expect(asked).toEqual([]);
		// A grant containing a denied path is allowed; the denied entry still outranks it.
		cfgSandboxMode.set(settings, "workspace-write");
		expect(await refused(request("write", outside))).toBe("granted");
		expect(instance.effectivePolicy().readwritePaths).toContain(outside);
		expect(instance.effectivePolicy().deniedPaths).toEqual([secrets]);
	});

	it("refuses when nobody can be asked or the sandbox is off", async () => {
		const instance = await runtime();
		expect(await instance.requestAccess(request("write", outside))).toMatchObject({ status: "refused" });
		answerWith({ decision: "session" });
		cfgSandboxEnabled.set(settings, false);
		expect(await instance.requestAccess(request("write", outside))).toMatchObject({ status: "refused" });
		expect(asked).toEqual([]);
	});

	it("shares one dialog between identical concurrent requests", async () => {
		const gate = Promise.withResolvers<SandboxAccessAnswer>();
		SandboxRuntime.setAccessApprover(async req => {
			asked.push(req);
			return gate.promise;
		});
		const instance = await runtime();
		const first = instance.requestAccess(request("write", outside));
		const second = instance.requestAccess(request("write", outside));
		gate.resolve({ decision: "session" });
		const outcomes = await Promise.all([first, second]);
		expect(outcomes.map(outcome => outcome.status)).toEqual(["granted", "granted"]);
		expect(asked).toHaveLength(1);
	});

	it("lets each caller abandon a shared or queued dialog without affecting the others", async () => {
		const dialogs: { target: string; signal?: AbortSignal; answer: PromiseWithResolvers<SandboxAccessAnswer> }[] = [];
		let opened = Promise.withResolvers<void>();
		SandboxRuntime.setAccessApprover(async (req, signal) => {
			const answer = Promise.withResolvers<SandboxAccessAnswer>();
			dialogs.push({ target: req.target, signal, answer });
			opened.resolve();
			return answer.promise;
		});
		const instance = await runtime();
		const queued = path.join(outside, "queued");
		const later = path.join(outside, "later");
		// Two callers share the open dialog; the first gives up, the second still gets the answer.
		const leaving = new AbortController();
		const left = instance.requestAccess(request("write", outside), leaving.signal);
		const staying = instance.requestAccess(request("write", outside));
		// Queued behind the open dialog, then abandoned by its only caller.
		const abandoning = new AbortController();
		const abandoned = instance.requestAccess(request("write", queued), abandoning.signal);
		await opened.promise;
		expect(dialogs.map(dialog => dialog.target)).toEqual([outside]);
		const settled = (pending: Promise<unknown>) =>
			pending.then(
				() => "resolved",
				() => "rejected",
			);
		const leftSettled = settled(left);
		const abandonedSettled = settled(abandoned);
		leaving.abort();
		abandoning.abort();
		expect(await leftSettled).toBe("rejected");
		expect(await abandonedSettled).toBe("rejected");
		expect(dialogs[0].signal?.aborted).toBe(false);
		opened = Promise.withResolvers<void>();
		dialogs[0].answer.resolve({ decision: "deny" });
		expect(await staying).toEqual({ status: "denied", target: outside });
		// The abandoned request never reaches the approver: the next dialog is the later request.
		const next = instance.requestAccess(request("write", later));
		await opened.promise;
		expect(dialogs.map(dialog => dialog.target)).toEqual([outside, later]);
		dialogs[1].answer.resolve({ decision: "deny" });
		expect(await next).toEqual({ status: "denied", target: later });
	});

	it("aborts the dialog once its only caller gives up", async () => {
		const opened = Promise.withResolvers<AbortSignal | undefined>();
		SandboxRuntime.setAccessApprover((_req, signal) => {
			opened.resolve(signal);
			return new Promise(() => {});
		});
		const instance = await runtime();
		const controller = new AbortController();
		const pending = instance.requestAccess(request("write", outside), controller.signal);
		const dialogSignal = await opened.promise;
		controller.abort();
		await expect(pending).rejects.toThrow();
		expect(dialogSignal?.aborted).toBe(true);
	});

	it("opens a fresh dialog for a request identical to one every caller abandoned", async () => {
		const dialogs: { target: string; answer: PromiseWithResolvers<SandboxAccessAnswer> }[] = [];
		let opened = Promise.withResolvers<void>();
		SandboxRuntime.setAccessApprover(req => {
			const answer = Promise.withResolvers<SandboxAccessAnswer>();
			dialogs.push({ target: req.target, answer });
			opened.resolve();
			return answer.promise;
		});
		const instance = await runtime();
		const queued = path.join(outside, "queued");
		const blocking = instance.requestAccess(request("write", outside));
		await opened.promise;
		const controller = new AbortController();
		const abandoned = instance.requestAccess(request("write", queued), controller.signal);
		const abandonedSettled = abandoned.then(
			() => "resolved",
			() => "rejected",
		);
		controller.abort();
		expect(await abandonedSettled).toBe("rejected");
		// The same target again: not joined to the dead entry, so it reaches the approver.
		const again = instance.requestAccess(request("write", queued));
		opened = Promise.withResolvers<void>();
		dialogs[0].answer.resolve({ decision: "deny" });
		await blocking;
		await opened.promise;
		expect(dialogs.map(dialog => dialog.target)).toEqual([outside, queued]);
		dialogs[1].answer.resolve({ decision: "deny" });
		expect(await again).toEqual({ status: "denied", target: queued });
	});

	it("clears session grants on resetForTest", async () => {
		const instance = await runtime();
		instance.grantPath("read", outside, "session");
		expect(instance.sessionPaths().read).toEqual([outside]);
		SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
		expect(instance.sessionPaths()).toEqual({ write: [], read: [] });
	});

	it("names the consequence of each kind", () => {
		expect(sandboxAccessEffect("write", "/x")).toContain("/x");
		expect(sandboxAccessEffect("host", "a.test")).toContain("a.test");
		expect(new Set(["write", "read", "host"].map(kind => sandboxAccessEffect(kind as "write", "t"))).size).toBe(3);
	});
});

describe("SandboxRuntime always grants with a project-layer list", () => {
	it("offers no always option and refuses an always grant", async () => {
		settings = await initSandboxSettings(
			{ agentDir, workspace },
			{ global: { enabled: true }, project: { filesystem: { allowWrite: [] } } },
		);
		answerWith({ decision: "always" });
		const instance = await runtime();
		expect(() => instance.grantPath("write", outside, "always")).toThrow();
		// The approver is told; an `always` answer anyway falls back to the session.
		expect(await instance.requestAccess(request("write", outside))).toEqual({
			status: "granted",
			scope: "session",
			target: outside,
		});
		expect(asked[0].canAlways).toBe(false);
		expect(cfgSandboxAllowWrite.get(settings.grantAuthority())).not.toContain(outside);
	});
});

describe("sandboxEnabled", () => {
	it("agrees with readSandboxConfig: the project layer may enable but not disable", async () => {
		settings = await initSandboxSettings(
			{ agentDir, workspace },
			{ global: { enabled: true }, project: { enabled: false } },
		);
		expect(sandboxEnabled(settings)).toBe(true);
		expect(sandboxEnabled(settings)).toBe(readSandboxConfig(settings).enabled);
	});

	it("enables from the project layer", async () => {
		settings = await initSandboxSettings({ agentDir, workspace }, { project: { enabled: true } });
		expect(sandboxEnabled(settings)).toBe(true);
	});

	it("is not switched off by a project null", async () => {
		settings = await initSandboxSettings(
			{ agentDir, workspace },
			{ global: { enabled: true }, project: { enabled: null } },
		);
		expect(readSandboxConfig(settings).enabled).toBe(true);
		expect(sandboxEnabled(settings)).toBe(true);
	});
});

describe("sandbox_request tool", () => {
	beforeEach(async () => {
		settings = await Settings.init({ inMemory: true, agentDir, cwd: workspace });
		cfgSandboxEnabled.set(settings, true);
	});

	async function call(params: Record<string, string>) {
		const tool = new SandboxRequestTool({ cwd: workspace, settings } as ToolSession);
		const result = await tool.execute("call", params as never);
		runtimes.push(await SandboxRuntime.for(workspace));
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("");
		return { text, details: result.details };
	}

	it("reports a grant with what was asked", async () => {
		answerWith({ decision: "session" });
		const { text, details } = await call({ ...request("write", outside), alternative: "Build into ./site." });
		expect(details).toMatchObject({
			status: "granted",
			scope: "session",
			target: outside,
			kind: "write",
			intent: "Build the docs into ../site.",
			command: "mkdocs build -d ../site",
			alternative: "Build into ./site.",
		});
		expect(text).toContain(outside);
	});

	it("reports a denial, instructions and a refusal", async () => {
		answerWith({ decision: "deny" });
		expect((await call(request("host", "example.com"))).details).toMatchObject({ status: "denied" });
		answerWith({ decision: "instruct", instructions: "Ask me <later> & elsewhere." });
		const instructed = await call(request("host", "example.com"));
		expect(instructed.details).toMatchObject({ status: "instructed", instructions: "Ask me <later> & elsewhere." });
		expect(instructed.text).toContain("Ask me <later> & elsewhere.");
		const refused = await call(request("write", "/"));
		expect(refused.details).toMatchObject({ status: "refused" });
		expect(refused.text).not.toBe("");
	});

	it("needs no tool approval in any mode, so the dialog is the only prompt", () => {
		const tool = new SandboxRequestTool({ cwd: workspace, settings } as ToolSession);
		for (const mode of ["always-ask", "always-ask-cached", "write", "yolo"] as const) {
			expect(resolveApproval(tool, request("write", outside), mode).policy).toBe("allow");
		}
	});
});

describe("writable roots are pinned, never followed through a replacement", () => {
	let elsewhere: string;
	let warnings: string[];

	beforeEach(async () => {
		settings = await Settings.init({ inMemory: true, agentDir, cwd: workspace });
		cfgSandboxEnabled.set(settings, true);
		elsewhere = path.join(path.dirname(outside), "elsewhere");
		fs.mkdirSync(elsewhere);
		warnings = [];
		SandboxRuntime.setWarningSink(message => warnings.push(message));
	});

	afterEach(() => SandboxRuntime.setWarningSink(undefined));

	/** What a contained process can do to its own writable root on seatbelt: remove it, link elsewhere. */
	function swapForSymlink(root: string): void {
		fs.rmSync(root, { recursive: true });
		fs.symlinkSync(elsewhere, root);
	}

	it.skipIf(process.platform === "win32")("drops a session write grant replaced by a symlink", async () => {
		const granted = path.join(outside, "granted");
		fs.mkdirSync(granted);
		const instance = await runtime();
		instance.grantPath("write", granted, "session");
		const before = instance.fingerprint();
		swapForSymlink(granted);
		expect(instance.effectivePolicy().readwritePaths).not.toContain(elsewhere);
		expect(instance.sessionPaths().write).toEqual([]);
		expect(instance.fingerprint()).not.toBe(before);
	});

	it("keeps and recreates a session write grant whose directory was deleted", async () => {
		const granted = path.join(outside, "build");
		const instance = await runtime();
		instance.grantPath("write", granted, "session");
		const before = instance.fingerprint();
		fs.rmSync(granted, { recursive: true });
		expect(instance.effectivePolicy().readwritePaths).toContain(granted);
		expect(fs.statSync(granted).isDirectory()).toBe(true);
		expect(instance.sessionPaths().write).toEqual([granted]);
		expect(instance.fingerprint()).toBe(before);
	});

	it.skipIf(process.platform === "win32")(
		"skips an allowWrite entry re-pointed since it was first resolved",
		async () => {
			const allowed = path.join(outside, "allowed");
			fs.mkdirSync(allowed);
			cfgSandboxAllowWrite.set(settings, [allowed]);
			const instance = await runtime();
			expect(instance.effectivePolicy().readwritePaths).toContain(allowed);
			swapForSymlink(allowed);
			const { readwritePaths } = instance.effectivePolicy();
			expect(readwritePaths).not.toContain(elsewhere);
			expect(readwritePaths).not.toContain(allowed);
			instance.effectivePolicy();
			expect(warnings).toHaveLength(1);
			expect(warnings[0]).toContain(allowed);
		},
	);

	it.skipIf(process.platform === "win32")("keeps a symlinked allowWrite entry pinned to its target", async () => {
		const link = path.join(outside, "link");
		fs.symlinkSync(elsewhere, link);
		cfgSandboxAllowWrite.set(settings, [link]);
		const instance = await runtime();
		expect(instance.effectivePolicy().readwritePaths).toContain(elsewhere);
		expect(instance.effectivePolicy().readwritePaths).toContain(elsewhere);
		expect(warnings).toEqual([]);
	});

	it.skipIf(process.platform === "win32")("fails closed when the workspace was replaced", async () => {
		const instance = await runtime();
		expect(instance.effectivePolicy().readwritePaths).toContain(workspace);
		swapForSymlink(workspace);
		expect(instance.effectivePolicy().readwritePaths).not.toContain(elsewhere);
		// The same cwd keeps resolving to the pinned runtime instead of following the symlink.
		expect(await SandboxRuntime.for(workspace)).toBe(instance);
		await expect(instance.spawn({ argv: ["/bin/sh", "-c", "true"], cwd: workspace, env: {} })).rejects.toThrow(
			"workspace path was replaced",
		);
	});
});

describe("prompts point at sandbox_request only when it is available", () => {
	beforeEach(async () => {
		settings = await Settings.init({ inMemory: true, agentDir, cwd: workspace });
		cfgSandboxEnabled.set(settings, true);
	});

	it("system prompt block", async () => {
		runtimes.push(await SandboxRuntime.for(workspace));
		expect(await buildSandboxPrompt(settings, workspace, { requestTool: true })).toContain("sandbox_request");
		expect(await buildSandboxPrompt(settings, workspace)).not.toContain("sandbox_request");
	});

	it("registers the tool only while the sandbox is enabled", async () => {
		const session = { cwd: workspace, settings } as ToolSession;
		expect((await resolveBuiltinToolPlan(session, ["sandbox_request"])).names).toEqual(["sandbox_request"]);
		cfgSandboxEnabled.set(settings, false);
		expect((await resolveBuiltinToolPlan(session, ["sandbox_request"])).names).toEqual([]);
	});
});

describe("approval restrictions while the sandbox is on", () => {
	/** A file tool whose target is `args.path`, like `write`. */
	const writeTool = (): AgentTool => ({
		name: "write",
		label: "write",
		description: "write test tool",
		parameters: {} as never,
		approval: "write",
		approvalCacheTargets: (args: unknown) =>
			isRecord(args) && typeof args.path === "string" ? [approvalTargetKey(workspace, args.path)!] : undefined,
		execute: async () => ({ content: [{ type: "text" as const, text: "written" }] }),
	});

	beforeEach(async () => {
		settings = await Settings.init({ inMemory: true, agentDir, cwd: workspace });
	});

	it("restricts omp's global settings files in yolo while enabled, and not otherwise", () => {
		const config = path.join(agentDir, "config.yml");
		const env = path.join(agentDir, ".env");
		const resolve = (target: string) =>
			resolveApproval(
				writeTool(),
				{ path: target },
				"yolo",
				{},
				undefined,
				approvalRestrictions(settings, workspace),
			);
		expect(resolve(config).policy).toBe("allow");
		cfgSandboxEnabled.set(settings, true);
		expect(resolve(config)).toMatchObject({ policy: "prompt", source: "restriction" });
		expect(resolve(env)).toMatchObject({ policy: "prompt", source: "restriction" });
		expect(resolve(path.join(workspace, "notes.md")).policy).toBe("allow");
	});
});

describe.skipIf(!backend.supported || process.platform === "win32")("access grants in a contained process", () => {
	beforeEach(async () => {
		SandboxRuntime.resetForTest();
		settings = await Settings.init({ inMemory: true, agentDir, cwd: workspace });
		cfgSandboxEnabled.set(settings, true);
		cfgSandboxNetworkMode.set(settings, "deny");
	});

	async function write(instance: SandboxRuntime, file: string): Promise<number> {
		const child = await instance.spawn({ argv: ["/bin/sh", "-c", `echo ok > '${file}'`], cwd: workspace, env: {} });
		child.stdin.end();
		await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
		return child.exited;
	}

	it("a session write grant lets exactly the target be written until revoked", async () => {
		const granted = path.join(outside, "granted");
		const sibling = path.join(outside, "sibling");
		fs.mkdirSync(sibling);
		const instance = await runtime();
		expect(await write(instance, path.join(granted, "a"))).not.toBe(0);
		instance.grantPath("write", granted, "session");
		expect(await write(instance, path.join(granted, "a"))).toBe(0);
		expect(fs.readFileSync(path.join(granted, "a"), "utf8")).toBe("ok\n");
		expect(await write(instance, path.join(sibling, "b"))).not.toBe(0);
		instance.revokePath("write", granted);
		expect(await write(instance, path.join(granted, "c"))).not.toBe(0);
		expect(fs.existsSync(path.join(granted, "c"))).toBe(false);
	});

	it("keeps a session write grant whose directory a contained command deleted, and recreates it", async () => {
		const granted = path.join(outside, "build");
		const instance = await runtime();
		instance.grantPath("write", granted, "session");
		const remove = await instance.spawn({ argv: ["/bin/rm", "-rf", granted], cwd: workspace, env: {} });
		remove.stdin.end();
		expect(await remove.exited).toBe(0);
		expect(fs.existsSync(granted)).toBe(false);
		expect(instance.effectivePolicy().readwritePaths).toContain(granted);
		expect(instance.sessionPaths().write).toEqual([granted]);
		expect(await write(instance, path.join(granted, "again"))).toBe(0);
	});
});
