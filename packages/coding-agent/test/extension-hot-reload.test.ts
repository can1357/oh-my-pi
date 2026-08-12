import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { AuthStorage } from "../src/session/auth-storage";
import { ModelRegistry } from "../src/config/model-registry";
import { Settings } from "../src/config/settings";
import { loadExtensions } from "../src/extensibility/extensions/loader";
import { ExtensionRunner } from "../src/extensibility/extensions/runner";
import { SessionManager } from "../src/session/session-manager";
import { EventBus } from "../src/utils/event-bus";

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

function markers(): string[] {
	return (globalThis as { __ompReloadMarkers?: string[] }).__ompReloadMarkers ?? [];
}

function resetMarkers(): void {
	(globalThis as { __ompReloadMarkers?: string[] }).__ompReloadMarkers = [];
}

let modelRegistry: ModelRegistry;

beforeAll(async () => {
	const home = extensionDir();
	process.env.HOME = home;
	await Settings.init({ inMemory: true, cwd: home });
	Settings.instance.set("startup.quiet", true);
	const authStorage = await AuthStorage.create(path.join(home, "testauth.db"));
	modelRegistry = new ModelRegistry(authStorage, path.join(home, "models.yml"));
});

async function makeRunner(file: string) {
	const cwd = path.dirname(file);
	const events = new EventBus();
	const loaded = await loadExtensions([file], cwd, events);
	expect(loaded.errors).toEqual([]);
	const runner = new ExtensionRunner(
		loaded.extensions,
		loaded.runtime,
		cwd,
		SessionManager.inMemory(),
		modelRegistry,
	);
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

	test("timers from the previous load do not survive the swap", async () => {
		resetMarkers();
		const dir = extensionDir();
		const file = path.join(dir, "timer-extension.ts");

		// A polling extension: the exact shape that doubles up if the previous
		// instance's interval keeps firing alongside its replacement. Asserted
		// on the timer registry rather than by watching for stale ticks, since
		// "no longer running" cannot be observed by waiting without racing.
		writeFileSync(
			file,
			`export default function ext(pi) {
	pi.on("session_start", async (_event, ctx) => {
		ctx.setInterval(() => {}, 1000);
	});
}
`,
		);
		const runner = await makeRunner(file);
		await runner.emit({ type: "session_start" });
		expect(runner.managedTimerCount).toBe(1);

		await runner.reloadExtensions();

		// Exactly one: the previous instance's interval was cleared and the new
		// instance registered its own. Two would mean both copies are polling.
		expect(runner.managedTimerCount).toBe(1);

		runner.clearManagedTimers();
		expect(runner.managedTimerCount).toBe(0);
	});
});
