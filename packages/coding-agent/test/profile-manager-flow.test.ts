/**
 * Headless simulation of the Profile Manager TUI flow: drives the component
 * exactly as the keyboard would, verifying the visual row set and the full
 * create→edit→delete cycle through emitted actions against real Settings.
 */
import { beforeAll, expect, test } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { resetSettingsForTest, Settings } from "../src/config/settings";
import { type ProfileManagerAction, ProfileManagerComponent } from "../src/modes/components/profile-manager";
import { initTheme } from "../src/modes/theme/theme";
import { profilePickerEntries } from "../src/slash-commands/helpers/profile-command";

let agentDir: string;

beforeAll(async () => {
	await initTheme();
	const temp = TempDir.createSync("@pi-tui-mgr-");
	agentDir = temp.join("agent");
	fs.mkdirSync(agentDir, { recursive: true });
	fs.mkdirSync(temp.join("project"), { recursive: true });
	await Bun.write(`${agentDir}/config.yml`, "modelRoles:\n  default: provider/base\n");
});

import * as fs from "node:fs";

test("manager flow: rows render and full create/edit/delete cycle works", async () => {
	resetSettingsForTest();
	const settings = await Settings.loadIsolated({ cwd: agentDir, agentDir });
	await settings.setProfile("global", "cheap", { description: "Low cost", modelRoles: { default: "m1" } });
	await settings.setProfile("global", "advanced", { description: "Max", modelRoles: { slow: "m2" } });

	const actions: ProfileManagerAction[] = [];
	const manager = new ProfileManagerComponent(profilePickerEntries(settings), "cheap", a => actions.push(a));

	const rendered = manager.render(80).join("\n");
	for (const needle of ["cheap", "advanced", "+ Create Profile", "Off"]) {
		expect(rendered).toContain(needle);
	}

	manager.handleInput("n");
	expect(actions.at(-1)).toEqual({ kind: "create" });

	await settings.setProfile("global", "coding", { modelRoles: { smol: "m3" } });
	manager.update(profilePickerEntries(settings), "cheap");
	manager.selectProfile("coding");

	manager.handleInput("e");
	expect(actions.at(-1)).toEqual({ kind: "edit", name: "coding", scope: "global" });

	manager.handleInput("d");
	expect(actions.at(-1)).toEqual({ kind: "delete", name: "coding", scope: "global" });
	await settings.removeProfile("global", "coding");

	// Deleting the row under the cursor moves focus to the first surviving
	// profile row; Enter then selects whichever row is focused.
	manager.update(profilePickerEntries(settings), "cheap");
	manager.handleInput("\r");
	expect(actions.at(-1)).toEqual({ kind: "select", name: "advanced" });

	// Off row: jump to it explicitly, then Enter deactivates.
	manager.selectProfile("off");
	manager.handleInput("\r");
	expect(actions.at(-1)).toEqual({ kind: "select", name: "off" });
	manager.handleInput("\x1b");
	expect(actions.at(-1)).toEqual({ kind: "cancel" });
	expect(settings.getActiveProfile()).toBe("");
});

test("manager scope targeting: project-only rows edit/delete at project scope", async () => {
	resetSettingsForTest();
	const temp = TempDir.createSync("@pi-tui-mgr-proj-");
	const projAgentDir = temp.join("agent");
	const projectDir = temp.join("project");
	fs.mkdirSync(projAgentDir, { recursive: true });
	fs.mkdirSync(projectDir, { recursive: true });
	fs.mkdirSync(`${projectDir}/.omp`, { recursive: true });
	await Bun.write(`${projAgentDir}/config.yml`, "modelRoles:\n  default: provider/base\n");
	await Bun.write(
		`${projectDir}/.omp/config.yml`,
		"profiles:\n  projonly:\n    description: project-owned\n    modelRoles:\n      default: provider/proj\n",
	);
	const settings = await Settings.loadIsolated({ cwd: projectDir, agentDir: projAgentDir });

	const actions: ProfileManagerAction[] = [];
	const manager = new ProfileManagerComponent(profilePickerEntries(settings), "", a => actions.push(a));
	manager.selectProfile("projonly");
	manager.handleInput("e");
	expect(actions.at(-1)).toEqual({ kind: "edit", name: "projonly", scope: "project" });
	manager.handleInput("d");
	expect(actions.at(-1)).toEqual({ kind: "delete", name: "projonly", scope: "project" });
	// Dual-scope name: project definition is effective (higher precedence),
	// so the manager must target project even though global also defines it.
	await settings.setProfile("project", "shared", { modelRoles: { smol: "provider/p" } });
	await settings.setProfile("global", "shared", { modelRoles: { default: "provider/g" } });
	manager.update(profilePickerEntries(settings), "");
	manager.selectProfile("shared");
	manager.handleInput("e");
	expect(actions.at(-1)).toEqual({ kind: "edit", name: "shared", scope: "project" });
	// Scope tag is visible on the row so dual definitions are not ambiguous.
	expect(manager.render(80).join("\n")).toContain("[global+project]");
	await temp.remove();
});
