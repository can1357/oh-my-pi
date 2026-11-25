/**
 * Attribution of egress proxy refusals to the contained call that made them: by the proxy
 * credentials a call hands its commands, or by the proxy port of a spawn opened with an egress
 * scope the call watches. Requests with neither keep the time-based attribution.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { EgressProxy } from "@oh-my-pi/pi-coding-agent/sandbox/egress-proxy";
import {
	blockedHostsSince,
	blockedLog,
	EgressCall,
	egressOwners,
	grantHostIn,
	recordBlockedHost,
	resetGrantsForTest,
} from "@oh-my-pi/pi-coding-agent/sandbox/grants";
import { egressProxyEnv } from "@oh-my-pi/pi-coding-agent/sandbox/host";
import * as sandboxProcess from "@oh-my-pi/pi-coding-agent/sandbox/process";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import type { SandboxChild } from "@oh-my-pi/pi-coding-agent/sandbox/types";
import { cfgSandboxEnabled, cfgSandboxNetworkMode } from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import * as natives from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { captureEgressProxyHooks, SANDBOX_SUPPORTED } from "../helpers/sandbox-test-state";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const proxySupported =
	typeof natives.sandboxSupport === "function" && natives.sandboxSupport().supported && natives.sandboxSupport().proxy;

describe("egressProxyEnv", () => {
	const egress = { user: "omp", password: "secret" };

	it("puts a run's credentials into every proxy variable of the host, keeping its form", () => {
		expect(
			egressProxyEnv(egress, {
				HTTP_PROXY: "http://127.0.0.1:4000",
				https_proxy: "http://10.0.2.2:4000/",
				ALL_PROXY: "http://localhost:4000",
				PATH: "/usr/bin",
			}),
		).toEqual({
			HTTP_PROXY: "http://omp:secret@127.0.0.1:4000",
			https_proxy: "http://omp:secret@10.0.2.2:4000/",
			ALL_PROXY: "http://omp:secret@localhost:4000",
		});
	});

	it("leaves a proxy variable that is not an http:// URL alone, and gives nothing without one", () => {
		expect(
			egressProxyEnv(egress, { HTTPS_PROXY: "socks5://127.0.0.1:1080", ALL_PROXY: "not a url", NO_PROXY: "*" }),
		).toEqual({});
		expect(egressProxyEnv(egress, {})).toEqual({});
	});

	it("rewrites FTP_PROXY when it is the backend's own proxy (bubblewrap sets it to HTTP_PROXY's value)", () => {
		expect(
			egressProxyEnv(egress, {
				HTTP_PROXY: "http://10.0.2.2:4000",
				FTP_PROXY: "http://10.0.2.2:4000",
				ftp_proxy: "http://10.0.2.2:4000",
			}),
		).toEqual({
			HTTP_PROXY: "http://omp:secret@10.0.2.2:4000",
			FTP_PROXY: "http://omp:secret@10.0.2.2:4000",
			ftp_proxy: "http://omp:secret@10.0.2.2:4000",
		});
	});

	it("leaves a user's own FTP_PROXY alone: it differs from the backend's proxy, so its credentials are not the run's", () => {
		expect(
			egressProxyEnv(egress, {
				FTP_PROXY: "http://alice:secret@proxy.corp:3128",
				HTTP_PROXY: "http://127.0.0.1:4000",
			}),
		).toEqual({ HTTP_PROXY: "http://omp:secret@127.0.0.1:4000" });
	});
});

describe("egress call attribution", () => {
	const calls: EgressCall[] = [];
	function call(watch?: string[]): EgressCall {
		const created = new EgressCall(watch);
		calls.push(created);
		return created;
	}

	beforeEach(() => resetGrantsForTest());
	afterEach(() => {
		for (const created of calls.splice(0)) created.end();
		resetGrantsForTest();
	});

	it("hands each call its own random credentials", () => {
		const a = call();
		const b = call();
		expect(a.user).toBe("omp");
		expect(a.token).toMatch(/^[0-9a-f]{36}$/);
		expect(b.token).not.toBe(a.token);
	});

	it("owns a request by the live call's credentials, and not once the call ended or for unknown ones", () => {
		const a = call();
		const b = call();
		expect(egressOwners({ credential: `omp:${a.token}` })).toEqual([a]);
		expect(egressOwners({ credential: `omp:${b.token}` })).toEqual([b]);
		expect(egressOwners({ credential: "omp:not-a-token" })).toBeUndefined();
		// The password alone, or under another user, is not the call's credential.
		expect(egressOwners({ credential: `x:${a.token}` })).toBeUndefined();
		expect(egressOwners({})).toBeUndefined();
		a.end();
		expect(egressOwners({ credential: `omp:${a.token}` })).toBeUndefined();
	});

	it("owns a request by the listener it arrived on, for every live call watching it", () => {
		const a = call(["eval"]);
		const b = call(["eval", "pty:1"]);
		const other = call(["pty:2"]);
		expect(egressOwners({ listener: "eval" })).toEqual([a, b]);
		expect(egressOwners({ listener: "pty:1" })).toEqual([b]);
		expect(egressOwners({ listener: "pty:3" })).toBeUndefined();
		// Credentials and listener both name owners.
		expect(egressOwners({ listener: "pty:2", credential: `omp:${a.token}` })).toEqual([a, other]);
		b.end();
		expect(egressOwners({ listener: "eval" })).toEqual([a]);
		expect(egressOwners({ listener: "pty:1" })).toBeUndefined();
	});

	it("lists a call's own refused hosts once each, most recently refused last, dropping those granted since", () => {
		const a = call();
		recordBlockedHost("one.test", Date.now(), [a]);
		recordBlockedHost("two.test", Date.now(), [a]);
		recordBlockedHost("one.test", Date.now(), [a]);
		recordBlockedHost("other.test");
		expect(a.hosts()).toEqual(["two.test", "one.test"]);
		grantHostIn(Settings.isolated(), "two.test", "session");
		expect(a.hosts()).toEqual(["one.test"]);
	});

	it("keeps unattributed refusals in every call's time window and leaves out those of other calls", () => {
		const since = Date.now();
		const a = call();
		const b = call();
		recordBlockedHost("mine.test", since, [a]);
		recordBlockedHost("theirs.test", since, [b]);
		recordBlockedHost("anyone.test", since);
		recordBlockedHost("both.test", since, [b]);
		recordBlockedHost("both.test", since);
		expect(blockedHostsSince(since, a).sort()).toEqual(["anyone.test", "both.test", "mine.test"]);
		expect(blockedHostsSince(since, b).sort()).toEqual(["anyone.test", "both.test", "theirs.test"]);
		// A caller without a call sees only what no call owns.
		expect(blockedHostsSince(since).sort()).toEqual(["anyone.test", "both.test"]);
		// Refusals before the window are out, as before.
		expect(blockedHostsSince(since + 1, a)).toEqual([]);
	});

	it("leaves nothing out once the window reaches past the refusals it kept", () => {
		const t0 = Date.now();
		const other = call();
		// An unattributed refusal that falls off the ring, then the same host refused to another call.
		recordBlockedHost("x.test", t0);
		recordBlockedHost("x.test", t0 + 1, [other]);
		for (let i = 0; i < 1023; i++) recordBlockedHost(`filler-${i % 8}.test`, t0 + 2);
		// Only the ring knows the unattributed refusal is gone: the window may still hold it.
		expect(blockedHostsSince(t0, call())).toContain("x.test");
	});

	it("never moves the window floor back for a late refusal a worker realm reports", () => {
		const t0 = Date.now();
		const other = call();
		recordBlockedHost("x.test", t0 + 10);
		// A late report with an older time, evicted right after the unattributed refusal.
		recordBlockedHost("late.test", t0);
		recordBlockedHost("x.test", t0 + 11, [other]);
		for (let i = 0; i < 1023; i++) recordBlockedHost(`filler-${i % 8}.test`, t0 + 12);
		expect(blockedHostsSince(t0 + 5, call())).toContain("x.test");
	});
});

describe("SandboxRuntime egress calls", () => {
	let settingsState: SettingsTestState;
	let scratch: TempDir;
	let workspace: string;
	let settings: Settings;

	beforeEach(async () => {
		settingsState = beginSettingsTest();
		scratch = TempDir.createSync(path.join(os.homedir(), ".omp-egress-attribution-"));
		workspace = path.join(fs.realpathSync(scratch.path()), "workspace");
		fs.mkdirSync(workspace);
		settings = await Settings.init({ inMemory: true, cwd: workspace });
		cfgSandboxEnabled.set(settings, true);
		cfgSandboxNetworkMode.set(settings, "allowlist");
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			await (await SandboxRuntime.for(workspace)).dispose();
			SandboxRuntime.resetForTest();
		} finally {
			restoreSettingsTestState(settingsState);
			AgentStorage.close();
			scratch.removeSync();
		}
	});

	it("begins a call only while the effective network mode is allowlist", async () => {
		SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
		const runtime = await SandboxRuntime.for(workspace);
		const call = runtime.beginEgressCall();
		expect(call).toBeInstanceOf(EgressCall);
		call?.end();
		cfgSandboxNetworkMode.set(settings, "deny");
		expect(runtime.beginEgressCall()).toBeUndefined();
		cfgSandboxNetworkMode.set(settings, "allow");
		expect(runtime.beginEgressCall()).toBeUndefined();
		cfgSandboxEnabled.set(settings, false);
		cfgSandboxNetworkMode.set(settings, "allowlist");
		expect(runtime.beginEgressCall()).toBeUndefined();
	});

	it("fails capturing a proxy's hooks when the runtime starts none, rather than waiting for one", async () => {
		SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
		cfgSandboxNetworkMode.set(settings, "deny");
		await expect(captureEgressProxyHooks(workspace)).rejects.toThrow("returned without starting an EgressProxy");
	});

	it("attributes the proxy's refusals by their origin and reports them on the owning call's result", async () => {
		SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
		const runtime = await SandboxRuntime.for(workspace);
		const hooks = await captureEgressProxyHooks(workspace);
		const since = Date.now();
		const mine = runtime.beginEgressCall()!;
		const theirs = runtime.beginEgressCall(["eval"])!;
		try {
			hooks.onBlocked?.("mine.test", 443, { credential: `omp:${mine.token}` });
			hooks.onBlocked?.("theirs.test", 443, { listener: "eval" });
			hooks.onBlocked?.("anyone.test", 443, {});
			const meta = runtime.resultMeta({ blockedSince: since, call: mine });
			expect(meta?.ownBlockedHosts).toEqual(["mine.test"]);
			expect(meta?.blockedHosts?.sort()).toEqual(["anyone.test", "mine.test"]);
			expect(runtime.resultMeta({ blockedSince: since, call: theirs })?.ownBlockedHosts).toEqual(["theirs.test"]);
			// Without a call there is nothing of its own; the time window keeps what no call owns.
			const anonymous = runtime.resultMeta({ blockedSince: since });
			expect(anonymous?.ownBlockedHosts).toBeUndefined();
			expect(anonymous?.blockedHosts).toEqual(["anyone.test"]);
			// The panel still lists every refusal.
			expect([...runtime.blockedHosts()].sort()).toEqual(["anyone.test", "mine.test", "theirs.test"]);
			expect([...blockedLog.keys()].sort()).toEqual(["anyone.test", "mine.test", "theirs.test"]);
		} finally {
			mine.end();
			theirs.end();
		}
	});

	describe("a spawn's own proxy port", () => {
		/** Proxy ports the runtime opened (`id`, URL handed to the backend, whether it was retired or closed). */
		let opened: { id: string; url: string; retired: boolean; closed: boolean }[];
		let policies: { proxyUrl?: string }[];

		beforeEach(() => {
			opened = [];
			policies = [];
			vi.spyOn(EgressProxy, "start").mockImplementation(
				async () =>
					({
						url: "http://127.0.0.1:9",
						port: 9,
						close: async () => {},
						openListener(id: string) {
							const listener = {
								id,
								url: `http://127.0.0.1:${100 + opened.length}`,
								retired: false,
								closed: false,
							};
							opened.push(listener);
							return {
								id,
								url: listener.url,
								port: 0,
								retire: () => {
									listener.retired = true;
								},
								close: () => {
									listener.closed = true;
								},
							};
						},
					}) as unknown as EgressProxy,
			);
		});

		function fakeChild(exited: Promise<number>): SandboxChild {
			return { exited } as unknown as SandboxChild;
		}

		it("is opened only for a spawn with an egress scope, and retired (still bound) once the spawn exits", async () => {
			SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
			const runtime = await SandboxRuntime.for(workspace);
			const exit = Promise.withResolvers<number>();
			vi.spyOn(sandboxProcess, "spawnSandboxChild").mockImplementation(async options => {
				policies.push(options.policy as { proxyUrl?: string });
				return fakeChild(exit.promise);
			});
			const request = { argv: ["/usr/bin/true"], cwd: workspace, env: {} };
			await runtime.spawn(request);
			await runtime.spawn({ ...request, egressScope: "scope-a" });
			expect(opened.map(({ id }) => id)).toEqual(["scope-a"]);
			expect(policies.map(policy => policy.proxyUrl)).toEqual(["http://127.0.0.1:9", opened[0].url]);
			expect(opened[0].retired).toBe(false);
			exit.resolve(0);
			// The runtime's exit handler was registered first, so it has run once this await resumes.
			await exit.promise;
			// The sandbox allows that port for life: released, it could go to another local service.
			expect(opened[0]).toMatchObject({ retired: true, closed: false });
		});

		it("is closed when the spawn fails, and never opened outside allowlist mode", async () => {
			SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
			const runtime = await SandboxRuntime.for(workspace);
			vi.spyOn(sandboxProcess, "spawnSandboxChild").mockRejectedValue(new Error("backend refused"));
			const request = { argv: ["/usr/bin/true"], cwd: workspace, env: {}, egressScope: "scope-a" };
			await expect(runtime.spawn(request)).rejects.toThrow("backend refused");
			expect(opened).toHaveLength(1);
			expect(opened[0]).toMatchObject({ id: "scope-a", retired: false, closed: true });
			await expect(runtime.spawn({ ...request, network: "deny" })).rejects.toThrow("backend refused");
			expect(opened).toHaveLength(1);
		});
	});

	it.skipIf(!proxySupported || process.platform === "win32")(
		"gives a spawn with an egress scope its own proxy port, whose refusals belong to the calls watching it",
		async () => {
			SandboxRuntime.resetForTest();
			const runtime = await SandboxRuntime.for(workspace);
			const since = Date.now();
			const watching = runtime.beginEgressCall(["scope-a"])!;
			const other = runtime.beginEgressCall(["scope-b"])!;
			const curl = async (host: string, egressScope?: string): Promise<number> => {
				const child = await runtime.spawn({
					argv: ["/usr/bin/curl", "-s", "-o", "/dev/null", "--max-time", "10", `http://${host}/`],
					cwd: workspace,
					env: { PATH: "/usr/bin:/bin" },
					egressScope,
				});
				child.stdin.end();
				await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
				return child.exited;
			};
			try {
				// curl without `-f` exits 0 on the proxy's 403.
				expect(await curl("scoped.omp-sandbox-test.invalid", "scope-a")).toBe(0);
				expect(await curl("unscoped.omp-sandbox-test.invalid")).toBe(0);
				const meta = runtime.resultMeta({ blockedSince: since, call: watching });
				expect(meta?.ownBlockedHosts).toEqual(["scoped.omp-sandbox-test.invalid"]);
				// The unscoped spawn's refusal keeps its time-based attribution.
				expect(meta?.blockedHosts).toContain("unscoped.omp-sandbox-test.invalid");
				expect(runtime.resultMeta({ blockedSince: since, call: other })?.ownBlockedHosts).toBeUndefined();
				expect(runtime.resultMeta({ blockedSince: since, call: other })?.blockedHosts).toEqual([
					"unscoped.omp-sandbox-test.invalid",
				]);
			} finally {
				watching.end();
				other.end();
			}
		},
		30_000,
	);
});
