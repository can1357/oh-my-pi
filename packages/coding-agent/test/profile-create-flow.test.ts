/**
 * Controller-level create-flow tests: drive the REAL SelectorController and
 * ProfileManagerComponent through N → name → role prompts → save, verifying
 * persistence, cancellation atomicity, duplicate-name merge, invalid-name
 * rejection, and global-scope targeting. No TTY required.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Input } from "@oh-my-pi/pi-tui";
import { TempDir } from "@oh-my-pi/pi-utils";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import type { ProfileManagerComponent } from "../src/modes/components/profile-manager";
import { SelectorController } from "../src/modes/controllers/selector-controller";
import { initTheme } from "../src/modes/theme/theme";
import type { InteractiveModeContext } from "../src/modes/types";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "./helpers/settings-test-state";

const YAML = Bun.YAML;

/** Wait until `cond` is true or the timeout elapses (async action chains). */
async function until(cond: () => boolean, what: string): Promise<void> {
	for (let i = 0; i < 200 && !cond(); i++) {
		await Bun.sleep(5);
	}
	expect(cond(), `timed out waiting for ${what}`).toBe(true);
}

describe("profile create flow (controller-level)", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let agentDir: string;
	let projectDir: string;
	let settings: Settings;
	let focusTargets: unknown[];
	let errorMessages: string[];

	beforeEach(async () => {
		await initTheme();
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@pi-create-flow-");
		agentDir = tempDir.join("agent");
		projectDir = tempDir.join("project");
		fs.mkdirSync(agentDir, { recursive: true });
		fs.mkdirSync(projectDir, { recursive: true });
		fs.writeFileSync(path.join(agentDir, "config.yml"), YAML.stringify({ modelRoles: { default: "provider/base" } }));
		resetSettingsForTest();
		settings = await Settings.loadIsolated({ cwd: projectDir, agentDir });
		focusTargets = [];
		errorMessages = [];
	});

	afterEach(() => {
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
		resetSettingsForTest();
	});

	function makeController(): ProfileManagerComponent {
		const ctx = {
			settings,
			showStatus: () => {},
			showError: (message: string) => errorMessages.push(message),
			ui: {
				showOverlay: () => ({ hide: () => {} }),
				setFocus: (target: unknown) => focusTargets.push(target),
				requestRender: () => {},
				invalidate: () => {},
			},
			focusActiveEditorArea: () => {},
		} as unknown as InteractiveModeContext;
		const controller = new SelectorController(ctx);
		controller.showProfileSelector();
		return focusTargets[0] as ProfileManagerComponent;
	}

	/** All prompt Inputs seen so far, in focus order (managers excluded). */
	function inputs(): Input[] {
		return focusTargets.filter((target): target is Input => target instanceof Input);
	}

	/** Wait for the Nth prompt Input (1-based) to appear. */
	async function waitInput(n: number, what: string): Promise<Input> {
		await until(() => inputs().length >= n, `${what} (input #${n})`);
		return inputs()[n - 1];
	}

	function globalDisk(): Record<string, unknown> {
		return YAML.parse(fs.readFileSync(path.join(agentDir, "config.yml"), "utf-8")) as Record<string, unknown>;
	}

	test("create with one role persists to global config", async () => {
		const manager = makeController();
		manager.handleInput("n");
		(await waitInput(1, "name prompt")).onSubmit?.("solo");
		// Role prompts: default, smol, slow, plan.
		(await waitInput(2, "default role")).onSubmit?.("provider/one");
		(await waitInput(3, "smol role")).onSubmit?.("");
		(await waitInput(4, "slow role")).onSubmit?.("");
		(await waitInput(5, "plan role")).onSubmit?.("");
		await until(
			() => (globalDisk().profiles as Record<string, unknown> | undefined)?.solo !== undefined,
			"profile flushed to disk",
		);
		expect(settings.getProfile("solo")?.modelRoles?.default).toBe("provider/one");
		expect((globalDisk().profiles as Record<string, unknown>).solo).toBeDefined();
		expect(fs.existsSync(path.join(projectDir, ".omp", "config.yml"))).toBe(false); // global only
	});

	test("create with multiple roles persists all provided roles", async () => {
		const manager = makeController();
		manager.handleInput("n");
		(await waitInput(1, "name prompt")).onSubmit?.("multi");
		(await waitInput(2, "default role")).onSubmit?.("provider/m1");
		(await waitInput(3, "smol role")).onSubmit?.("provider/m2");
		(await waitInput(4, "slow role")).onSubmit?.("");
		(await waitInput(5, "plan role")).onSubmit?.("");
		await until(() => settings.getProfile("multi") !== undefined, "profile persisted");
		const modelRoles = settings.getProfile("multi")?.modelRoles ?? {};
		expect(modelRoles.default).toBe("provider/m1");
		expect(modelRoles.smol).toBe("provider/m2");
		expect(modelRoles.slow).toBeUndefined();
	});

	test("cancel during role edit leaves no profile behind", async () => {
		const manager = makeController();
		manager.handleInput("n");
		(await waitInput(1, "name prompt")).onSubmit?.("ghost");
		await waitInput(2, "first role prompt");
		// Esc routes through the swapped-in prompt form's onCancel → abort.
		manager.handleInput("\x1b");
		await until(() => inputs().length >= 2 && focusTargets.at(-1) === manager, "editor aborted");
		await Bun.sleep(20);
		expect(settings.getProfile("ghost")).toBeUndefined();
		expect(globalDisk().profiles).toBeUndefined(); // nothing persisted
	});

	test("duplicate name creation merges over the existing definition", async () => {
		await settings.setProfile("global", "dupe", { description: "original", modelRoles: { slow: "provider/old" } });
		const manager = makeController();
		manager.handleInput("n");
		(await waitInput(1, "name prompt")).onSubmit?.("dupe");
		(await waitInput(2, "default role")).onSubmit?.("provider/new");
		(await waitInput(3, "smol role")).onSubmit?.("");
		(await waitInput(4, "slow role")).onSubmit?.(""); // keep existing
		(await waitInput(5, "plan role")).onSubmit?.("");
		await until(() => settings.getProfile("dupe")?.modelRoles?.default === "provider/new", "merge persisted");
		const definition = settings.getProfile("dupe");
		expect(definition?.modelRoles?.slow).toBe("provider/old"); // sibling preserved
		expect(definition?.description).toBe("original");
	});

	test("invalid name surfaces an error and persists nothing", async () => {
		const manager = makeController();
		manager.handleInput("n");
		(await waitInput(1, "name prompt")).onSubmit?.("bad name!");
		for (let i = 2; i <= 5; i++) {
			(await waitInput(i, `role ${i}`)).onSubmit?.("");
		}
		// The final setProfile rejects; the action chain routes the error to
		// showError instead of crashing the session with an unhandled rejection.
		await until(() => errorMessages.length > 0, "validation error surfaced");
		expect(errorMessages[0]).toContain("bad name!");
		expect(settings.getProfile("bad name!")).toBeUndefined();
		expect(globalDisk().profiles).toBeUndefined();
	});

	test("Esc on the focused name input cancels creation immediately", async () => {
		const manager = makeController();
		manager.handleInput("n");
		const nameInput = await waitInput(1, "name prompt");
		// The Input owns focus: Esc must cancel through its own handler.
		expect(typeof nameInput.onEscape).toBe("function");
		nameInput.onEscape?.();
		// Deterministic: the manager regains focus when the prompt unwinds.
		await until(() => focusTargets.at(-1) === manager, "manager refocused");
		expect(settings.getProfile("anything")).toBeUndefined();
		expect(globalDisk().profiles).toBeUndefined();
	});

	test("Esc on a focused role input aborts the editor with nothing written", async () => {
		const manager = makeController();
		manager.handleInput("n");
		(await waitInput(1, "name prompt")).onSubmit?.("escaper");
		const roleInput = await waitInput(2, "first role prompt");
		expect(typeof roleInput.onEscape).toBe("function");
		roleInput.onEscape?.(); // abort mid-editor
		await until(() => focusTargets.at(-1) === manager, "editor unwound");
		expect(settings.getProfile("escaper")).toBeUndefined();
		expect(globalDisk().profiles).toBeUndefined();
	});
});
