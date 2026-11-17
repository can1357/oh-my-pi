import { type MessagePort, parentPort } from "node:worker_threads";
import { isRecord } from "@oh-my-pi/pi-utils";
import { boundSettings, getDisabledProviders } from "../../src/capability";
import { getActiveRules } from "../../src/capability/rule";
import { lookup } from "../../src/config/registry";
import { findScopedSettings, Settings, settings, withActiveSettings } from "../../src/config/settings";
import type { SubagentMainApi, SubagentWorkerApi, WorkerThreadLink } from "../../src/thread/protocol";
import { type RpcFrame, RpcLink } from "../../src/thread/rpc";
import { settingsThreadService } from "../../src/thread/services/settings";

/** Worker-side probe the test calls through the function it registers at boot. */
export type SettingsProbe = (op: string, ...args: unknown[]) => unknown;

const port = parentPort;
if (!port) throw new Error("fixture must run in a worker");

const kept = new Map<string, Settings>();
const events: string[] = [];

function instance(name: unknown): Settings {
	const found = typeof name === "string" ? kept.get(name) : undefined;
	if (!found) throw new Error(`no kept settings ${String(name)}`);
	return found;
}

function setting(id: unknown) {
	const found = typeof id === "string" ? lookup(id) : undefined;
	if (!found) throw new Error(`unknown setting ${String(id)}`);
	return found;
}

function nameOf(target: Settings | undefined): string | null {
	for (const [name, candidate] of kept) if (candidate === target) return name;
	return null;
}

const probe: SettingsProbe = async (op, ...args) => {
	switch (op) {
		case "keep": {
			const [name, value] = args;
			if (typeof name !== "string" || !(value instanceof Settings)) throw new Error("keep expects a Settings");
			kept.set(name, value);
			return value.isMirror;
		}
		case "keepGlobal":
			kept.set("global", Settings.instance);
			return Settings.instance.isMirror;
		case "get":
			return setting(args[1]).get(instance(args[0]));
		case "globalProxyCwd":
			return settings.getCwd();
		case "set":
			setting(args[1]).set(instance(args[0]), args[2]);
			return setting(args[1]).get(instance(args[0]));
		case "override":
			setting(args[1]).override(instance(args[0]), args[2]);
			return setting(args[1]).get(instance(args[0]));
		case "overlay": {
			const [parent, child, overrides] = args;
			if (typeof child !== "string") throw new Error("overlay expects a child name");
			kept.set(child, instance(parent).overlay(isRecord(overrides) ? overrides : {}));
			return true;
		}
		case "listen": {
			const [name, id] = args;
			const target = instance(name);
			const handle = setting(id);
			target.onEffectiveChange([handle], () => {
				events.push(`${String(name)}=${String(handle.get(target))}`);
			});
			return true;
		}
		case "events":
			return events.splice(0);
		case "revision":
			return instance(args[0]).revision;
		case "scoped": {
			const [cwd, active] = args;
			const scoped = nameOf(findScopedSettings(typeof cwd === "string" ? cwd : undefined));
			const inScope = withActiveSettings(instance(active), () => nameOf(findScopedSettings()));
			return { scoped, inScope };
		}
		case "flush":
			await instance(args[0]).flush();
			return true;
		case "storage":
			return instance(args[0]).getStorage() === null;
		case "same":
			return instance(args[0]) === instance(args[1]);
		case "rules":
			return getActiveRules().map(rule => rule.name);
		case "switches":
			return { disabled: getDisabledProviders(), bound: nameOf(boundSettings()) };
		default:
			throw new Error(`unknown probe ${op}`);
	}
};

function isRegister(value: unknown): value is (probe: SettingsProbe) => Promise<void> {
	return typeof value === "function";
}

port.once("message", (init: { sync: MessagePort; counter: SharedArrayBuffer }) => {
	const link: WorkerThreadLink = new RpcLink<SubagentWorkerApi, SubagentMainApi>(
		{
			send: frame => port.postMessage(frame),
			listen: handler => {
				const listener = (frame: RpcFrame): void => handler(frame);
				port.on("message", listener);
				return () => port.off("message", listener);
			},
		},
		{ name: "settings-fixture", sync: { port: init.sync, counter: new Int32Array(init.counter) } },
	);
	settingsThreadService.installWorker?.(link);
	link.handle("boot", async globals => {
		await settingsThreadService.boot?.(globals.settings, link);
		const register = globals.probe;
		if (!isRegister(register)) throw new Error("boot expects a probe registrar");
		await register(probe);
	});
	link.handle("ping", nonce => nonce);
	port.postMessage({ ready: true });
});
