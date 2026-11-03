import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { MessageChannel } from "node:worker_threads";
import { initializeWithSettings, resetCapabilityForTests } from "../../src/capability";
import { type Rule, resetActiveRulesForTests, setActiveRules } from "../../src/capability/rule";
import { cfgDisabledProviders } from "../../src/config/model-settings";
import { Settings } from "../../src/config/settings";
import type { MainThreadLink, SubagentMainApi, SubagentWorkerApi } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import type { WorkerPeer } from "../../src/thread/services";
import { settingsThreadService } from "../../src/thread/services/settings";
import { cfgCompactionThresholdPercent } from "../../src/session/context-settings";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const THRESHOLD = cfgCompactionThresholdPercent.id;

/** Main-side view of the fixture's probe: every call is async across the link. */
type Probe = (op: string, ...args: unknown[]) => Promise<unknown>;

let worker: Worker | undefined;
let peer: WorkerPeer | undefined;
let testState: SettingsTestState | undefined;
let tmp = "";

beforeEach(() => {
	testState = beginSettingsTest();
	resetCapabilityForTests();
	resetActiveRulesForTests();
	tmp = fs.mkdtempSync(path.join(os.tmpdir(), "omp-settings-mirror-"));
});

afterEach(() => {
	if (peer) {
		settingsThreadService.onWorkerExit?.(peer, "test end");
		peer.link.close("test end");
	}
	peer = undefined;
	worker?.terminate();
	worker = undefined;
	resetCapabilityForTests();
	resetActiveRulesForTests();
	restoreSettingsTestState(testState);
	fs.rmSync(tmp, { recursive: true, force: true });
});

function makeDir(name: string): string {
	const dir = path.join(tmp, name);
	fs.mkdirSync(dir, { recursive: true });
	return dir;
}

/**
 * Main coalesces pushes per microtask; awaiting one turn runs that microtask, which posts the push
 * ahead of the next probe call on the same port.
 */
function pushes(): Promise<void> {
	return Promise.resolve();
}

function rule(name: string): Rule {
	return {
		name,
		path: `/rules/${name}.md`,
		content: name,
		_source: { provider: "test", providerName: "Test", path: `/rules/${name}.md`, level: "project" },
	};
}

async function startWorker(): Promise<Probe> {
	const spawned = new Worker(new URL("../fixtures/settings-mirror-worker.ts", import.meta.url).href, {
		type: "module",
	});
	worker = spawned;
	const channel = new MessageChannel();
	const counter = new SharedArrayBuffer(4);
	const { promise: ready, resolve } = Promise.withResolvers<void>();
	const onReady = (event: MessageEvent): void => {
		if (event.data?.ready) {
			spawned.removeEventListener("message", onReady);
			resolve();
		}
	};
	spawned.addEventListener("message", onReady);
	spawned.postMessage({ sync: channel.port2, counter }, [channel.port2]);
	await ready;
	const link: MainThreadLink = new RpcLink<SubagentMainApi, SubagentWorkerApi>(
		{
			send: frame => spawned.postMessage(frame),
			listen: handler => {
				const listener = (event: MessageEvent<RpcFrame>): void => handler(event.data);
				spawned.addEventListener("message", listener);
				return () => spawned.removeEventListener("message", listener);
			},
		},
		{ name: "main↔w1", syncReplies: { port: channel.port1, counter: new Int32Array(counter) } },
	);
	link.handle("ping", nonce => nonce);
	peer = { threadId: "w1", link };
	settingsThreadService.installMain?.(peer);
	let probe: Probe | undefined;
	await link.call("boot", {
		settings: settingsThreadService.globals?.(peer),
		probe: (registered: Probe) => {
			probe = registered;
		},
	});
	if (!probe) throw new Error("fixture did not register its probe");
	return probe;
}

describe("settings worker mirror", () => {
	it("installs main's global as the worker global and follows main set/override pushes", async () => {
		const cwd = makeDir("cwd");
		const global = await Settings.init({ inMemory: true, cwd, agentDir: makeDir("agent") });
		const probe = await startWorker();

		expect(await probe("keepGlobal")).toBe(true);
		expect(await probe("globalProxyCwd")).toBe(path.normalize(cwd));
		expect(await probe("get", "global", THRESHOLD)).toBe(-1);
		await probe("listen", "global", THRESHOLD);

		cfgCompactionThresholdPercent.set(global, 40);
		await pushes();
		expect(await probe("get", "global", THRESHOLD)).toBe(40);

		cfgCompactionThresholdPercent.override(global, 55);
		await pushes();
		expect(await probe("get", "global", THRESHOLD)).toBe(55);
		expect(await probe("events")).toEqual(["global=40", "global=55"]);

		// A persistent write on the mirror lands on main's global layer (main stays the single writer).
		expect(await probe("set", "global", THRESHOLD, 70)).toBe(55);
		cfgCompactionThresholdPercent.clearOverride(global);
		expect(cfgCompactionThresholdPercent.get(global)).toBe(70);
		await pushes();
		expect(await probe("get", "global", THRESHOLD)).toBe(70);

		// A runtime override on the mirror is main's override too, visible to the worker at once.
		expect(await probe("override", "global", THRESHOLD, 33)).toBe(33);
		expect(cfgCompactionThresholdPercent.get(global)).toBe(33);
		expect(await probe("events")).toEqual(["global=70", "global=33"]);

		expect(await probe("scoped", cwd, "global")).toEqual({ scoped: "global", inScope: "global" });
	});

	it("keeps worker overlays live on a mirror unless their own layers pin the value", async () => {
		const parent = Settings.isolated();
		const probe = await startWorker();

		expect(await probe("keep", "parent", parent)).toBe(true);
		await probe("keep", "again", parent);
		expect(await probe("same", "parent", "again")).toBe(true);

		await probe("overlay", "parent", "child", {});
		await probe("overlay", "parent", "pinned", { [THRESHOLD]: 20 });
		await probe("listen", "child", THRESHOLD);
		await probe("listen", "pinned", THRESHOLD);

		cfgCompactionThresholdPercent.set(parent, 60);
		await pushes();
		expect(await probe("get", "child", THRESHOLD)).toBe(60);
		expect(await probe("get", "pinned", THRESHOLD)).toBe(20);
		expect(await probe("events")).toEqual(["child=60"]);

		// Writes on a worker-created overlay stay local to the worker.
		expect(await probe("set", "child", THRESHOLD, 10)).toBe(10);
		expect(cfgCompactionThresholdPercent.get(parent)).toBe(60);

		// A main overlay mirrors as an overlay of its parent's mirror: own layers pin, the rest reads through.
		const pinnedOnMain = parent.overlay({ [THRESHOLD]: 25 }, { derived: true });
		const liveOnMain = parent.overlay();
		await probe("keep", "pinnedOnMain", pinnedOnMain);
		await probe("keep", "liveOnMain", liveOnMain);
		cfgCompactionThresholdPercent.set(parent, 65);
		await pushes();
		expect(await probe("get", "pinnedOnMain", THRESHOLD)).toBe(25);
		expect(await probe("get", "liveOnMain", THRESHOLD)).toBe(65);

		cfgCompactionThresholdPercent.override(liveOnMain, 15);
		await pushes();
		expect(await probe("get", "liveOnMain", THRESHOLD)).toBe(15);
		expect(await probe("get", "parent", THRESHOLD)).toBe(65);
	});

	it("never touches disk from the mirror", async () => {
		const agentDir = makeDir("ro-agent");
		const cwd = makeDir("ro-cwd");
		const readOnly = await Settings.loadReadOnly({ cwd, agentDir });
		const probe = await startWorker();

		expect(await probe("keep", "ro", readOnly)).toBe(true);
		expect(await probe("storage", "ro")).toBe(true);
		expect(await probe("set", "ro", THRESHOLD, 30)).toBe(30);
		await probe("overlay", "ro", "roChild", {});
		await probe("set", "roChild", THRESHOLD, 35);
		await probe("flush", "ro");
		await probe("flush", "roChild");

		expect(cfgCompactionThresholdPercent.get(readOnly)).toBe(30);
		expect(fs.readdirSync(agentDir)).toEqual([]);
		expect(fs.readdirSync(cwd)).toEqual([]);
	});

	it("inherits capability provider switches and active rules live", async () => {
		const bound = Settings.isolated();
		const release = initializeWithSettings(bound);
		setActiveRules([rule("a")]);
		const probe = await startWorker();

		await probe("keep", "bound", bound);
		expect(await probe("rules")).toEqual(["a"]);
		expect(await probe("switches")).toEqual({ disabled: [], bound: "bound" });

		cfgDisabledProviders.set(bound, ["cursor"]);
		setActiveRules([rule("a"), rule("b")]);
		await pushes();
		expect(await probe("switches")).toEqual({ disabled: ["cursor"], bound: "bound" });
		expect(await probe("rules")).toEqual(["a", "b"]);

		release();
		await pushes();
		expect(await probe("switches")).toEqual({ disabled: [], bound: null });
	});
});
