import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { RpcClient, RpcCommandError } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { RpcSandboxFrame, RpcSandboxUpdateFrame } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SANDBOX_UNAVAILABLE as UNAVAILABLE } from "./helpers/sandbox-test-state";

/** Settle a request before `expect` sees it. */
async function rejectionOf(request: Promise<unknown>): Promise<RpcCommandError> {
	const error = await request.then(
		() => new Error("expected the request to fail"),
		(caught: unknown) => caught,
	);
	expect(error).toBeInstanceOf(RpcCommandError);
	return error as RpcCommandError;
}

describe("sandbox over RPC", () => {
	let client: RpcClient | undefined;
	let temp: TempDir | undefined;

	afterEach(async () => {
		await client?.stop();
		client = undefined;
		await temp?.remove();
		temp = undefined;
	});

	/** An RPC server over a real session whose sandbox backend probe reports `support`. */
	async function start(env: Record<string, string>): Promise<{ client: RpcClient; frames: RpcSandboxFrame[] }> {
		temp = await TempDir.create("@omp-rpc-sandbox-client-");
		const sourceDir = path.resolve(import.meta.dir, "../src");
		const fixture = temp.join("runtime.ts");
		await Bun.write(
			fixture,
			`
import { createAgentSession, Settings } from ${JSON.stringify(path.join(sourceDir, "sdk.ts"))};
import { runRpcMode } from ${JSON.stringify(path.join(sourceDir, "modes/rpc/rpc-mode.ts"))};
import { SandboxRuntime } from ${JSON.stringify(path.join(sourceDir, "sandbox/runtime.ts"))};
globalThis.fetch = async () => { throw new Error("Offline sandbox fixture refuses network"); };
SandboxRuntime.resetForTest(JSON.parse(Bun.env.SANDBOX_TEST_SUPPORT));
const { session } = await createAgentSession({
  cwd: process.cwd(),
  toolNames: [],
  enableMCP: false,
  enableLsp: false,
  disableExtensionDiscovery: true,
  settings: Settings.isolated({ "compaction.enabled": false }),
});
await runRpcMode(session);
`,
		);
		const workspace = temp.join("workspace");
		fs.mkdirSync(workspace);
		const frames: RpcSandboxFrame[] = [];
		client = new RpcClient({
			command: [process.execPath, fixture],
			cwd: workspace,
			env: {
				HOME: temp.join("home"),
				PI_CODING_AGENT_DIR: temp.join("agent"),
				XDG_CONFIG_HOME: temp.join("config"),
				XDG_DATA_HOME: temp.join("data"),
				XDG_CACHE_HOME: temp.join("cache"),
				PI_NO_TITLE: "1",
				PI_SANDBOX: "0",
				SANDBOX_TEST_SUPPORT: JSON.stringify(UNAVAILABLE),
				...env,
			},
		});
		client.onSandbox(frame => frames.push(frame));
		await client.start();
		return { client, frames };
	}

	function nextUpdate(rpc: RpcClient): Promise<RpcSandboxUpdateFrame> {
		const { promise, resolve } = Promise.withResolvers<RpcSandboxUpdateFrame>();
		const unsubscribe = rpc.onSandbox(frame => {
			if (frame.type !== "sandbox_update") return;
			unsubscribe();
			resolve(frame);
		});
		return promise;
	}

	test("an enabled but unavailable sandbox is pushed after ready, reported by get_state and get_sandbox, and locked by $PI_SANDBOX", async () => {
		const { client: rpc, frames } = await start({ PI_SANDBOX: "1" });
		const pushed = frames.find(frame => frame.type === "sandbox_update") ?? (await nextUpdate(rpc));
		expect(pushed.state.status).toEqual({ state: "unavailable", reason: UNAVAILABLE.reason, fallback: "warn" });
		expect(fs.realpathSync(pushed.state.workspace)).toBe(fs.realpathSync(temp?.join("workspace") ?? ""));
		expect((await rpc.getState()).sandbox).toEqual({ state: "unavailable" });
		expect(await rpc.getSandbox()).toEqual(pushed.state);
		// $PI_SANDBOX decides `enabled`: a write would be shadowed, so it is refused.
		expect((await rejectionOf(rpc.setSandboxSetting("enabled", false))).code).toBe("sandbox_locked");
		expect((await rpc.getSandbox()).settings.enabled).toBe(true);
	}, 30_000);

	test("mutations answer and push the new state; refusals carry their codes", async () => {
		const { client: rpc } = await start({});
		const initial = await rpc.getSandbox();
		expect(initial.status).toEqual({ state: "off" });
		expect(initial.hostPrompts).toBe(false);

		const pushed = nextUpdate(rpc);
		const answered = await rpc.setSandboxSetting("networkMode", "deny");
		expect(answered.settings.networkMode).toBe("deny");
		expect((await pushed).state.settings.networkMode).toBe("deny");

		expect((await rpc.editSandboxList("allowRead", "add", "/opt/data")).settings.allowRead).toEqual(["/opt/data"]);
		expect((await rpc.resetSandboxSetting("allowRead")).settings.allowRead).toEqual([]);
		expect((await rpc.grantSandboxHost("api.test", "session")).sessionHosts).toEqual(["api.test"]);
		expect((await rpc.revokeSandboxHost("api.test")).sessionHosts).toEqual([]);
		expect(await rpc.setSandboxHostPrompts(true)).toBe(true);
		expect((await rpc.getSandbox()).hostPrompts).toBe(true);

		expect((await rejectionOf(rpc.setSandboxSetting("mode", "everything"))).code).toBe("invalid_value");
		expect((await rejectionOf(rpc.respondSandboxHost("missing", "deny"))).code).toBe("unknown_request");

		const target = temp?.join("granted") ?? "";
		fs.mkdirSync(target);
		const granted = await rpc.grantSandboxPath("write", target);
		expect(granted.sessionPaths.write.map(entry => fs.realpathSync(entry))).toEqual([fs.realpathSync(target)]);
		expect((await rpc.revokeSandboxPath("write", target)).sessionPaths).toEqual({ write: [], read: [] });
		expect(await rpc.setSandboxAccessPrompts(true)).toBe(true);
		expect((await rpc.getSandbox()).accessPrompts).toBe(true);
		const blank = await rejectionOf(rpc.respondSandboxAccess("missing", { decision: "instruct", instructions: " " }));
		expect(blank.code).toBe("invalid_value");
		expect((await rejectionOf(rpc.respondSandboxAccess("missing", { decision: "deny" }))).code).toBe(
			"unknown_request",
		);
	}, 30_000);

	test("moving the session with /move pushes the new workspace's state", async () => {
		const { client: rpc } = await start({});
		const moved = temp?.join("moved") ?? "";
		fs.mkdirSync(moved);
		const pushed = nextUpdate(rpc);
		await rpc.prompt(`/move ${moved}`);
		const state = (await pushed).state;
		expect(fs.realpathSync(state.workspace)).toBe(fs.realpathSync(moved));
		expect(fs.realpathSync((await rpc.getSandbox()).workspace)).toBe(fs.realpathSync(moved));
	}, 30_000);
});
