import { afterAll, beforeAll, expect, test } from "bun:test";
import { realpathSync } from "node:fs";
import { symlink, unlink } from "node:fs/promises";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { loadSessionExtensions } from "@oh-my-pi/pi-coding-agent/sdk";
import { discoverAgents, getAgent } from "@oh-my-pi/pi-coding-agent/task";
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

test("file-form trusted extension contributes its package root to --agent discovery (j2u)", async () => {
	// Package: /pkg/package.json + /pkg/agents/fixture.md + /pkg/index.ts
	// `--trusted-extension /pkg/index.ts --agent fixture-pkg` must resolve:
	// the module FILE loads as the extension, and the derived package root
	// feeds the agent discovery scan.
	const packageDir = tempDir.join("fixture-extension-package");
	await Bun.write(`${packageDir}/package.json`, JSON.stringify({ name: "fixture-extension" }));
	await Bun.write(`${packageDir}/index.ts`, "export default function () {}");
	await Bun.write(
		`${packageDir}/agents/fixture-pkg.md`,
		"---\nname: fixture-pkg\ndescription: pkg agent\n---\n\nBody.",
	);

	const parsed = parseArgs(["--trusted-extension", `${packageDir}/index.ts`, "--agent", "fixture-pkg"]);
	const settings = Settings.isolated();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	const options = await buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings);

	// The module file stays the ONLY extension load path (the trusted loader
	// rejects directories); the derived package root rides the DISCOVERY view
	// via options.extensionRoots.
	expect(options.additionalExtensionPaths).toEqual([realpathSync.native(`${packageDir}/index.ts`)]);
	expect(options.extensionRoots).toBeDefined();
	// Mirror production: discovery consumes the session's effectiveExtensionRoots
	// view (which carries the merged package root), not the loader-only paths.
	const effectiveRoots = options.extensionRoots?.() ?? {
		explicit: options.additionalExtensionPaths ?? [],
		mode: options.disableExtensionDiscovery ? ("explicit-only" as const) : ("merge" as const),
		configured: settings.get("extensions") ?? [],
		configuredLevel: settings.extensionsSourceLevel(),
	};
	const discovery = await discoverAgents(tempDir.path(), undefined, effectiveRoots);
	expect(getAgent(discovery.agents, "fixture-pkg")?.name).toBe("fixture-pkg");
});

test("buildSessionOptions rejects trusted extension directories", async () => {
	const parsed = parseArgs(["--trusted-extension", tempDir.path()]);
	const settings = Settings.isolated();
	const modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));

	await expect(buildSessionOptions(parsed, [], SessionManager.inMemory(), modelRegistry, settings)).rejects.toThrow(
		/module file, not a directory/,
	);
});
