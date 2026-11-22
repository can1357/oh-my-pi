/**
 * Sandbox session state across a subagent worker link: main's session grants reach the worker
 * realm's replica, the worker realm's access requests reach main's approver, and the worker
 * realm's proxy refusals reach main's blocked-host log.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import type {
	SandboxAccessAnswer,
	SandboxAccessApprover,
	SandboxAccessRequest,
} from "@oh-my-pi/pi-coding-agent/sandbox/types";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { WorkerThreadLink } from "@oh-my-pi/pi-coding-agent/thread/protocol";
import { RpcClosedError } from "@oh-my-pi/pi-coding-agent/thread/rpc";
import { type SandboxThreadGlobals, sandboxThreadService } from "@oh-my-pi/pi-coding-agent/thread/services/sandbox";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { SandboxGrantsProbe } from "../fixtures/sandbox-grants-worker";
import { initSandboxSettings, SANDBOX_SUPPORTED } from "../helpers/sandbox-test-state";
import { type ServiceWorker, startServiceWorker } from "../helpers/service-worker";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const HOST = "docs.example.test";

let state: SettingsTestState | undefined;
let scratch: TempDir;
let agentDir: string;
let workspace: string;
/** Realpath'd directory outside the workspace: not writable for contained commands. */
let outside: string;
let main: SandboxRuntime;
let started: ServiceWorker<SandboxGrantsProbe> | undefined;
/** The started worker's probe. */
let probe: SandboxGrantsProbe;

/** Main's coalesced push is posted in a microtask, ahead of the next probe call on the same link. */
function pushes(): Promise<void> {
	return Promise.resolve();
}

/** Boots the fixture worker against this realm's current state. */
async function startWorker(): Promise<void> {
	started = await startServiceWorker<SandboxGrantsProbe>(
		new URL("../fixtures/sandbox-grants-worker.ts", import.meta.url),
		[sandboxThreadService],
	);
	probe = started.probe;
	await probe.open(agentDir, workspace);
}

/** Installs a main-realm approver: records each request and answers it with `answer`. */
function approve(asked: SandboxAccessRequest[], answer: SandboxAccessApprover): void {
	SandboxRuntime.setAccessApprover((request, signal) => {
		asked.push(request);
		return answer(request, signal);
	});
}

/** Stops the worker and boots a fresh one with main's prompt host cleared. */
async function restartWorker(): Promise<void> {
	await started?.probe.dispose();
	await started?.stop();
	started = undefined;
	SandboxRuntime.setAccessPromptHost(undefined);
	await startWorker();
}

beforeEach(async () => {
	state = beginSettingsTest();
	scratch = TempDir.createSync("@omp-sandbox-thread-");
	const root = fs.realpathSync(scratch.path());
	agentDir = path.join(root, "agent");
	workspace = path.join(root, "workspace");
	outside = path.join(root, "outside");
	for (const dir of [agentDir, workspace, outside]) fs.mkdirSync(dir);
	SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
	// Main is an interactive host, so the worker forwards its access requests.
	SandboxRuntime.setAccessPromptHost("interactive");
	await initSandboxSettings({ agentDir, workspace }, { global: { enabled: true } });
	main = await SandboxRuntime.for(workspace);
	await startWorker();
});

afterEach(async () => {
	try {
		await started?.probe.dispose();
		await started?.stop();
		started = undefined;
		await main.dispose();
		SandboxRuntime.setAccessApprover(undefined);
		SandboxRuntime.resetForTest();
	} finally {
		restoreSettingsTestState(state);
		state = undefined;
		// The settings opened <agentDir>/agent.db; Windows cannot delete an open file.
		AgentStorage.close();
		scratch.removeSync();
	}
});

describe("sandbox thread service", () => {
	it("applies main's session host grants and revocations in the worker realm", async () => {
		expect(await probe.hostAllowed(HOST)).toBe(false);

		main.grantHost(HOST, "session");
		await pushes();
		expect(await probe.hostAllowed(HOST)).toBe(true);

		main.revokeHost(HOST);
		await pushes();
		expect(await probe.hostAllowed(HOST)).toBe(false);
	});

	it("applies main's session path grants to the worker realm's policy and fingerprint", async () => {
		expect(await probe.writable()).not.toContain(outside);
		const before = await probe.fingerprint();

		main.grantPath("write", outside, "session");
		await pushes();
		expect(await probe.writable()).toContain(outside);
		expect(await probe.fingerprint()).not.toBe(before);
	});

	it("a file grant replicated to the worker realm is not recreated as a directory there once deleted", async () => {
		const file = path.join(outside, "notes.txt");
		fs.writeFileSync(file, "x");
		main.grantPath("write", file, "session");
		await pushes();
		fs.rmSync(file);
		// The worker realm's policy build checks its own replica of main's grants.
		expect(await probe.writable()).not.toContain(file);
		expect(fs.existsSync(file)).toBe(false);
	});

	it("records hosts the worker realm's proxy refused in main's blocked-host log", async () => {
		expect(main.blockedHosts()).toEqual([]);
		await probe.block("intranet.test");
		expect(main.blockedHosts()).toEqual(["intranet.test"]);
	});

	it("forwards the worker realm's access request to main's approver; the grant reaches the worker", async () => {
		const asked: SandboxAccessRequest[] = [];
		approve(asked, async () => ({ decision: "session" }));

		const { outcome, writable } = await probe.requestWrite(outside);
		expect(outcome).toEqual({ status: "granted", scope: "session", target: outside });
		expect(asked).toMatchObject([{ kind: "write", target: outside, intent: "Build the docs.", workspace }]);
		// Main owns the grant; the worker's replica holds it the moment its request returns.
		expect(main.sessionPaths().write).toEqual([outside]);
		expect(writable).toContain(outside);
		// The worker's replica allows it now: a second request opens no dialog.
		expect((await probe.requestWrite(outside)).outcome).toEqual({ status: "already-allowed", target: outside });
		expect(asked).toHaveLength(1);
	});

	it("cancels main's dialog when the worker realm's caller aborts", async () => {
		const asked: SandboxAccessRequest[] = [];
		const dialog = Promise.withResolvers<AbortSignal>();
		// The user never answers.
		const unanswered = Promise.withResolvers<SandboxAccessAnswer>();
		approve(asked, (_request, signal) => {
			if (signal) dialog.resolve(signal);
			return unanswered.promise;
		});

		await probe.startRequest(outside);
		const signal = await dialog.promise;
		expect(signal.aborted).toBe(false);
		const aborted = Promise.withResolvers<void>();
		signal.addEventListener("abort", () => aborted.resolve(), { once: true });
		expect(await probe.abortRequest()).toBe("AbortError");
		await aborted.promise;
		expect(asked).toHaveLength(1);
		expect(main.sessionPaths().write).toEqual([]);
	});

	it("returns main's refusal while main has no approver", async () => {
		// Main is now an RPC host whose client has not opted in; the worker's own message would differ.
		SandboxRuntime.setAccessPromptHost("rpc");
		expect((await probe.requestWrite(outside)).outcome).toEqual({
			status: "refused",
			reason: "No one to ask: the RPC host has not enabled access prompts (set_sandbox_access_prompts).",
		});
	});

	it("answers the worker realm's access requests only when main answers them at boot", async () => {
		expect(await probe.answersAccessRequests()).toBe(true);

		// Print mode or ACP: no host, no approver.
		await restartWorker();
		expect(await probe.answersAccessRequests()).toBe(false);

		// An SDK embedder that installs an approver without declaring a host.
		const asked: SandboxAccessRequest[] = [];
		approve(asked, async () => ({ decision: "session" }));
		await restartWorker();
		expect(await probe.answersAccessRequests()).toBe(true);
		expect((await probe.requestWrite(outside)).outcome).toEqual({
			status: "granted",
			scope: "session",
			target: outside,
		});
		expect(asked).toHaveLength(1);
	});
});

describe("sandbox thread service, worker side", () => {
	it("refuses a forwarded access request once the link to main is closed", async () => {
		// This realm stands in for a worker whose main went away mid-request.
		await sandboxThreadService.boot?.(
			{
				watchGrants: () => ({ seq: 0, value: { hosts: [], write: [], writeFiles: [], read: [], exec: [] } }),
				reportBlocked: () => undefined,
				answersAccessRequests: true,
				requestAccess: () => Promise.reject(new RpcClosedError("link closed")),
			} satisfies SandboxThreadGlobals,
			// The worker half never uses the link it boots on.
			{} as WorkerThreadLink,
		);
		expect(await main.requestAccess({ kind: "write", target: outside, intent: "Build the docs." })).toEqual({
			status: "refused",
			reason: "No one to ask: the main session this subagent reports to has ended.",
		});
	});
});
