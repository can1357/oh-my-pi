import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import type { InteractiveModeContext } from "@oh-my-pi/pi-coding-agent/modes/types";
import {
	BUILTIN_SLASH_COMMAND_DEFS,
	BUILTIN_SLASH_COMMAND_RESERVED_NAMES,
	executeBuiltinSlashCommand,
} from "@oh-my-pi/pi-coding-agent/slash-commands/builtin-registry";
import type { TuiSlashCommandRuntime } from "@oh-my-pi/pi-coding-agent/slash-commands/types";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { getProjectAgentDir, logger, TempDir } from "@oh-my-pi/pi-utils";

function createRuntime() {
	const setText = vi.fn();
	const showSessionInfo = vi.fn();
	const runtime = {
		ctx: {
			editor: { setText } as unknown as InteractiveModeContext["editor"],
			showSessionInfo,
			showStatus: vi.fn(),
			showError: vi.fn(),
		} as unknown as InteractiveModeContext,
	} as unknown as TuiSlashCommandRuntime;
	return { runtime, setText, showSessionInfo };
}

describe("/help slash command (#12577)", () => {
	beforeEach(() => {
		resetSettingsForTest();
		Settings.init({ inMemory: true });
	});

	it("appears in the builtin list that autocomplete reads", () => {
		const help = BUILTIN_SLASH_COMMAND_DEFS.find(command => command.name === "help");
		expect(help?.description).toBeTruthy();
	});

	it("lists the builtin commands", async () => {
		const harness = createRuntime();

		expect(await executeBuiltinSlashCommand("/help", harness.runtime)).toBe(true);
		expect(harness.setText).toHaveBeenCalledWith("");
		const listing = harness.showSessionInfo.mock.calls.at(-1)?.[0] as string;
		expect(listing).toContain("/help");
		expect(listing).toContain("/quit");
	});

	it("filters the listing by the argument", async () => {
		const harness = createRuntime();

		expect(await executeBuiltinSlashCommand("/help quit", harness.runtime)).toBe(true);
		const listing = harness.showSessionInfo.mock.calls.at(-1)?.[0] as string;
		expect(listing).toContain("/quit");
		expect(listing).not.toContain("/help");
	});

	it("reports when nothing matches", async () => {
		const harness = createRuntime();

		expect(await executeBuiltinSlashCommand("/help zzzznope", harness.runtime)).toBe(true);
		expect(harness.showSessionInfo).toHaveBeenLastCalledWith('No commands match "zzzznope".');
	});

	it("leaves the unknown-command fallback to the dispatcher", async () => {
		const harness = createRuntime();

		expect(await executeBuiltinSlashCommand("/definitelynotacommand", harness.runtime)).toBe(false);
		expect(harness.showSessionInfo).not.toHaveBeenCalled();
	});
});

describe("/help name reservation (#12577)", () => {
	const sharedDir = TempDir.createSync("@pi-help-shared-");
	let modelRegistry: ModelRegistry;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});

	afterEach(() => {
		authStorage.close();
	});

	async function runnerForCommandNames(names: string[]): Promise<ExtensionRunner> {
		const tempDir = TempDir.createSync("@pi-help-reservation-");
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const registrations = names
			.map(name => `pi.registerCommand(${JSON.stringify(name)}, { description: "ext", handler: async () => {} });`)
			.join("\n\t\t\t\t\t");
		fs.writeFileSync(
			path.join(extensionsDir, "probe.ts"),
			`export default function(pi) {\n\t\t\t\t${registrations}\n\t\t\t\t}`,
		);
		const result = await loadExtensions([path.join(extensionsDir, "probe.ts")], tempDir.path());
		const runner = new ExtensionRunner(
			result.extensions,
			result.runtime,
			tempDir.path(),
			SessionManager.inMemory(tempDir.path()),
			modelRegistry,
		);
		return runner;
	}

	it("refuses an extension command named help", async () => {
		const runner = await runnerForCommandNames(["help"]);
		const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});

		const commands = runner.getRegisteredCommands(BUILTIN_SLASH_COMMAND_RESERVED_NAMES);

		expect(BUILTIN_SLASH_COMMAND_RESERVED_NAMES.has("help")).toBe(true);
		expect(commands.map(command => command.name)).toEqual([]);
		expect(runner.getCommandDiagnostics().map(diagnostic => diagnostic.message)).toEqual([
			expect.stringContaining("'help'"),
		]);
		warnSpy.mockRestore();
	});

	it("still admits an extension command that does not collide", async () => {
		const runner = await runnerForCommandNames(["helpme", "quit"]);

		const commands = runner.getRegisteredCommands(BUILTIN_SLASH_COMMAND_RESERVED_NAMES);

		expect(commands.map(command => command.name)).toEqual(["helpme"]);
	});
});
