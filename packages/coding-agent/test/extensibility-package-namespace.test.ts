import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import * as PiCodingAgent from "@oh-my-pi/pi-coding-agent";
import * as packageNamespace from "@oh-my-pi/pi-coding-agent/extensibility/package-namespace";
import { loadCustomCommands } from "@oh-my-pi/pi-coding-agent/extensibility/custom-commands/loader";
import { loadCustomTools } from "@oh-my-pi/pi-coding-agent/extensibility/custom-tools/loader";
import { loadExtensions } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { loadHooks } from "@oh-my-pi/pi-coding-agent/extensibility/hooks/loader";
import { TempDir } from "@oh-my-pi/pi-utils";

/**
 * The host package namespace is one operation, so it lives in one helper that
 * every loader calls.
 *
 * The extension, custom-tool, custom-command and hook loaders all hand a
 * loaded module the host's package namespace (`api.pi`). When each loader
 * resolved that namespace on its own, a change to the namespace-identity,
 * retry or loading policy had to be kept synchronized in four places, and the
 * loaders could drift apart — a loader that resolved the namespace
 * differently would hand a module a different object than the other three.
 *
 * The contract: every loader resolves the namespace through the one shared
 * helper, and the namespace that helper returns is the host's own.
 */
describe("extensibility package namespace resolution", () => {
	let projectDir: TempDir | undefined;

	beforeEach(() => {
		projectDir = TempDir.createSync("@shared-package-namespace-");
	});

	afterEach(() => {
		projectDir?.removeSync();
		projectDir = undefined;
		vi.restoreAllMocks();
	});

	function writeModule(relativePath: string, source: string): string {
		expect(projectDir).toBeDefined();
		const modulePath = path.join(projectDir!.path(), relativePath);
		fs.mkdirSync(path.dirname(modulePath), { recursive: true });
		fs.writeFileSync(modulePath, source);
		return modulePath;
	}

	it("resolves the host namespace through the one shared helper from every loader", async () => {
		expect(projectDir).toBeDefined();
		const cwd = projectDir!.path();

		const extensionPath = writeModule(
			"extension.ts",
			`export default function(api) { api.registerCommand("shared_ns_extension", { handler: async () => {} }); }`,
		);
		const toolPath = writeModule(
			"tool.ts",
			`export default function(api) {
				return {
					name: "shared_ns_tool",
					label: "Shared namespace tool",
					description: "Resolves the host namespace",
					parameters: api.zod.object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
				};
			}`,
		);
		const agentDir = path.join(cwd, "agent");
		writeModule(
			path.join("agent", "commands", "identity", "index.ts"),
			`export default function(api) {
				return { name: "shared_ns_command", description: "Resolves the host namespace", execute: () => "ok" };
			}`,
		);
		const hookPath = writeModule(
			"hook.ts",
			`export default function(api) { api.on("shared:event", async () => "ok"); }`,
		);

		const spy = vi.spyOn(packageNamespace, "loadPiCodingAgentNamespace");
		// The count after each loader: a loader that resolved the namespace on
		// its own instead of through the shared helper would not move it.
		let afterExtensions = 0;
		let afterTools = 0;
		let afterCommands = 0;
		let afterHooks = 0;
		try {
			await loadExtensions([extensionPath], cwd);
			afterExtensions = spy.mock.calls.length;
			await loadCustomTools([{ path: toolPath }], cwd, []);
			afterTools = spy.mock.calls.length;
			await loadCustomCommands({ cwd, agentDir });
			afterCommands = spy.mock.calls.length;
			await loadHooks([hookPath], cwd);
			afterHooks = spy.mock.calls.length;
		} finally {
			spy.mockRestore();
		}

		expect({
			extensions: afterExtensions,
			tools: afterTools,
			commands: afterCommands,
			hooks: afterHooks,
		}).toEqual({ extensions: 1, tools: 2, commands: 3, hooks: 4 });
		// And the shared helper hands out the host's own namespace object.
		expect(await packageNamespace.loadPiCodingAgentNamespace()).toBe(PiCodingAgent);
	}, 60_000);
});
