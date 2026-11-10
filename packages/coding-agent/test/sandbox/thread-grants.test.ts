/**
 * Sandbox session state across a subagent worker link: main's session grants reach the worker
 * realm's replica, and the worker realm's proxy refusals reach main's blocked-host log.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import { sandboxThreadService } from "@oh-my-pi/pi-coding-agent/thread/services/sandbox";
import { TempDir } from "@oh-my-pi/pi-utils";
import type { SandboxGrantsProbe } from "../fixtures/sandbox-grants-worker";
import { initSandboxSettings, SANDBOX_SUPPORTED } from "../helpers/sandbox-test-state";
import { type ServiceWorker, startServiceWorker } from "../helpers/service-worker";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const HOST = "docs.example.test";

let state: SettingsTestState | undefined;
let scratch: TempDir;
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

beforeEach(async () => {
	state = beginSettingsTest();
	scratch = TempDir.createSync("@omp-sandbox-thread-");
	const root = fs.realpathSync(scratch.path());
	const agentDir = path.join(root, "agent");
	workspace = path.join(root, "workspace");
	outside = path.join(root, "outside");
	for (const dir of [agentDir, workspace, outside]) fs.mkdirSync(dir);
	SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
	await initSandboxSettings({ agentDir, workspace }, { global: { enabled: true } });
	main = await SandboxRuntime.for(workspace);
	started = await startServiceWorker<SandboxGrantsProbe>(
		new URL("../fixtures/sandbox-grants-worker.ts", import.meta.url),
		[sandboxThreadService],
	);
	probe = started.probe;
	await probe.open(agentDir, workspace);
});

afterEach(async () => {
	try {
		await started?.probe.dispose();
		await started?.stop();
		started = undefined;
		await main.dispose();
		SandboxRuntime.resetForTest();
	} finally {
		restoreSettingsTestState(state);
		state = undefined;
		scratch.removeSync();
	}
});

describe("sandbox thread service", () => {
	it("applies main's session host grants and revocations in the worker realm", async () => {
		expect(await probe.hostAllowed(HOST)).toBe(false);

		await main.grantHost(HOST, "session");
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

	it("records hosts the worker realm's proxy refused in main's blocked-host log", async () => {
		expect(main.blockedHosts()).toEqual([]);
		await probe.block("intranet.test");
		expect(main.blockedHosts()).toEqual(["intranet.test"]);
	});
});
