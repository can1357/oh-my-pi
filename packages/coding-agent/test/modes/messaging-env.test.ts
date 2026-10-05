import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@oh-my-pi/pi-agent-core";
import { resetSettingsForTest, Settings } from "../../src/config/settings";
import { executeBash, releaseShellSessions } from "../../src/exec/bash-executor";
import { execCommand, type ExecResult } from "../../src/exec/exec";
import {
	bindExtensionExecSession,
	ExtensionRuntime,
	loadExtensionFromFactory,
} from "../../src/extensibility/extensions/loader";
import type { ExtensionAPI } from "../../src/extensibility/extensions/types";
import { loadHooks } from "../../src/extensibility/hooks/loader";
import type { AgentSession } from "../../src/session/agent-session";
import { BashRunner } from "../../src/session/bash-runner";
import type { ClientBridge, ClientBridgeTerminalHandle } from "../../src/session/client-bridge";
import { SessionManager } from "../../src/session/session-manager";
import type { ToolSession } from "../../src/tools";
import { BashTool } from "../../src/tools/bash";
import { TempDir } from "@oh-my-pi/pi-utils";
import { EventBus } from "../../src/utils/event-bus";

const keys = ["OMP_MESSAGING_SOCKET", "OMP_MESSAGING_TOKEN"] as const;
const ownEnv = { OMP_MESSAGING_SOCKET: "own-socket", OMP_MESSAGING_TOKEN: "own-token" };
const inheritedEnv = { OMP_MESSAGING_SOCKET: "parent-socket", OMP_MESSAGING_TOKEN: "parent-token" };
const probe = 'printf "%s|%s" "${OMP_MESSAGING_SOCKET-unset}" "${OMP_MESSAGING_TOKEN-unset}"';
const execProbe =
	"process.stdout.write(JSON.stringify(Object.fromEntries(Object.entries(process.env).filter(([key]) => key.startsWith('OMP_MESSAGING_')))))";

function caller(enabled: boolean): AgentSession {
	return { messaging: enabled ? { env: ownEnv } : undefined } as unknown as AgentSession;
}

describe("session messaging command environments", () => {
	let temp: TempDir;
	const shellKeys = new Set<string>();

	beforeEach(async () => {
		temp = TempDir.createSync("@messaging-env-");
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: temp.path() });
		vi.spyOn(Settings.prototype, "getShellConfig").mockReturnValue({
			shell: process.platform === "win32" ? (Bun.env.ComSpec ?? "cmd.exe") : "/bin/sh",
			args: process.platform === "win32" ? ["/c"] : ["-c"],
			env: { PATH: Bun.env.PATH ?? "", HOME: temp.path(), ...inheritedEnv },
			prefix: undefined,
		});
	});

	afterEach(() => {
		for (const key of shellKeys) releaseShellSessions(key);
		shellKeys.clear();
		vi.restoreAllMocks();
		resetSettingsForTest();
		temp.removeSync();
	});

	function tool(session?: AgentSession, bridge?: ClientBridge): BashTool {
		const key = crypto.randomUUID();
		shellKeys.add(key);
		return new BashTool({
			cwd: temp.path(),
			hasUI: false,
			skills: [],
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
				"bash.direnv": "off",
			}),
			messagingSession: session,
			getSessionFile: () => null,
			getSessionId: () => key,
			getClientBridge: () => bridge,
		} as unknown as ToolSession);
	}

	it("native bash exposes only its owning session's credentials and removes cached parent credentials for helpers", async () => {
		const main = await tool(caller(true)).execute("main-env", { command: probe });
		const helper = await tool().execute("helper-env", { command: probe });
		expect(main.content.find(block => block.type === "text")?.text).toContain("own-socket|own-token");
		expect(helper.content.find(block => block.type === "text")?.text.split("\n")[0]).toBe("|");
	});

	it("user ! shell switches from own credentials to absent credentials when messaging is stopped", async () => {
		const session = caller(true);
		const manager = SessionManager.inMemory(temp.path());
		shellKeys.add(manager.getSessionId());
		const runner = new BashRunner({
			session,
			agent: new Agent(),
			sessionManager: manager,
			settings: Settings.isolated({ "bash.direnv": "off" }),
			extensionRunner: () => undefined,
			isStreaming: () => false,
		});
		try {
			expect((await runner.executeBash(probe)).output).toBe("own-socket|own-token");
			Object.assign(session, { messaging: undefined });
			expect((await runner.executeBash(probe)).output).toBe("|");
		} finally {
			await manager.close();
		}
	});

	it("strips cached and explicit forbidden keys before a helper's native shell executes", async () => {
		const key = crypto.randomUUID();
		shellKeys.add(key);
		const result = await executeBash(probe, {
			cwd: temp.path(),
			sessionKey: key,
			env: inheritedEnv,
			stripEnv: keys,
		});
		expect(result.exitCode).toBe(0);
		expect(result.output).toBe("|");
	});

	it("ACP terminal requests carry the caller's credentials without exposing another conversation's values", async () => {
		const handle: ClientBridgeTerminalHandle = {
			terminalId: "env-terminal",
			waitForExit: async () => ({ exitCode: 0, signal: null }),
			currentOutput: async () => ({ output: "done", truncated: false }),
			kill: async () => {},
			release: async () => {},
		};
		const bridge: ClientBridge = { capabilities: { terminal: true }, createTerminal: async () => handle };
		const create = vi.spyOn(bridge, "createTerminal");
		await tool(caller(true), bridge).execute("main-env", { command: "true" });
		await tool(caller(false), bridge).execute("helper-env", { command: "true" });
		expect(create.mock.calls[0]![0].env).toEqual(Object.entries(ownEnv).map(([name, value]) => ({ name, value })));
		expect(create.mock.calls[1]![0].env).toEqual([]);
	});

	it("isolated helpers cannot reuse credentials inherited by either Bun exec or the native C environment", async () => {
		const execPath = path.resolve(import.meta.dir, "../../src/exec/exec.ts");
		const bashPath = path.resolve(import.meta.dir, "../../src/exec/bash-executor.ts");
		const settingsPath = path.resolve(import.meta.dir, "../../src/config/settings.ts");
		const script = `import { execCommand } from ${JSON.stringify(execPath)};
			import { executeBash, releaseShellSessions } from ${JSON.stringify(bashPath)};
			import { Settings } from ${JSON.stringify(settingsPath)};
			await Settings.init({ inMemory: true, cwd: process.cwd() });
			const result = await execCommand(process.execPath, ["-e", ${JSON.stringify(execProbe)}], process.cwd());
			const bash = await executeBash(${JSON.stringify(probe)}, {
				cwd: process.cwd(), sessionKey: "helper", timeout: 10000, stripEnv: ${JSON.stringify(keys)},
			});
			releaseShellSessions("helper");
			process.stdout.write(JSON.stringify({ exec: JSON.parse(result.stdout), native: bash.output, code: bash.exitCode }));`;
		const result = await execCommand(process.execPath, ["-e", script], temp.path(), { env: inheritedEnv });
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ exec: {}, native: "|", code: 0 });
	});

	it("extension exec resolves its bound runtime session at execution time, never the process's parent credentials", async () => {
		let api!: ExtensionAPI;
		const runtime = new ExtensionRuntime();
		await loadExtensionFromFactory(
			extensionApi => {
				api = extensionApi;
			},
			temp.path(),
			new EventBus(),
			runtime,
		);
		const session = caller(true);
		bindExtensionExecSession(runtime, session);
		const own = await api.exec(process.execPath, ["-e", execProbe], { env: inheritedEnv });
		expect(own.code).toBe(0);
		expect(JSON.parse(own.stdout)).toEqual(ownEnv);
		Object.assign(session, { messaging: undefined });
		const disabled = await api.exec(process.execPath, ["-e", execProbe], { env: inheritedEnv });
		expect(disabled.code).toBe(0);
		expect(JSON.parse(disabled.stdout)).toEqual({});
	});

	it("legacy hook exec uses its explicit caller session and strips credentials when unbound", async () => {
		const hookPath = temp.join("hook.ts");
		await Bun.write(
			hookPath,
			`export default pi => {
			pi.on("env-probe", () => pi.exec(process.execPath, ["-e", ${JSON.stringify(execProbe)}], { env: ${JSON.stringify(inheritedEnv)} }));
		}`,
		);
		for (const enabled of [true, false]) {
			const result = await loadHooks([hookPath], temp.path(), enabled ? caller(true) : undefined);
			expect(result.errors).toEqual([]);
			const executed = (await result.hooks[0]!.handlers.get("env-probe")![0]!()) as ExecResult;
			expect(executed.code).toBe(0);
			expect(JSON.parse(executed.stdout)).toEqual(enabled ? ownEnv : {});
		}
	});
});
