/**
 * ProfileManagerComponent behavior tests: row composition, selection
 * actions (select/edit/delete/create/cancel), keyboard shortcuts, prompt
 * mode, and cursor retention across refreshes. Pure component tests — no
 * live TUI required.
 */
import { beforeAll, describe, expect, test } from "bun:test";
import { Input } from "@oh-my-pi/pi-tui";
import {
	ProfileFormPanel,
	type ProfileManagerAction,
	ProfileManagerComponent,
	type ProfilePickerEntry,
} from "../src/modes/components/profile-manager";
import { initTheme } from "../src/modes/theme/theme";

beforeAll(async () => {
	await initTheme();
});

function entries(): ProfilePickerEntry[] {
	return [
		{ name: "cheap", description: "Low cost", definedIn: ["global"] },
		{ name: "advanced", description: "Max capability", definedIn: ["project"] },
	];
}

/** Drive the manager: returns the actions it emits for the given keys. */
function drive(
	keys: string[],
	initial?: string,
): { actions: ProfileManagerAction[]; manager: ProfileManagerComponent } {
	const actions: ProfileManagerAction[] = [];
	const manager = new ProfileManagerComponent(entries(), initial ?? "", action => actions.push(action));
	for (const key of keys) manager.handleInput(key);
	return { actions, manager };
}

describe("ProfileManagerComponent", () => {
	test("Enter on a profile row selects it", () => {
		const { actions } = drive(["\r"], "cheap");
		expect(actions).toEqual([{ kind: "select", name: "cheap" }]);
	});

	test("Enter on Off selects 'off'", () => {
		const { actions } = drive(["\r"]);
		expect(actions.at(-1)).toEqual({ kind: "select", name: "off" });
	});

	test("E emits edit for the selected profile at its defining scope", () => {
		const { actions } = drive(["e"], "cheap");
		expect(actions).toEqual([{ kind: "edit", name: "cheap", scope: "global" }]);
	});

	test("D emits delete for the selected profile at its defining scope", () => {
		const { actions } = drive(["d"], "cheap");
		expect(actions).toEqual([{ kind: "delete", name: "cheap", scope: "global" }]);
	});

	test("project-defined rows target project scope", () => {
		const { actions } = drive(["e"], "advanced");
		expect(actions).toEqual([{ kind: "edit", name: "advanced", scope: "project" }]);
	});

	test("N emits create regardless of selection", () => {
		const { actions } = drive(["n"], "cheap");
		expect(actions).toEqual([{ kind: "create" }]);
	});

	test("action rows are exempt from edit/delete shortcuts", () => {
		// Cursor starts on Off when nothing is active; E/D must be no-ops there.
		const edit = drive(["e"]);
		const del = drive(["d"]);
		expect(edit.actions).toEqual([]);
		expect(del.actions).toEqual([]);
	});

	test("Escape cancels", () => {
		const { actions } = drive(["\x1b"], "cheap");
		expect(actions).toEqual([{ kind: "cancel" }]);
	});

	test("navigation moves selection between rows before acting", () => {
		// Down from cheap → advanced; Enter selects advanced.
		const { actions } = drive(["\x1b[B", "\r"], "cheap");
		expect(actions).toEqual([{ kind: "select", name: "advanced" }]);
	});

	test("update() keeps the cursor on the previously selected profile", () => {
		const actions: ProfileManagerAction[] = [];
		const manager = new ProfileManagerComponent(entries(), "advanced", action => actions.push(action));
		manager.update([...entries(), { name: "coding", definedIn: ["global"] }], "advanced");
		// After the refresh the cursor is still on advanced, so E targets it.
		manager.handleInput("e");
		expect(actions).toEqual([{ kind: "edit", name: "advanced", scope: "project" }]);
	});

	test("selectProfile moves the cursor so the next Enter selects that row", () => {
		const actions: ProfileManagerAction[] = [];
		const manager = new ProfileManagerComponent(entries(), "", action => actions.push(action));
		manager.selectProfile("advanced");
		manager.handleInput("\r");
		expect(actions).toEqual([{ kind: "select", name: "advanced" }]);
	});
});

describe("ProfileFormPanel", () => {
	test("routes input to the contained Input and Escape triggers cancel", () => {
		const form = new ProfileFormPanel("New Profile");
		let cancelled = false;
		form.onCancel = () => {
			cancelled = true;
		};
		let submitted: string | undefined;
		const input = new Input();
		input.onSubmit = value => {
			submitted = value;
		};
		form.addChild(input);

		form.handleInput("h");
		form.handleInput("i");
		expect(submitted).toBeUndefined();
		form.handleInput("\r");
		expect(submitted).toBe("hi");
		expect(cancelled).toBe(false);

		form.handleInput("\x1b");
		expect(cancelled).toBe(true);
	});

	test("showError appends an error line without breaking input routing", () => {
		const form = new ProfileFormPanel("New Profile");
		const input = new Input();
		form.addChild(input);
		form.showError("Invalid name");
		form.handleInput("x");
		let submitted: string | undefined;
		input.onSubmit = value => {
			submitted = value;
		};
		form.handleInput("\r");
		expect(submitted).toBe("x");
	});
});
