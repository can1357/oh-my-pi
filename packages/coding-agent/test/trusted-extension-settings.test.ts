/**
 * The `trustedExtensions` setting is the persistent form of
 * `--trusted-extension`: modules that keep running inside restricted subagents
 * and whose absence stops startup. These tests pin the three properties that
 * make it load-bearing — it survives `--no-extensions`, it fails closed, and a
 * restricted child rebinds its handlers while ordinary extensions stay out.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AuthStorage } from "@oh-my-pi/pi-ai";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import {
	type CreateAgentSessionOptions,
	createAgentSession,
	discoverSessionExtensionPaths,
	resolveConfiguredTrustedExtensionPaths,
} from "@oh-my-pi/pi-coding-agent/sdk";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { logger, removeSyncWithRetries, Snowflake } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

const SETTINGS_RECOVERY = "Fix or remove the trustedExtensions setting entry and restart.";

let tempDir: string;
let authStorage: AuthStorage;
const openSessions: Array<{ dispose: () => Promise<void> }> = [];

beforeAll(() => {
	tempDir = fs.mkdtempSync(path.join(os.tmpdir(), `omp-trusted-extension-${Snowflake.next()}-`));
	authStorage = createInMemoryAuthStorage();
});

afterEach(async () => {
	for (const session of openSessions.splice(0)) await session.dispose();
});

afterAll(() => {
	authStorage.close();
	removeSyncWithRetries(tempDir);
});

declare global {
	/** Lifecycle log the probe modules append to, keyed by each probe's own key. */
	var __ompTrustedProbeLog: Record<string, string[]> | undefined;
}

/**
 * Extension module that appends every lifecycle step it observes to a
 * globalThis-keyed log, so a test can tell factory binding from handler
 * dispatch and one module's activity from another's.
 */
function writeProbeModule(name: string, key: string, block: boolean): string {
	const modulePath = path.join(tempDir, name);
	fs.writeFileSync(
		modulePath,
		[
			"declare global { var __ompTrustedProbeLog: Record<string, string[]> | undefined; }",
			`const KEY = ${JSON.stringify(key)};`,
			"const record = entry => {",
			"	const logs = (globalThis.__ompTrustedProbeLog ??= {});",
			"	(logs[KEY] ??= []).push(entry);",
			"};",
			"export default function (api) {",
			'	record("factory");',
			'	api.on("tool_call", () => {',
			'		record("tool_call");',
			`		return ${block ? '{ block: true, reason: "policy denied" }' : "undefined"};`,
			"	});",
			'	api.on("tool_result", () => {',
			'		record("tool_result");',
			"		return undefined;",
			"	});",
			"}",
			"",
		].join("\n"),
	);
	return modulePath;
}

/**
 * Handler-only module shaped like the deployed policy gates: the handler
 * catches its own failure, reports it through `api.logger`, and allows the
 * call. The log call is the point — a stubbed `api.logger` turns that catch
 * block into a throw, and the runner turns a handler throw into a block.
 */
function writeLoggingProbeModule(name: string, key: string): string {
	const modulePath = path.join(tempDir, name);
	fs.writeFileSync(
		modulePath,
		[
			"export default function (api) {",
			'	api.on("tool_call", () => {',
			"		try {",
			'			throw new Error("policy backend unavailable");',
			"		} catch (error) {",
			`			api.logger.warn("policy failed open", { key: ${JSON.stringify(key)}, error });`,
			"			return undefined;",
			"		}",
			"	});",
			"}",
			"",
		].join("\n"),
	);
	return modulePath;
}

function probeLog(key: string): string[] {
	return globalThis.__ompTrustedProbeLog?.[key] ?? [];
}

function resetProbeLog(key: string): void {
	(globalThis.__ompTrustedProbeLog ??= {})[key] = [];
}

function sessionOptions(overrides: Partial<CreateAgentSessionOptions>): CreateAgentSessionOptions {
	return {
		cwd: tempDir,
		agentDir: tempDir,
		authStorage,
		modelRegistry: new ModelRegistry(authStorage, path.join(tempDir, "models.json")),
		sessionManager: SessionManager.inMemory(tempDir),
		// Ambient discovery would pull the developer's own ~/.omp extensions into
		// the assertions; the trusted list must reach the loader without it.
		disableExtensionDiscovery: true,
		skills: [],
		rules: [],
		contextFiles: [],
		promptTemplates: [],
		slashCommands: [],
		preloadedCustomToolPaths: [],
		toolNames: ["read"],
		enableMCP: false,
		enableLsp: false,
		skipPythonPreflight: true,
		...overrides,
	};
}

describe("trustedExtensions setting", () => {
	it("loads the configured module at top level and rebinds its handlers in a restricted child", async () => {
		const trustedKey = `__omp_trusted_probe_${Snowflake.next()}`;
		const ordinaryKey = `__omp_ordinary_probe_${Snowflake.next()}`;
		const trustedPath = writeProbeModule("policy-probe.ts", trustedKey, true);
		const ordinaryPath = writeProbeModule("ordinary-probe.ts", ordinaryKey, false);
		resetProbeLog(trustedKey);
		resetProbeLog(ordinaryKey);

		const parent = await createAgentSession(
			sessionOptions({
				settings: Settings.isolated({ trustedExtensions: [trustedPath] }),
				additionalExtensionPaths: [ordinaryPath],
			}),
		);
		openSessions.push(parent.session);

		expect(probeLog(trustedKey)).toEqual(["factory"]);
		expect(probeLog(ordinaryKey)).toEqual(["factory"]);
		expect(parent.session.trustedExtensionPaths).toEqual([trustedPath]);

		resetProbeLog(trustedKey);
		resetProbeLog(ordinaryKey);
		// The child reads no settings: it must trust exactly what the parent
		// forwarded, and drop the ordinary path even though it is handed one.
		const child = await createAgentSession(
			sessionOptions({
				settings: Settings.isolated(),
				restrictToolNames: true,
				trustedExtensionPaths: parent.session.trustedExtensionPaths,
				additionalExtensionPaths: [ordinaryPath],
			}),
		);
		openSessions.push(child.session);

		expect(probeLog(trustedKey)).toEqual(["factory"]);
		expect(probeLog(ordinaryKey)).toEqual([]);

		const blocked = await child.session.extensionRunner?.emitToolCall({
			type: "tool_call",
			toolName: "write",
			toolCallId: "trusted-child-call",
			input: { path: path.join(tempDir, "blocked.txt") },
		});
		expect(blocked).toEqual({ block: true, reason: "policy denied" });

		await child.session.extensionRunner?.emitToolResult({
			type: "tool_result",
			toolName: "write",
			toolCallId: "trusted-child-call",
			input: { path: path.join(tempDir, "blocked.txt") },
			content: [{ type: "text", text: "wrote" }],
			isError: false,
			details: undefined,
		});

		expect(probeLog(trustedKey)).toEqual(["factory", "tool_call", "tool_result"]);
		expect(probeLog(ordinaryKey)).toEqual([]);
	});

	it("binds the configured trusted module in a restricted session that was forwarded no list", async () => {
		const probeKey = `__omp_unforwarded_probe_${Snowflake.next()}`;
		const trustedPath = writeProbeModule("unforwarded-policy.ts", probeKey, true);
		resetProbeLog(probeKey);

		// A cold revive, a security scan, an agentic commit, and a compression
		// pass each create a restricted session with no forwarded trusted list.
		// Treating that as "trusts nothing" runs them with the policy absent.
		const restricted = await createAgentSession(
			sessionOptions({
				settings: Settings.isolated({ trustedExtensions: [trustedPath] }),
				restrictToolNames: true,
			}),
		);
		openSessions.push(restricted.session);

		expect(probeLog(probeKey)).toEqual(["factory"]);
		const blocked = await restricted.session.extensionRunner?.emitToolCall({
			type: "tool_call",
			toolName: "write",
			toolCallId: "unforwarded-call",
			input: { path: path.join(tempDir, "blocked.txt") },
		});
		expect(blocked).toEqual({ block: true, reason: "policy denied" });
	});

	it("refuses to start a restricted session whose configured trusted module is missing", async () => {
		const missingPath = path.join(tempDir, "absent-restricted-policy.ts");

		await expect(
			createAgentSession(
				sessionOptions({
					settings: Settings.isolated({ trustedExtensions: [missingPath] }),
					restrictToolNames: true,
				}),
			),
		).rejects.toThrow(`Trusted extension must be an existing module file: ${missingPath}. ${SETTINGS_RECOVERY}`);
	});

	it("refuses to start a restricted session whose configured trusted factory throws", async () => {
		const throwingPath = path.join(tempDir, "restricted-throwing-policy.ts");
		fs.writeFileSync(throwingPath, 'export default function () {\n\tthrow new Error("policy boot failed");\n}\n');

		await expect(
			createAgentSession(
				sessionOptions({
					settings: Settings.isolated({ trustedExtensions: [throwingPath] }),
					restrictToolNames: true,
				}),
			),
		).rejects.toThrow(
			`Trusted extension handlers failed to load for this restricted session: ${throwingPath}: Failed to load extension: policy boot failed.`,
		);
	});

	it("keeps api.logger live in a handler-only session so a module's own catch block allows the call", async () => {
		const probeKey = `__omp_logging_probe_${Snowflake.next()}`;
		const trustedPath = writeLoggingProbeModule("logging-policy.ts", probeKey);
		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const restricted = await createAgentSession(
				sessionOptions({
					settings: Settings.isolated({ trustedExtensions: [trustedPath] }),
					restrictToolNames: true,
				}),
			);
			openSessions.push(restricted.session);

			const decision = await restricted.session.extensionRunner?.emitToolCall({
				type: "tool_call",
				toolName: "write",
				toolCallId: "logging-call",
				input: { path: path.join(tempDir, "allowed.txt") },
			});

			// A stubbed `api.logger` makes the handler throw instead, and the
			// runner converts a handler throw into `{ block: true }` — so every
			// tool call in the session dies on the policy's own error path.
			expect(decision).toBeUndefined();
			expect(warn).toHaveBeenCalledWith("policy failed open", expect.objectContaining({ key: probeKey }));
		} finally {
			warn.mockRestore();
		}
	});

	it("fails startup when a configured trusted extension is missing", async () => {
		const missingPath = path.join(tempDir, "absent-policy.ts");
		const settings = Settings.isolated({ trustedExtensions: [missingPath] });

		await expect(
			buildSessionOptions(
				parseArgs([]),
				[],
				SessionManager.inMemory(tempDir),
				new ModelRegistry(authStorage, path.join(tempDir, "models.json")),
				settings,
			),
		).rejects.toThrow(`Trusted extension must be an existing module file: ${missingPath}. ${SETTINGS_RECOVERY}`);
	});

	it("fails startup closed when a configured trusted extension factory throws", async () => {
		const throwingPath = path.join(tempDir, "throwing-policy.ts");
		fs.writeFileSync(throwingPath, 'export default function () {\n\tthrow new Error("policy boot failed");\n}\n');

		await expect(
			createAgentSession(sessionOptions({ settings: Settings.isolated({ trustedExtensions: [throwingPath] }) })),
		).rejects.toThrow(`${throwingPath}: Failed to load extension: policy boot failed. ${SETTINGS_RECOVERY}`);
	});

	it("prefers --trusted-extension over the trustedExtensions setting", async () => {
		const flagPath = writeProbeModule("flag-policy.ts", `__omp_flag_probe_${Snowflake.next()}`, true);
		const settingPath = writeProbeModule("setting-policy.ts", `__omp_setting_probe_${Snowflake.next()}`, true);
		const canonicalFlagPath = fs.realpathSync.native(flagPath);

		const options = await buildSessionOptions(
			parseArgs(["--trusted-extension", flagPath]),
			[],
			SessionManager.inMemory(tempDir),
			new ModelRegistry(authStorage, path.join(tempDir, "models.json")),
			Settings.isolated({ trustedExtensions: [settingPath] }),
		);

		expect(options.trustedExtensionPaths).toEqual([canonicalFlagPath]);
		expect(options.additionalExtensionPaths).toEqual([canonicalFlagPath]);
		expect(options.disableExtensionDiscovery).toBe(true);
	});

	it("keeps configured trusted extensions loading under --no-extensions, down to a restricted child", async () => {
		const probeKey = `__omp_flagoff_probe_${Snowflake.next()}`;
		const trustedPath = writeProbeModule("no-extensions-policy.ts", probeKey, true);
		const settings = Settings.isolated({ trustedExtensions: [trustedPath] });

		const options = await buildSessionOptions(
			parseArgs(["--no-extensions"]),
			[],
			SessionManager.inMemory(tempDir),
			new ModelRegistry(authStorage, path.join(tempDir, "models.json")),
			settings,
		);

		expect(options.disableExtensionDiscovery).toBe(true);
		expect(options.trustedExtensionPaths).toEqual([trustedPath]);
		expect(options.additionalExtensionPaths).toContain(trustedPath);
		expect(await discoverSessionExtensionPaths(options, tempDir, settings)).toEqual([trustedPath]);

		resetProbeLog(probeKey);
		const parent = await createAgentSession(sessionOptions({ ...options, cwd: tempDir, settings }));
		openSessions.push(parent.session);
		expect(probeLog(probeKey)).toEqual(["factory"]);

		resetProbeLog(probeKey);
		const child = await createAgentSession(
			sessionOptions({
				...options,
				cwd: tempDir,
				settings,
				restrictToolNames: true,
				trustedExtensionPaths: parent.session.trustedExtensionPaths,
			}),
		);
		openSessions.push(child.session);

		const blocked = await child.session.extensionRunner?.emitToolCall({
			type: "tool_call",
			toolName: "write",
			toolCallId: "no-extensions-child-call",
			input: { path: path.join(tempDir, "blocked.txt") },
		});
		expect(blocked).toEqual({ block: true, reason: "policy denied" });
		expect(probeLog(probeKey)).toEqual(["factory", "tool_call"]);
	});

	it("ignores a project-level trustedExtensions entry and honors the user-level one", async () => {
		const userPath = writeProbeModule("user-scope-policy.ts", `__omp_user_scope_${Snowflake.next()}`, true);
		const projectPath = writeProbeModule("project-scope-policy.ts", `__omp_project_scope_${Snowflake.next()}`, true);
		const projectDir = path.join(tempDir, "scoped-project");
		const agentDir = path.join(tempDir, "scoped-agent");
		const projectConfig = path.join(projectDir, ".omp", "config.yml");
		await Bun.write(projectConfig, `trustedExtensions:\n  - ${projectPath}\n`);
		await Bun.write(path.join(agentDir, "config.yml"), `trustedExtensions:\n  - ${userPath}\n`);

		const warn = spyOn(logger, "warn").mockImplementation(() => {});
		try {
			const settings = await Settings.loadReadOnly({ cwd: projectDir, agentDir });

			// A checked-out repository cannot nominate a module that binds in every
			// restricted subagent; the launch operator's own config still can.
			expect(resolveConfiguredTrustedExtensionPaths(settings, projectDir)).toEqual([userPath]);
			expect(warn).toHaveBeenCalledWith(expect.stringContaining("project-level trustedExtensions"), {
				source: projectConfig,
				entries: [projectPath],
			});
		} finally {
			warn.mockRestore();
		}
	});
});
