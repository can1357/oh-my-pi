/**
 * The pooled sandbox hosts of `shell-client`: which hosts a release retires, and when a contained
 * PTY starts its dedicated host. The pooled cases skip where no backend exists.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { executeBash } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import { cfgSandboxEnabled } from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import {
	acquireSandboxHost,
	releaseSandboxHosts,
	SandboxedPtySession,
	sandboxHostPids,
	sandboxHostPoolSize,
} from "@oh-my-pi/pi-coding-agent/sandbox/shell-client";
import {
	beginContainedSandboxTest,
	CONTAINED_SOURCE_RUNS,
	type ContainedSandboxTest,
	endContainedSandboxTest,
	failure,
	SANDBOX_BACKEND_PRESENT,
} from "../helpers/sandbox-test-state";

let fixture: ContainedSandboxTest;

beforeEach(async () => {
	fixture = await beginContainedSandboxTest("shell-client-pool");
});

afterEach(async () => {
	releaseSandboxHosts(undefined, fixture.workspace);
	releaseSandboxHosts("");
	await endContainedSandboxTest(fixture);
});

const PTY_START = { application: "/bin/true", args: [], cols: 80, rows: 24 };

describe("SandboxedPtySession.startArgv", () => {
	it("starts no host for a command cancelled before it began, and one for a live command", async () => {
		const runtime = await SandboxRuntime.for(fixture.workspace);
		const spawn = vi.spyOn(runtime, "spawn").mockRejectedValue(new Error("spawn refused"));
		const session = new SandboxedPtySession(runtime, { cwd: fixture.workspace });

		const aborted = await session.startArgv({ ...PTY_START, signal: AbortSignal.abort() });
		expect(aborted).toEqual({ exitCode: undefined, cancelled: true, timedOut: false });
		expect(spawn).not.toHaveBeenCalled();

		const killed = new SandboxedPtySession(runtime, { cwd: fixture.workspace });
		killed.kill();
		expect(await killed.startArgv(PTY_START)).toEqual({ exitCode: undefined, cancelled: true, timedOut: false });
		expect(spawn).not.toHaveBeenCalled();

		const error = await failure(session.startArgv({ ...PTY_START, signal: new AbortController().signal }));
		expect((error as Error).message).toBe("spawn refused");
		expect(spawn).toHaveBeenCalledTimes(1);
	});
});

describe.skipIf(!SANDBOX_BACKEND_PRESENT || !CONTAINED_SOURCE_RUNS)("anonymous host pool", () => {
	let otherWorkspace: string;

	beforeEach(() => {
		otherWorkspace = path.join(path.dirname(fixture.workspace), "other-workspace");
		fs.mkdirSync(otherWorkspace);
	});

	afterEach(async () => {
		releaseSandboxHosts(undefined, otherWorkspace);
		await (await SandboxRuntime.for(otherWorkspace)).dispose();
	});

	it("never retires the anonymous hosts of any workspace for a caller without a session key", async () => {
		const first = await SandboxRuntime.for(fixture.workspace);
		const second = await SandboxRuntime.for(otherWorkspace);
		await acquireSandboxHost(first, { agentSessionKey: undefined, cwd: fixture.workspace, network: "deny" });
		await acquireSandboxHost(second, { agentSessionKey: undefined, cwd: otherWorkspace, network: "deny" });
		expect(sandboxHostPoolSize(undefined, fixture.workspace)).toBe(1);
		expect(sandboxHostPoolSize(undefined, otherWorkspace)).toBe(1);

		releaseSandboxHosts(undefined);
		expect(sandboxHostPoolSize(undefined, fixture.workspace)).toBe(1);
		expect(sandboxHostPoolSize(undefined, otherWorkspace)).toBe(1);

		// An empty session key is a session of its own, not the anonymous pool.
		releaseSandboxHosts("");
		expect(sandboxHostPoolSize(undefined, fixture.workspace)).toBe(1);
		expect(sandboxHostPoolSize(undefined, otherWorkspace)).toBe(1);

		releaseSandboxHosts(undefined, fixture.workspace);
		expect(sandboxHostPoolSize(undefined, fixture.workspace)).toBe(0);
		expect(sandboxHostPoolSize(undefined, otherWorkspace)).toBe(1);
	});

	it("keeps another workspace's anonymous host when one workspace's policy changes", async () => {
		const first = await SandboxRuntime.for(fixture.workspace);
		const second = await SandboxRuntime.for(otherWorkspace);
		await acquireSandboxHost(second, { agentSessionKey: undefined, cwd: otherWorkspace, network: "deny" });
		const otherPids = await sandboxHostPids(undefined, otherWorkspace);
		expect(otherPids).toHaveLength(1);
		await acquireSandboxHost(first, { agentSessionKey: undefined, cwd: fixture.workspace, network: "deny" });
		// The same workspace under another host scope retires its older anonymous host only.
		await acquireSandboxHost(first, {
			agentSessionKey: undefined,
			cwd: fixture.workspace,
			network: "deny",
			extraWrite: [fixture.outside],
		});
		expect(sandboxHostPoolSize(undefined, fixture.workspace)).toBe(1);
		expect(await sandboxHostPids(undefined, otherWorkspace)).toEqual(otherPids);
	});

	it("scopes a session's hosts, the empty key included, to the workspace a release names", async () => {
		const first = await SandboxRuntime.for(fixture.workspace);
		const second = await SandboxRuntime.for(otherWorkspace);
		await acquireSandboxHost(first, { agentSessionKey: "", cwd: fixture.workspace, network: "deny" });
		await acquireSandboxHost(second, { agentSessionKey: "", cwd: otherWorkspace, network: "deny" });
		await acquireSandboxHost(first, { agentSessionKey: undefined, cwd: fixture.workspace, network: "deny" });
		const otherPids = await sandboxHostPids("", otherWorkspace);
		expect(otherPids).toHaveLength(1);
		expect(sandboxHostPoolSize("")).toBe(2);

		// A policy change in one workspace retires that workspace's host of the session only.
		await acquireSandboxHost(first, {
			agentSessionKey: "",
			cwd: fixture.workspace,
			network: "deny",
			extraWrite: [fixture.outside],
		});
		expect(sandboxHostPoolSize("", fixture.workspace)).toBe(1);
		expect(await sandboxHostPids("", otherWorkspace)).toEqual(otherPids);

		releaseSandboxHosts("", fixture.workspace);
		expect(sandboxHostPoolSize("", fixture.workspace)).toBe(0);
		expect(sandboxHostPoolSize("", otherWorkspace)).toBe(1);

		// Without a workspace a session key names all of its hosts, never the anonymous pool's.
		releaseSandboxHosts("");
		expect(sandboxHostPoolSize("")).toBe(0);
		expect(sandboxHostPoolSize(undefined, fixture.workspace)).toBe(1);
	});

	it("retires only the anonymous hosts of the workspace an unsandboxed executeBash names", async () => {
		const first = await SandboxRuntime.for(fixture.workspace);
		const second = await SandboxRuntime.for(otherWorkspace);
		await acquireSandboxHost(first, { agentSessionKey: undefined, cwd: fixture.workspace, network: "deny" });
		await acquireSandboxHost(second, { agentSessionKey: undefined, cwd: otherWorkspace, network: "deny" });
		await acquireSandboxHost(first, { agentSessionKey: "", cwd: fixture.workspace, network: "deny" });

		cfgSandboxEnabled.set(fixture.settings, false);
		// Named through a symlink: the release resolves it to the workspace the runtime pinned.
		const alias = path.join(path.dirname(fixture.workspace), "workspace-alias");
		fs.symlinkSync(fixture.workspace, alias);
		const result = await executeBash("true", { cwd: fixture.workspace, sandboxWorkspace: alias });
		expect(result.exitCode).toBe(0);

		expect(sandboxHostPoolSize(undefined, fixture.workspace)).toBe(0);
		expect(sandboxHostPoolSize(undefined, otherWorkspace)).toBe(1);
		expect(sandboxHostPoolSize("", fixture.workspace)).toBe(1);
	});
});
