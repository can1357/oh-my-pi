/**
 * `denyRead` entries below symlinked ancestors and through dangling links, and the egress proxy a
 * runtime owns being closed with it.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import {
	cfgSandboxDenyRead,
	cfgSandboxEnabled,
	cfgSandboxNetworkMode,
} from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import type { SandboxSupport } from "@oh-my-pi/pi-natives";
import { TempDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const PROXY_BACKEND: SandboxSupport = {
	supported: true,
	backend: "bubblewrap",
	proxy: true,
	warnings: [],
	networkMissing: [],
};

let state: SettingsTestState | undefined;
let settings: Settings;
let scratch: TempDir;
let root: string;
let workspace: string;
let outside: string;
let runtimes: SandboxRuntime[];

async function runtime(dir = workspace): Promise<SandboxRuntime> {
	const instance = await SandboxRuntime.for(dir);
	runtimes.push(instance);
	return instance;
}

/** Whether a TCP connection to `127.0.0.1:port` is accepted. */
async function accepts(port: number): Promise<boolean> {
	try {
		const socket = await Bun.connect({ hostname: "127.0.0.1", port, socket: { data() {} } });
		socket.end();
		return true;
	} catch {
		return false;
	}
}

beforeEach(async () => {
	state = beginSettingsTest();
	scratch = TempDir.createSync(path.join(os.homedir(), ".omp-sandbox-deny-proxy-"));
	root = fs.realpathSync(scratch.path());
	workspace = path.join(root, "workspace");
	outside = path.join(root, "outside");
	for (const dir of [workspace, outside]) fs.mkdirSync(dir);
	runtimes = [];
	SandboxRuntime.resetForTest(PROXY_BACKEND);
	settings = await Settings.init({ inMemory: true, cwd: workspace });
	cfgSandboxEnabled.set(settings, true);
});

afterEach(async () => {
	try {
		for (const instance of runtimes) await instance.dispose();
		SandboxRuntime.resetForTest();
	} finally {
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		scratch.removeSync();
	}
});

describe.skipIf(process.platform === "win32")("denyRead entries that do not exist", () => {
	it("denies a missing entry below a symlinked ancestor, named through the real directory", async () => {
		const real = path.join(outside, "real");
		fs.mkdirSync(real);
		const link = path.join(outside, "link");
		fs.symlinkSync(real, link);
		cfgSandboxDenyRead.set(settings, [path.join(link, "missing", "key")]);
		const instance = await runtime();
		const target = path.join(real, "missing", "key");
		expect(instance.accessDenial([{ kind: "read", target }])?.reason).toContain("denyRead");
		expect(() => instance.grantPath("read", target, "session")).toThrow(/denyRead/);
		// A sibling the entry does not name is not denied by it.
		const sibling = instance.accessDenial([{ kind: "read", target: path.join(real, "other") }]);
		expect(sibling?.reason ?? "").not.toContain("denyRead");
	});

	it("denies the target of an entry that is a dangling symlink, named where the link points", async () => {
		const link = path.join(outside, "dotfiles");
		const volume = path.join(outside, "volume");
		fs.symlinkSync(volume, link);
		cfgSandboxDenyRead.set(settings, [path.join(link, "key")]);
		const instance = await runtime();
		const target = path.join(volume, "key");
		expect(instance.accessDenial([{ kind: "read", target }])?.reason).toContain("denyRead");
		expect(() => instance.grantPath("read", target, "session")).toThrow(/denyRead/);
	});
});

describe("SandboxRuntime.dispose", () => {
	it("closes its own egress proxy while another runtime stays live", async () => {
		cfgSandboxNetworkMode.set(settings, "allowlist");
		const second = path.join(root, "second");
		fs.mkdirSync(second);
		const disposed = await runtime();
		const live = await runtime(second);
		const disposedUrl = await disposed.egressProxyUrl();
		const liveUrl = await live.egressProxyUrl();
		if (disposedUrl === undefined || liveUrl === undefined) throw new Error("allowlist mode has no proxy");
		const disposedPort = Number(new URL(disposedUrl).port);
		const livePort = Number(new URL(liveUrl).port);
		expect(await accepts(disposedPort)).toBe(true);
		await disposed.dispose();
		expect(await accepts(disposedPort)).toBe(false);
		expect(await accepts(livePort)).toBe(true);
	});
});
