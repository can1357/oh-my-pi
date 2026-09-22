import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStorage } from "../src/session/auth-storage";
import { ModelRegistry } from "../src/config/model-registry";
import { cfgStartupQuiet } from "@oh-my-pi/pi-coding-agent/modes/settings";
import { Settings } from "../src/config/settings";
import { loadExtensions } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";
import { setAgentDir } from "@oh-my-pi/pi-utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

/**
 * `/reload-plugins` re-imports extension modules (issue: extension edits
 * previously required a full session restart, because nothing re-entered the
 * load path even though the import specifier already cache-busts).
 *
 * These tests exercise the property that actually matters to someone editing an
 * extension: after a reload, the NEW source is what runs.
 */

const tempDirs: string[] = [];

function extensionDir(): string {
	const dir = mkdtempSync(path.join(tmpdir(), "omp-ext-reload-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	authStorage?.close();
	authStorage = undefined;
	restoreSettingsTestState(settingsState);
	while (tempDirs.length > 0) {
		const dir = tempDirs.pop();
		if (dir) rmSync(dir, { recursive: true, force: true });
	}
});

/** An extension that records the marker it was compiled with on session_start. */
function extensionSource(marker: string): string {
	return `export default function ext(pi) {
	pi.on("session_start", async () => {
		globalThis.__ompReloadMarkers ??= [];
		globalThis.__ompReloadMarkers.push(${JSON.stringify(marker)});
	});
}
`;
}

function toolExtensionSource(marker: string): string {
	return `export default function ext(pi) {
	const { Type } = pi.typebox;
	pi.registerTool({
		name: "reload_probe",
		label: ${JSON.stringify(marker)} + "-initial",
		description: "Reload probe",
		parameters: Type.Object({}),
		async execute() { return { content: [{ type: "text", text: ${JSON.stringify(marker)} }], details: {} }; },
	});
	pi.on("session_start", () => {
		pi.registerTool({
			name: "reload_probe_late",
			label: ${JSON.stringify(marker)} + "-late",
			description: "Late reload probe",
			parameters: Type.Object({}),
			async execute() { return { content: [{ type: "text", text: ${JSON.stringify(marker)} }], details: {} }; },
		});
	});
}
`;
}

function markers(): string[] {
	return (globalThis as { __ompReloadMarkers?: string[] }).__ompReloadMarkers ?? [];
}

function resetMarkers(): void {
	(globalThis as { __ompReloadMarkers?: string[] }).__ompReloadMarkers = [];
}

let modelRegistry: ModelRegistry;
let authStorage: AuthStorage | undefined;
let settingsState: SettingsTestState;

beforeEach(async () => {
	settingsState = beginSettingsTest();
	const home = extensionDir();
	setAgentDir(home);
	await Settings.init({ inMemory: true, cwd: home });
	cfgStartupQuiet.set(Settings.instance, true);
	authStorage = await AuthStorage.create(path.join(home, "testauth.db"));
	modelRegistry = new ModelRegistry(authStorage, path.join(home, "models.yml"));
});

async function makeRunner(file: string) {
	const cwd = path.dirname(file);
	const events = new EventBus();
	const loaded = await loadExtensions([file], cwd, events);
	expect(loaded.errors).toEqual([]);
	const runner = new ExtensionRunner(loaded.extensions, loaded.runtime, cwd, SessionManager.inMemory(), modelRegistry);
	runner.setExtensionReloader(() => loadExtensions([file], cwd, events));
	return runner;
}

describe("extension hot reload", () => {
	test("reload runs the edited source, not the originally imported module", async () => {
		resetMarkers();
		const dir = extensionDir();
		const file = path.join(dir, "marker-extension.ts");

		writeFileSync(file, extensionSource("v1"));
		const runner = await makeRunner(file);
		await runner.emit({ type: "session_start" });
		expect(markers()).toEqual(["v1"]);

		// Edit the file the way a user would, then reload.
		writeFileSync(file, extensionSource("v2"));
		const result = await runner.reloadExtensions();

		expect(result).not.toBeNull();
		expect(result?.errors).toEqual([]);
		expect(result?.loaded).toBe(1);
		// The reload emits session_start itself; without that the new module is
		// loaded but inert, which is indistinguishable from reload not working.
		expect(markers()).toEqual(["v1", "v2"]);
	});

	test("teardown for a reload is distinguishable from a real shutdown", async () => {
		resetMarkers();
		const dir = extensionDir();
		const file = path.join(dir, "shutdown-reason-extension.ts");

		// Extensions that announce a session ending to something outside the
		// process (a bridge posting to a chat room, a transcript flush) must be
		// able to tell a reload apart, or they report an ending that did not
		// happen seconds before announcing a start.
		writeFileSync(
			file,
			`export default function ext(pi) {
	pi.on("session_start", async () => {
		globalThis.__ompReloadMarkers ??= [];
		globalThis.__ompReloadMarkers.push("start");
	});
	pi.on("session_shutdown", async (event) => {
		globalThis.__ompReloadMarkers.push("shutdown:" + String(event?.reason ?? "unset"));
	});
}
`,
		);
		const runner = await makeRunner(file);
		await runner.emit({ type: "session_start" });
		await runner.reloadExtensions();

		expect(markers()).toEqual(["start", "shutdown:reload", "start"]);

		// A real shutdown still reports as one, so existing handlers that do not
		// check `reason` keep working.
		await runner.emit({ type: "session_shutdown" });
		expect(markers()).toEqual(["start", "shutdown:reload", "start", "shutdown:unset"]);
	});

	test("a broken edit reports an error and leaves the session running", async () => {
		resetMarkers();
		const dir = extensionDir();
		const file = path.join(dir, "broken-extension.ts");

		writeFileSync(file, extensionSource("good"));
		const runner = await makeRunner(file);
		await runner.emit({ type: "session_start" });
		expect(markers()).toEqual(["good"]);

		// A syntax error mid-edit must not throw out of the reload: the user is
		// typing, and the session has to survive to be told about it.
		writeFileSync(file, "export default function ext(pi) { this is not valid typescript");
		const result = await runner.reloadExtensions();

		expect(result?.errors.length).toBe(1);
		expect(result?.loaded).toBe(0);
		expect(markers()).toEqual(["good"]);
	});

	test("reload refreshes initial and lifecycle-registered tools", async () => {
		const dir = extensionDir();
		const file = path.join(dir, "tool-extension.ts");
		writeFileSync(file, toolExtensionSource("v1"));
		const runner = await makeRunner(file);
		const labels: string[] = [];
		const unsubscribe = runner.onToolRegistered(tool => {
			labels.push(tool.definition.label);
		});

		writeFileSync(file, toolExtensionSource("v2"));
		await runner.reloadExtensions();

		expect(labels).toEqual(["v2-initial", "v2-late"]);
		unsubscribe();
	});

	test("reload stops old interval callbacks while the replacement keeps ticking", async () => {
		resetMarkers();
		const file = path.join(extensionDir(), "timer-extension.ts");
		writeFileSync(
			file,
			`export default pi => {
	pi.on("session_start", (_event, ctx) => {
		ctx.setInterval(() => globalThis.__ompReloadMarkers.push("v1"), 1000);
	});
};`,
		);
		const runner = await makeRunner(file);
		vi.useFakeTimers();
		try {
			await runner.emit({ type: "session_start" });
			vi.advanceTimersByTime(1000);
			expect(markers()).toEqual(["v1"]);
			writeFileSync(
				file,
				`export default pi => {
	pi.on("session_start", (_event, ctx) => {
		ctx.setInterval(() => globalThis.__ompReloadMarkers.push("v2"), 1000);
	});
};`,
			);
			await runner.reloadExtensions();
			vi.advanceTimersByTime(1000);
			expect(markers()).toEqual(["v1", "v2"]);
		} finally {
			runner.clearManagedTimers();
			vi.useRealTimers();
		}
	});
});
