import { afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { resolveOrDefaultProjectRegistryPath } from "@oh-my-pi/pi-coding-agent/discovery/helpers";
import {
	type InstalledPluginEntry,
	type InstalledPluginSummary,
	MarketplaceManager,
	type MarketplacePluginEntry,
	type MarketplaceRegistryEntry,
	readInstalledPluginsRegistry,
} from "@oh-my-pi/pi-coding-agent/extensibility/plugins/marketplace";
import { SelectorController } from "@oh-my-pi/pi-coding-agent/modes/controllers/selector-controller";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import { Container, type Component, initTheme, Text } from "@oh-my-pi/pi-tui";
import { PluginSelectorComponent } from "@oh-my-pi/pi-tui/overlays/plugin-selector";
import * as piUtils from "@oh-my-pi/pi-utils";

beforeAll(async () => {
	await initTheme();
});

afterEach(() => {
	vi.restoreAllMocks();
});

const PLUGIN_ID = "hello-plugin@test-marketplace";

function marketplaceEntry(name = "test-marketplace"): MarketplaceRegistryEntry {
	return {
		name,
		sourceType: "local",
		sourceUri: `C:\\tmp\\${name}`,
		catalogPath: `C:\\tmp\\${name}\\marketplace.json`,
		addedAt: "2026-01-02T03:04:05.000Z",
		updatedAt: "2026-01-02T03:04:05.000Z",
	};
}

function availablePlugin(name = "hello-plugin", version = "1.0.0"): MarketplacePluginEntry {
	return { name, source: `./plugins/${name}`, description: "A test plugin that greets", version };
}

function installedEntry(scope: InstalledPluginEntry["scope"], installPath: string): InstalledPluginEntry {
	return {
		scope,
		installPath,
		version: "1.0.0",
		installedAt: "2026-01-02T03:04:05.000Z",
		lastUpdated: "2026-01-02T03:04:05.000Z",
	};
}

function installedSummary(
	scope: InstalledPluginEntry["scope"],
	installPath = `C:\\tmp\\cache\\${scope}`,
	id = PLUGIN_ID,
): InstalledPluginSummary {
	return { id, scope, entries: [installedEntry(scope, installPath)] };
}

/**
 * Awaits the exact `showStatus` message the install callback emits, so tests
 * depend on the event rather than a duration.
 */
function createStatusRecorder() {
	const messages: string[] = [];
	const waiters: Array<{ predicate: (message: string) => boolean; resolve: (message: string) => void }> = [];

	const showStatus = vi.fn((message: string) => {
		messages.push(message);
		for (let i = waiters.length - 1; i >= 0; i--) {
			const waiter = waiters[i]!;
			if (waiter.predicate(message)) {
				waiters.splice(i, 1);
				waiter.resolve(message);
			}
		}
	});

	const waitForStatus = (predicate: (message: string) => boolean): Promise<string> => {
		const seen = messages.find(predicate);
		if (seen !== undefined) return Promise.resolve(seen);
		const settled = Promise.withResolvers<string>();
		waiters.push({ predicate, resolve: settled.resolve });
		return settled.promise;
	};

	return { showStatus, waitForStatus, messages };
}

/**
 * Tracks focus through `setFocus`: a fixed `getFocused()` would make the
 * editor-restore assertions vacuous, since `showSelector` snapshots focus.
 */
function createControllerHarness(...initialSlot: Component[]) {
	let focused: Component | undefined = initialSlot[0];
	const slot = new Container();
	for (const child of initialSlot) slot.addChild(child);

	const setFocus = vi.fn((next: Component) => {
		focused = next;
	});
	const requestRender = vi.fn();
	const status = createStatusRecorder();

	const ctx = {
		editor: new Text("editor", 0, 0),
		editorContainer: slot,
		ui: { getFocused: () => focused, setFocus, requestRender },
		showStatus: status.showStatus,
		showError: vi.fn(),
		sessionManager: { getCwd: () => "C:\\tmp\\project" },
	} as unknown as InteractiveModeContext;

	return { ctx, slot, setFocus, requestRender, ...status, controller: new SelectorController(ctx) };
}

/** Stub the marketplace surface the interactive install/uninstall branches touch. */
function stubManager(installed: InstalledPluginSummary[] = []) {
	const installSpy = spyOn(MarketplaceManager.prototype, "installPlugin").mockResolvedValue(
		installedEntry("project", "C:\\tmp\\cache\\installed"),
	);
	const uninstallSpy = spyOn(MarketplaceManager.prototype, "uninstallPlugin").mockResolvedValue(undefined);
	spyOn(MarketplaceManager.prototype, "listMarketplaces").mockResolvedValue([marketplaceEntry()]);
	spyOn(MarketplaceManager.prototype, "listAvailablePlugins").mockResolvedValue([availablePlugin()]);
	spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue(installed);
	return { installSpy, uninstallSpy };
}

/** Narrow the mounted selector without an unchecked cast. */
function mountedSelector(slot: Container): PluginSelectorComponent {
	const only = slot.children[0];
	if (!(only instanceof PluginSelectorComponent)) {
		throw new Error(`expected PluginSelectorComponent, got ${only?.constructor.name}`);
	}
	return only;
}

describe("SelectorController.showPluginSelector install scope prompt", () => {
	it("opens an interactive confirmation list before installing the chosen scope", async () => {
		const { installSpy, uninstallSpy } = stubManager();
		const askDialog = new Text("ask", 0, 0);
		const { slot, setFocus, showStatus, waitForStatus, controller } = createControllerHarness(askDialog);

		await controller.showPluginSelector("install");

		const selector = mountedSelector(slot);
		const pluginList = selector.getSelectList();
		const rendered = Bun.stripANSI(pluginList.render(100).join("\n"));
		expect(rendered).toContain("[project]");
		expect(rendered).toContain("[user]");

		selector.handleInput("\n");
		expect(installSpy).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
		expect(selector.title).toBe("Confirm plugin install");
		const confirmationList = selector.getSelectList();
		expect(confirmationList).not.toBe(pluginList);
		const confirmation = Bun.stripANSI(selector.render(100).join("\n"));
		expect(confirmation).toContain("hello-plugin@test-marketplace");
		expect(confirmation).toContain("project scope?");
		expect(confirmation).toContain("Writes to");
		expect(confirmation).toContain("Confirm");
		expect(confirmation).toContain("Cancel");

		selector.handleInput("\n");
		expect(installSpy).toHaveBeenCalledTimes(1);
		expect(installSpy).toHaveBeenCalledWith("hello-plugin", "test-marketplace", {
			force: false,
			scope: "project",
		});
		expect(uninstallSpy).not.toHaveBeenCalled();

		expect(await waitForStatus(message => message.startsWith("Installed "))).toBe(
			"Installed hello-plugin from test-marketplace",
		);
		expect(slot.children).toEqual([askDialog]);
		expect(setFocus).toHaveBeenLastCalledWith(askDialog);
	});

	it("installs to user scope from the user row and keeps force for an already-installed plugin", async () => {
		const { installSpy } = stubManager([installedSummary("user")]);
		const { slot, controller } = createControllerHarness(new Text("ask", 0, 0));

		await controller.showPluginSelector("install");

		const selector = mountedSelector(slot);
		selector.handleInput("\x1b[B"); // Down selects the user row
		selector.handleInput("\n"); // Open confirmation
		selector.handleInput("\n"); // Confirm

		expect(installSpy).toHaveBeenCalledTimes(1);
		expect(installSpy).toHaveBeenCalledWith("hello-plugin", "test-marketplace", {
			force: true,
			scope: "user",
		});
	});

	it("keeps a user-only install separate from the project row", async () => {
		const { installSpy } = stubManager([installedSummary("user")]);
		const { slot, controller } = createControllerHarness(new Text("ask", 0, 0));

		await controller.showPluginSelector("install");

		const selector = mountedSelector(slot);
		expect(selector.getSelectList().debugState().selectedItemLabel).toBe("hello-plugin@1.0.0 [project]");
		selector.handleInput("\x1b[B");
		expect(selector.getSelectList().debugState().selectedItemLabel).toBe("hello-plugin@1.0.0 [user] [installed]");
		selector.handleInput("\x1b[A");

		selector.handleInput("\n"); // Open project confirmation
		expect(Bun.stripANSI(selector.render(100).join("\n"))).not.toContain("Replaces current install.");
		selector.handleInput("\n"); // Confirm project install

		expect(installSpy).toHaveBeenCalledWith("hello-plugin", "test-marketplace", {
			force: false,
			scope: "project",
		});
	});

	it("keeps a project-only install separate from the user row", async () => {
		const { installSpy } = stubManager([installedSummary("project")]);
		const { slot, controller } = createControllerHarness(new Text("ask", 0, 0));

		await controller.showPluginSelector("install");

		const selector = mountedSelector(slot);
		expect(selector.getSelectList().debugState().selectedItemLabel).toBe("hello-plugin@1.0.0 [project] [installed]");
		selector.handleInput("\x1b[B");
		expect(selector.getSelectList().debugState().selectedItemLabel).toBe("hello-plugin@1.0.0 [user]");

		selector.handleInput("\n"); // Open user confirmation
		expect(Bun.stripANSI(selector.render(100).join("\n"))).not.toContain("Replaces current install.");
		selector.handleInput("\n"); // Confirm user install

		expect(installSpy).toHaveBeenCalledWith("hello-plugin", "test-marketplace", {
			force: false,
			scope: "user",
		});
	});

	it("Esc on confirmation returns to the plugin list without installing", async () => {
		const { installSpy } = stubManager();
		const { slot, showStatus, controller } = createControllerHarness(new Text("ask", 0, 0));

		await controller.showPluginSelector("install");

		const selector = mountedSelector(slot);
		const pluginList = selector.getSelectList();
		selector.handleInput("\n");
		selector.handleInput("\x1b");
		expect(installSpy).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
		expect(selector.title).toBe("Plugins");
		expect(selector.getSelectList()).toBe(pluginList);
	});
	it("selecting Cancel returns to the plugin list without installing", async () => {
		const { installSpy } = stubManager();
		const { slot, controller } = createControllerHarness(new Text("ask", 0, 0));

		await controller.showPluginSelector("install");

		const selector = mountedSelector(slot);
		const pluginList = selector.getSelectList();
		selector.handleInput("\n"); // Open confirmation
		selector.handleInput("\x1b[B"); // Select Cancel
		selector.handleInput("\n");

		expect(installSpy).not.toHaveBeenCalled();
		expect(selector.title).toBe("Plugins");
		expect(selector.getSelectList()).toBe(pluginList);
	});

	it("reports an install failure and never claims success", async () => {
		const { installSpy } = stubManager();
		installSpy.mockRejectedValue(new Error("network down"));
		const editor = new Text("editor", 0, 0);
		const { slot, waitForStatus, controller } = createControllerHarness(editor);

		await controller.showPluginSelector("install");

		const selector = mountedSelector(slot);
		selector.handleInput("\n"); // Open confirmation
		selector.handleInput("\n"); // Confirm

		expect(await waitForStatus(message => message.startsWith("Install failed"))).toBe(
			"Install failed: Error: network down",
		);
		expect(slot.children).toEqual([editor]);
	});

	it("Esc on the plugin list installs nothing and restores the editor", async () => {
		const { installSpy, uninstallSpy } = stubManager();
		const editor = new Text("editor", 0, 0);
		const { slot, setFocus, showStatus, controller } = createControllerHarness(editor);

		await controller.showPluginSelector("install");

		mountedSelector(slot).handleInput("\x1b");

		expect(installSpy).not.toHaveBeenCalled();
		expect(uninstallSpy).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
		expect(slot.children).toEqual([editor]);
		expect(setFocus).toHaveBeenLastCalledWith(editor);
	});
});

describe("SelectorController.showPluginSelector uninstall scope targeting", () => {
	it("uninstalls the chosen row only after selecting Confirm", async () => {
		const { installSpy, uninstallSpy } = stubManager([
			installedSummary("project", "C:\\tmp\\cache\\project"),
			installedSummary("user", "C:\\tmp\\cache\\user"),
		]);
		const editor = new Text("editor", 0, 0);
		const { slot, setFocus, showStatus, controller } = createControllerHarness(editor);

		await controller.showPluginSelector("uninstall");

		const selector = mountedSelector(slot);
		selector.handleInput("\n"); // Project row

		expect(uninstallSpy).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
		expect(selector.title).toBe("Confirm plugin uninstall");
		const confirmation = Bun.stripANSI(selector.render(100).join("\n"));
		expect(confirmation).toContain("hello-plugin@test-marketplace");
		expect(confirmation).toContain("project scope?");
		expect(confirmation).toContain("Removes from");
		expect(confirmation).toContain("Confirm");
		expect(confirmation).toContain("Cancel");

		selector.handleInput("\n"); // Confirm

		expect(uninstallSpy).toHaveBeenCalledWith(PLUGIN_ID, "project");
		expect(installSpy).not.toHaveBeenCalled();
		expect(slot.children).toEqual([editor]);
		expect(setFocus).toHaveBeenLastCalledWith(editor);
	});

	it("targets the user entry when the user row is chosen", async () => {
		const { uninstallSpy } = stubManager([
			installedSummary("project", "C:\\tmp\\cache\\project"),
			installedSummary("user", "C:\\tmp\\cache\\user"),
		]);
		const { slot, controller } = createControllerHarness(new Text("editor", 0, 0));

		await controller.showPluginSelector("uninstall");

		const selector = mountedSelector(slot);
		selector.handleInput("\x1b[B"); // Down selects the user entry
		selector.handleInput("\n"); // Open confirmation
		selector.handleInput("\n"); // Confirm

		expect(uninstallSpy).toHaveBeenCalledWith(PLUGIN_ID, "user");
	});

	it("Esc on uninstall confirmation returns to the list without removing", async () => {
		const { installSpy, uninstallSpy } = stubManager([installedSummary("project", "C:\\tmp\\cache\\project")]);
		const { slot, showStatus, controller } = createControllerHarness(new Text("editor", 0, 0));

		await controller.showPluginSelector("uninstall");

		const selector = mountedSelector(slot);
		const pluginList = selector.getSelectList();
		selector.handleInput("\n");
		selector.handleInput("\x1b");

		expect(uninstallSpy).not.toHaveBeenCalled();
		expect(installSpy).not.toHaveBeenCalled();
		expect(showStatus).not.toHaveBeenCalled();
		expect(selector.title).toBe("Plugins");
		expect(selector.getSelectList()).toBe(pluginList);
	});
});

describe("plugin install scope in a fresh unanchored project", () => {
	it("resolves the project registry inside the project and writes only the project entry", async () => {
		const tmpRoot = await fs.promises.mkdtemp(path.join(os.tmpdir(), "omp-scope-selector-"));
		const fakeHome = path.join(tmpRoot, "home");
		const project = path.join(fakeHome, "project");
		await fs.promises.mkdir(project, { recursive: true });

		// No real ancestor `.omp`/`.git`: the walk-up must stop at the fake home.
		const homeSpy = spyOn(os, "homedir").mockReturnValue(path.resolve(fakeHome));
		const pluginsDir = path.join(fakeHome, ".omp", "plugins");
		const pluginsSpy = spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		const marketplacesPath = path.join(fakeHome, ".omp", "marketplaces.json");
		const mktRegistrySpy = spyOn(piUtils, "getMarketplacesRegistryPath").mockReturnValue(marketplacesPath);

		try {
			const resolvedProjectRegistry = await resolveOrDefaultProjectRegistryPath(project);
			if (resolvedProjectRegistry === undefined) {
				throw new Error("expected the fresh-directory project registry fallback to resolve");
			}
			expect(resolvedProjectRegistry).toBe(path.join(project, ".omp", "plugins", "installed_plugins.json"));
			// No `.omp` exists yet, so the fallback produced this path, not directory detection.
			expect(fs.existsSync(path.join(project, ".omp"))).toBe(false);

			// Register a local fixture marketplace so a real install can run.
			const fixtureSource = path.join(import.meta.dir, "..", "..", "marketplace", "fixtures", "valid-marketplace");
			await fs.promises.cp(fixtureSource, path.join(tmpRoot, "marketplace"), { recursive: true });
			const userRegistryPath = path.join(pluginsDir, "installed_plugins.json");
			const manager = new MarketplaceManager({
				marketplacesRegistryPath: marketplacesPath,
				installedRegistryPath: userRegistryPath,
				projectInstalledRegistryPath: resolvedProjectRegistry,
				marketplacesCacheDir: path.join(pluginsDir, "cache", "marketplaces"),
				pluginsCacheDir: path.join(pluginsDir, "cache", "plugins"),
				clearPluginRootsCache: () => {},
			});
			await manager.addMarketplace(path.join(tmpRoot, "marketplace"));

			const { slot, waitForStatus, controller } = createControllerHarness(new Text("editor", 0, 0));
			// Only listing reads are stubbed; installPlugin stays real so the write is observed.
			spyOn(piUtils, "getProjectDir").mockReturnValue(project);
			spyOn(MarketplaceManager.prototype, "listMarketplaces").mockResolvedValue([marketplaceEntry()]);
			spyOn(MarketplaceManager.prototype, "listAvailablePlugins").mockResolvedValue([availablePlugin()]);
			spyOn(MarketplaceManager.prototype, "listInstalledPlugins").mockResolvedValue([]);

			await controller.showPluginSelector("install");

			const selector = mountedSelector(slot);
			selector.handleInput("\n"); // Open project confirmation
			// Nothing is written until the explicit Confirm choice.
			expect(fs.existsSync(resolvedProjectRegistry)).toBe(false);
			expect(fs.existsSync(userRegistryPath)).toBe(false);

			selector.handleInput("\n"); // Confirm install
			expect(await waitForStatus(message => message.startsWith("Installed "))).toBe(
				"Installed hello-plugin from test-marketplace",
			);

			const projectReg = await readInstalledPluginsRegistry(resolvedProjectRegistry);
			expect(projectReg.plugins[PLUGIN_ID]?.[0]?.scope).toBe("project");
			// The user registry must not have been written: Project means project only.
			expect(fs.existsSync(userRegistryPath)).toBe(false);
		} finally {
			homeSpy.mockRestore();
			pluginsSpy.mockRestore();
			mktRegistrySpy.mockRestore();
			await fs.promises.rm(tmpRoot, { recursive: true, force: true }).catch(() => {});
		}
	});
});
