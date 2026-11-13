import { type MessagePort, parentPort } from "node:worker_threads";
import { Settings } from "../../src/config/settings";
import { recordBlockedHost, SandboxRuntime } from "../../src/sandbox/runtime";
import { setCurrentThreadId } from "../../src/thread/identity";
import type { WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import { sandboxThreadService } from "../../src/thread/services/sandbox";
import { SANDBOX_SUPPORTED } from "../helpers/sandbox-test-state";

/** Worker-realm sandbox operations the test drives; each crosses to main as an async function. */
export interface SandboxGrantsProbe {
	/** Opens this realm's runtime for `workspace` over in-memory settings with the sandbox enabled. */
	open(agentDir: string, workspace: string): Promise<void>;
	/** Whether this realm's access check already allows contained commands to reach `host`. */
	hostAllowed(host: string): Promise<boolean>;
	/** Writable roots of this realm's effective policy. */
	writable(): Promise<readonly string[]>;
	fingerprint(): Promise<string>;
	/** Records a refusal of `host`, as this realm's egress proxy does. */
	block(host: string): Promise<void>;
	dispose(): Promise<void>;
}

// Before boot: resetting later would wipe the replica the service seeds.
SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);

let runtime: SandboxRuntime | undefined;

function opened(): SandboxRuntime {
	if (!runtime) throw new Error("sandbox fixture: open() first");
	return runtime;
}

const probe: SandboxGrantsProbe = {
	async open(agentDir, workspace) {
		await Settings.init({ inMemory: true, agentDir, cwd: workspace, overrides: { "sandbox.enabled": true } });
		runtime = await SandboxRuntime.for(workspace);
	},
	async hostAllowed(host) {
		const outcome = await opened().requestAccess({ kind: "host", target: host, intent: "Fetch the docs." });
		return outcome.status === "already-allowed";
	},
	async writable() {
		return opened().effectivePolicy().readwritePaths;
	},
	async fingerprint() {
		return opened().fingerprint();
	},
	async block(host) {
		recordBlockedHost(host);
	},
	async dispose() {
		await runtime?.dispose();
		runtime = undefined;
	},
};

function isTestGlobals(value: unknown): value is { ready(probe: SandboxGrantsProbe): void } {
	return typeof value === "object" && value !== null && typeof Reflect.get(value, "ready") === "function";
}

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	setCurrentThreadId("w1");
	const link: WorkerThreadLink = new RpcLink(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame): void => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "sandbox-fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	sandboxThreadService.installWorker?.(link);
	link.handle("ping", nonce => nonce);
	link.handle("boot", async globals => {
		await sandboxThreadService.boot?.(globals[sandboxThreadService.name], link);
		const test = globals.test;
		if (!isTestGlobals(test)) throw new Error("sandbox fixture: missing test globals");
		await test.ready(probe);
	});
	port.postMessage({ ready: true });
});
