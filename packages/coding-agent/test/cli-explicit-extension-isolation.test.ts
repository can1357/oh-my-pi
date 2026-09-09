import { afterAll, beforeAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { symlink, unlink } from "node:fs/promises";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { loadSessionExtensions } from "@oh-my-pi/pi-coding-agent/sdk";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { EventBus } from "@oh-my-pi/pi-coding-agent/utils/event-bus";
import { TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

let tempDir: TempDir;
let authStorage: AuthStorage;

beforeAll(async () => {
	tempDir = await TempDir.create("@cli-explicit-extension-isolation-");
	authStorage = createInMemoryAuthStorage();
});

afterAll(async () => {
	authStorage.close();
	await tempDir.remove();
});

test("buildSessionOptions retains explicit extensions and hooks under --no-extensions", async () => {
	const extensionPath = tempDir.join("extension-package");
	const hookPath = tempDir.join("hook.ts");
	const parsed = parseArgs(["--no-extensions", "--extension", extensionPath, "--hook", hookPath]);
	const settings = Settings.isolated();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings);

	expect(options.disableExtensionDiscovery).toBe(true);
	expect(options.additionalExtensionPaths).toEqual([extensionPath, hookPath]);
});

test("trusted extension allowlists are canonical and cannot be expanded by retargeting a symlink", async () => {
	const trustedTarget = tempDir.join("trusted-target.ts");
	const replacementDir = tempDir.join("replacement");
	const trustedLink = tempDir.join("trusted.ts");
	await Bun.write(trustedTarget, "export default function () {}");
	await Bun.write(`${replacementDir}/ambient.ts`, "export default function () {}");
	await symlink(trustedTarget, trustedLink);

	const parsed = parseArgs(["--trusted-extension", trustedLink]);
	const settings = Settings.isolated();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings);

	expect(options.disableExtensionDiscovery).toBe(true);
	expect(options.additionalExtensionPaths).toEqual([realpathSync.native(trustedTarget)]);

	await unlink(trustedLink);
	await symlink(replacementDir, trustedLink);
	const result = await loadSessionExtensions(options, tempDir.path(), settings, new EventBus());

	expect(result.errors).toEqual([]);
	expect(result.extensions.map(extension => extension.resolvedPath)).toEqual([realpathSync.native(trustedTarget)]);
});

test("buildSessionOptions rejects trusted extension directories", async () => {
	const parsed = parseArgs(["--trusted-extension", tempDir.path()]);
	const settings = Settings.isolated();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	await expect(buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings)).rejects.toThrow(
		/module file, not a directory/,
	);
});
