import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AGENT_PLUGIN_MANIFEST_SCHEMA } from "@oh-my-pi/pi-coding-agent/discovery/agent-plugin-format";
import { isRecord, readJsonl, TempDir } from "@oh-my-pi/pi-utils";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import type { SkillDiagnosticsSnapshot } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-types";

type RpcFrame = Record<string, unknown>;

interface RpcHarness {
	close(): Promise<void>;
	diagnosticEvents(): RpcFrame[];
	request(id: string, command: Record<string, unknown>): Promise<RpcFrame>;
	waitForDiagnosticEvents(count: number): Promise<RpcFrame[]>;
}

interface PendingFrame {
	predicate(frame: RpcFrame): boolean;
	resolve(frame: RpcFrame): void;
	reject(error: Error): void;
}

async function spawnRpc(options: {
	cwd: string;
	agentDir: string;
	entry?: string;
	args?: string[];
}): Promise<RpcHarness> {
	const entry = options.entry ?? path.join(import.meta.dir, "..", "src", "cli.ts");
	const args = options.args ?? [
		"--mode",
		"rpc",
		"--no-extensions",
		"--no-rules",
		"--no-tools",
		"--provider",
		"anthropic",
		"--model",
		"claude-sonnet-4-5",
	];
	const child = Bun.spawn([process.execPath, entry, ...args], {
		cwd: options.cwd,
		env: {
			...Bun.env,
			HOME: path.join(options.agentDir, "home"),
			PI_CODING_AGENT_DIR: options.agentDir,
			XDG_CONFIG_HOME: path.join(options.agentDir, "config"),
			XDG_DATA_HOME: path.join(options.agentDir, "data"),
			XDG_CACHE_HOME: path.join(options.agentDir, "cache"),
			CI: "true",
			PI_NO_TITLE: "1",
		} as Record<string, string>,
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});
	const frames: RpcFrame[] = [];
	const diagnosticHistory: RpcFrame[] = [];
	const pending: PendingFrame[] = [];
	let streamError: unknown;
	const stderr = new Response(child.stderr).text();
	const next = (predicate: (frame: RpcFrame) => boolean): Promise<RpcFrame> => {
		const index = frames.findIndex(predicate);
		if (index !== -1) return Promise.resolve(frames.splice(index, 1)[0]!);
		if (child.exitCode !== null) {
			return Promise.reject(new Error(`RPC process exited early${streamError ? `: ${String(streamError)}` : ""}`));
		}
		const { promise, resolve, reject } = Promise.withResolvers<RpcFrame>();
		promise.catch(() => {});
		pending.push({ predicate, resolve, reject });
		return promise;
	};
	const pump = (async () => {
		try {
			for await (const value of readJsonl<unknown>(child.stdout)) {
				if (!isRecord(value)) continue;
				if (value.type === "skill_diagnostics_update") diagnosticHistory.push(value);
				const waiterIndex = pending.findIndex(waiter => waiter.predicate(value));
				if (waiterIndex === -1) frames.push(value);
				else pending.splice(waiterIndex, 1)[0]!.resolve(value);
			}
		} catch (error) {
			streamError = error;
		} finally {
			const failure = new Error(`RPC stream ended${streamError ? `: ${String(streamError)}` : ""}`);
			for (const waiter of pending.splice(0)) waiter.reject(failure);
		}
	})();
	const request = async (id: string, command: Record<string, unknown>): Promise<RpcFrame> => {
		child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		await child.stdin.flush();
		return next(frame => frame.type === "response" && frame.id === id);
	};
	const diagnosticEvents = (): RpcFrame[] => [...diagnosticHistory];
	const waitForDiagnosticEvents = async (count: number): Promise<RpcFrame[]> => {
		while (diagnosticHistory.length < count) {
			await next(frame => frame.type === "skill_diagnostics_update");
		}
		return diagnosticEvents();
	};
	const close = async (): Promise<void> => {
		const closing = new Error("RPC harness closed");
		for (const waiter of pending.splice(0)) waiter.reject(closing);
		try {
			child.stdin.end();
			await child.exited;
		} finally {
			if (child.exitCode === null) child.kill();
			await pump.catch(() => {});
			await stderr.catch(() => "");
		}
	};
	await next(frame => frame.type === "ready");
	return { close, diagnosticEvents, request, waitForDiagnosticEvents };
}

async function writeSkill(root: string, body: string): Promise<string> {
	const filePath = path.join(root, "review", "SKILL.md");
	await fs.mkdir(path.dirname(filePath), { recursive: true });
	await Bun.write(filePath, body);
	return filePath;
}

function assertAllowlistedSnapshot(value: unknown): asserts value is {
	cwd: string;
	showStartupDiagnostics: boolean;
	diagnostics: Array<{
		name: string;
		reason: string;
		skills: Array<Record<string, unknown>>;
		duplicates: Array<{ skill: Record<string, unknown>; retained: Record<string, unknown> }>;
	}>;
} {
	expect(isRecord(value)).toBe(true);
	if (!isRecord(value)) throw new Error("snapshot must be an object");
	expect(Object.keys(value).sort()).toEqual(["cwd", "diagnostics", "showStartupDiagnostics"]);
	expect(typeof value.cwd).toBe("string");
	expect(typeof value.showStartupDiagnostics).toBe("boolean");
	expect(Array.isArray(value.diagnostics)).toBe(true);
	for (const diagnostic of value.diagnostics as Array<Record<string, unknown>>) {
		expect(Object.keys(diagnostic).sort()).toEqual(["duplicates", "name", "reason", "skills"]);
		const entries = [
			...(diagnostic.skills as Array<Record<string, unknown>>),
			...(
				diagnostic.duplicates as Array<{ skill: Record<string, unknown>; retained: Record<string, unknown> }>
			).flatMap(duplicate => [duplicate.skill, duplicate.retained]),
		];
		for (const entry of entries) {
			// `pluginName` is the only optional key; it is allowlisted, never required.
			const expectedKeys =
				"pluginName" in entry ? ["filePath", "name", "pluginName", "source"] : ["filePath", "name", "source"];
			expect(Object.keys(entry).sort()).toEqual(expectedKeys);
		}
	}
	const serialized = JSON.stringify(value);
	for (const privateField of ["description", "baseDir", "containRoot", "_source", "frontmatter", "body", "hide"]) {
		expect(serialized).not.toContain(`"${privateField}"`);
	}
}

function responseData(frame: RpcFrame): unknown {
	expect(frame.success).toBe(true);
	return frame.data;
}

/** config.yml that disables every provider skill source except custom directories. */
function skillConfig(customDirectories: string[], showStartupDiagnostics?: boolean): string {
	return [
		"skills:",
		"  enableCodexUser: false",
		"  enableClaudeUser: false",
		"  enableClaudeProject: false",
		"  enablePiUser: false",
		"  enablePiProject: false",
		"  enableAgentsUser: false",
		"  enableAgentsProject: false",
		`  customDirectories: ${JSON.stringify(customDirectories)}`,
		...(showStartupDiagnostics === undefined ? [] : [`  showStartupDiagnostics: ${showStartupDiagnostics}`]),
		"",
	].join("\n");
}

describe("skill diagnostics RPC", () => {
	test("getter, state, and events expose one allowlisted live snapshot without duplicate updates", async () => {
		await using temp = await TempDir.create("@rpc-skill-diagnostics-");
		const project = temp.join("project");
		const movedProject = temp.join("moved-project");
		const agentDir = temp.join("agent");
		const firstRoot = temp.join("first");
		const secondRoot = temp.join("second");
		const mirrorRoot = temp.join("mirror");
		await Promise.all([fs.mkdir(project), fs.mkdir(movedProject), fs.mkdir(agentDir)]);
		const firstText = "---\nname: review\ndescription: First instructions\n---\n\n# First private body\n";
		const secondText = "---\nname: review\ndescription: Second instructions\n---\n\n# Second private body\n";
		const firstFile = await writeSkill(firstRoot, firstText);
		const secondFile = await writeSkill(secondRoot, secondText);
		const mirrorFile = await writeSkill(mirrorRoot, secondText);
		await Bun.write(
			path.join(agentDir, "config.yml"),
			[
				"skills:",
				"  enableCodexUser: false",
				"  enableClaudeUser: false",
				"  enableClaudeProject: false",
				"  enablePiUser: false",
				"  enablePiProject: false",
				"  enableAgentsUser: false",
				"  enableAgentsProject: false",
				`  customDirectories: ${JSON.stringify([firstRoot, secondRoot, mirrorRoot])}`,
				"",
			].join("\n"),
		);

		const rpc = await spawnRpc({ cwd: project, agentDir });
		try {
			const stateFrame = await rpc.request("state-initial", { type: "get_state" });
			const getterFrame = await rpc.request("get-initial", { type: "get_skill_diagnostics" });
			const state = responseData(stateFrame) as Record<string, unknown>;
			const startup = state.skillDiagnostics;
			assertAllowlistedSnapshot(startup);
			const getter = responseData(getterFrame);
			expect(getter).toEqual(startup);
			const [startupEvent] = await rpc.waitForDiagnosticEvents(1);
			expect(startupEvent!.data).toEqual(startup);
			expect(startup.cwd).toBe(project);
			expect(startup.showStartupDiagnostics).toBe(true);
			expect(startup.diagnostics).toHaveLength(1);
			expect(startup.diagnostics[0]).toMatchObject({ name: "review", reason: "source-order" });
			expect(startup.diagnostics[0].skills).toEqual([
				{ name: "review", filePath: firstFile, source: "custom:user" },
				{ name: `${path.basename(secondRoot)}/review`, filePath: secondFile, source: "custom:user" },
			]);
			expect(startup.diagnostics[0].duplicates).toEqual([
				{
					skill: { name: "review", filePath: mirrorFile, source: "custom:user" },
					retained: { name: `${path.basename(secondRoot)}/review`, filePath: secondFile, source: "custom:user" },
				},
			]);

			expect(JSON.stringify(state.systemPrompt ?? [])).not.toContain(mirrorFile);
			const messages = responseData(await rpc.request("messages-initial", { type: "get_messages" }));
			expect(JSON.stringify(messages)).not.toContain("skill_diagnostics");

			const disabled = responseData(
				await rpc.request("disable", { type: "set_skill_startup_diagnostics", enabled: false }),
			);
			assertAllowlistedSnapshot(disabled);
			expect(disabled).toEqual({ ...startup, showStartupDiagnostics: false });
			const disabledEvents = await rpc.waitForDiagnosticEvents(2);
			expect(disabledEvents[1]!.data).toEqual(disabled);
			expect(responseData(await rpc.request("get-disabled", { type: "get_skill_diagnostics" }))).toEqual(disabled);

			const eventCountBeforeInvalid = rpc.diagnosticEvents().length;
			const invalid = await rpc.request("invalid", {
				type: "set_skill_startup_diagnostics",
				enabled: "false",
			});
			expect(invalid).toMatchObject({
				id: "invalid",
				command: "set_skill_startup_diagnostics",
				success: false,
			});
			expect(responseData(await rpc.request("get-after-invalid", { type: "get_skill_diagnostics" }))).toEqual(
				disabled,
			);
			expect(rpc.diagnosticEvents()).toHaveLength(eventCountBeforeInvalid);

			await Promise.all([
				fs.rm(path.dirname(secondFile), { recursive: true, force: true }),
				fs.rm(path.dirname(mirrorFile), { recursive: true, force: true }),
			]);
			const reload = await rpc.request("reload-clean", { type: "prompt", message: "/reload-plugins" });
			expect(reload).toMatchObject({ success: true, data: { agentInvoked: false } });
			const cleanEvents = await rpc.waitForDiagnosticEvents(3);
			const clean = cleanEvents[2]!.data;
			assertAllowlistedSnapshot(clean);
			expect(clean).toEqual({ cwd: project, showStartupDiagnostics: false, diagnostics: [] });
			expect(responseData(await rpc.request("state-clean", { type: "get_state" }))).toMatchObject({
				skillDiagnostics: clean,
			});

			const beforeUnchangedReload = rpc.diagnosticEvents().length;
			await rpc.request("reload-unchanged", { type: "prompt", message: "/reload-plugins" });
			await rpc.request("reload-barrier", { type: "get_skill_diagnostics" });
			expect(rpc.diagnosticEvents()).toHaveLength(beforeUnchangedReload);

			await rpc.request("move", { type: "prompt", message: `/move ${movedProject}` });
			const movedEvents = await rpc.waitForDiagnosticEvents(beforeUnchangedReload + 1);
			const moved = movedEvents.at(-1)!.data;
			assertAllowlistedSnapshot(moved);
			expect(moved).toEqual({ cwd: movedProject, showStartupDiagnostics: false, diagnostics: [] });
			expect(responseData(await rpc.request("get-moved", { type: "get_skill_diagnostics" }))).toEqual(moved);
			expect(rpc.diagnosticEvents()).toHaveLength(beforeUnchangedReload + 1);
		} finally {
			await rpc.close();
		}

		const persisted = Bun.YAML.parse(await Bun.file(path.join(agentDir, "config.yml")).text()) as {
			skills?: { showStartupDiagnostics?: boolean };
		};
		expect(persisted.skills?.showStartupDiagnostics).toBe(false);

		const restarted = await spawnRpc({ cwd: movedProject, agentDir });
		try {
			const snapshot = responseData(await restarted.request("get-restarted", { type: "get_skill_diagnostics" }));
			assertAllowlistedSnapshot(snapshot);
			expect(snapshot.showStartupDiagnostics).toBe(false);
		} finally {
			await restarted.close();
		}
	}, 60_000);

	test("an SDK session keeps the setting in memory", async () => {
		await using temp = await TempDir.create("@rpc-skill-diagnostics-sdk-");
		const agentDir = temp.join("agent");
		await fs.mkdir(agentDir);
		const runtime = temp.join("runtime.ts");
		const sourceDir = path.resolve(import.meta.dir, "../src");
		await Bun.write(
			runtime,
			`
import { createAgentSession, Settings } from ${JSON.stringify(path.join(sourceDir, "sdk.ts"))};
import { runRpcMode } from ${JSON.stringify(path.join(sourceDir, "modes/rpc/rpc-mode.ts"))};
const { session } = await createAgentSession({
  cwd: process.cwd(),
  skills: [],
  rules: [],
  slashCommands: [],
  toolNames: [],
  enableMCP: false,
  enableLsp: false,
  disableExtensionDiscovery: true,
  settings: Settings.isolated(Bun.env.PIN_SKILL_DIAGNOSTICS === "1" ? { "skills.showStartupDiagnostics": true } : {}),
});
await runRpcMode(session);
`,
		);
		const env = {
			HOME: path.join(agentDir, "home"),
			PI_CODING_AGENT_DIR: agentDir,
			XDG_CONFIG_HOME: path.join(agentDir, "config"),
			XDG_DATA_HOME: path.join(agentDir, "data"),
			XDG_CACHE_HOME: path.join(agentDir, "cache"),
			CI: "true",
			PI_NO_TITLE: "1",
		};
		const client = new RpcClient({
			cliPath: runtime,
			cwd: temp.path(),
			env,
		});
		const updates: SkillDiagnosticsSnapshot[] = [];
		try {
			await client.start();
			client.onSkillDiagnosticsUpdate(snapshot => updates.push(snapshot));
			await client.getSkillDiagnostics();
			updates.length = 0;
			const disabled = await client.setSkillStartupDiagnostics(false);
			assertAllowlistedSnapshot(disabled);
			expect(disabled.showStartupDiagnostics).toBe(false);
			expect((await client.getState()).skillDiagnostics).toEqual(disabled);
			expect(await client.getSkillDiagnostics()).toEqual(disabled);
			expect(updates).toEqual([disabled]);
		} finally {
			await client.stop();
		}
		expect(await Bun.file(path.join(agentDir, "config.yml")).exists()).toBe(false);

		const overrideClient = new RpcClient({
			cliPath: runtime,
			cwd: temp.path(),
			env: { ...env, PIN_SKILL_DIAGNOSTICS: "1" },
		});
		const overrideUpdates: SkillDiagnosticsSnapshot[] = [];
		try {
			await overrideClient.start();
			await overrideClient.getSkillDiagnostics();
			overrideUpdates.length = 0;
			overrideClient.onSkillDiagnosticsUpdate(snapshot => overrideUpdates.push(snapshot));
			const effective = await overrideClient.setSkillStartupDiagnostics(false);
			expect(effective.showStartupDiagnostics).toBe(true);
			expect((await overrideClient.getState()).skillDiagnostics).toEqual(effective);
			expect(overrideUpdates).toEqual([]);
		} finally {
			await overrideClient.stop();
		}
		expect(await Bun.file(path.join(agentDir, "config.yml")).exists()).toBe(false);
	}, 30_000);

	test("a native config.yml edit under the live settings watcher updates the effective setting and keeps manual data", async () => {
		await using temp = await TempDir.create("@rpc-skill-diagnostics-watch-");
		const project = temp.join("project");
		const agentDir = temp.join("agent");
		const firstRoot = temp.join("first");
		const secondRoot = temp.join("second");
		await Promise.all([fs.mkdir(project), fs.mkdir(agentDir)]);
		await writeSkill(firstRoot, "---\nname: review\ndescription: First\n---\n\nfirst\n");
		await writeSkill(secondRoot, "---\nname: review\ndescription: Second\n---\n\nsecond\n");
		const configFile = path.join(agentDir, "config.yml");
		const roots = [firstRoot, secondRoot];
		await Bun.write(configFile, skillConfig(roots));

		const rpc = await spawnRpc({ cwd: project, agentDir });
		try {
			const [startupEvent] = await rpc.waitForDiagnosticEvents(1);
			const startup = startupEvent!.data;
			assertAllowlistedSnapshot(startup);
			expect(startup.showStartupDiagnostics).toBe(true);
			expect(startup.diagnostics).toHaveLength(1);

			// What the browser's native Settings checkbox does: rewrite config.yml out of band.
			await Bun.write(configFile, skillConfig(roots, false));
			const disabledEvent = (await rpc.waitForDiagnosticEvents(2))[1]!;
			expect(disabledEvent.data).toEqual({ ...startup, showStartupDiagnostics: false });
			expect(responseData(await rpc.request("get-off", { type: "get_skill_diagnostics" }))).toEqual(
				disabledEvent.data,
			);
			expect(responseData(await rpc.request("state-off", { type: "get_state" }))).toMatchObject({
				skillDiagnostics: disabledEvent.data,
			});

			await Bun.write(configFile, skillConfig(roots, true));
			const enabledEvent = (await rpc.waitForDiagnosticEvents(3))[2]!;
			expect(enabledEvent.data).toEqual(startup);
			expect(rpc.diagnosticEvents()).toHaveLength(3);
		} finally {
			await rpc.close();
		}
	}, 60_000);

	test("a plugin-backed skill exposes its plugin name but none of the plugin's private fields", async () => {
		await using temp = await TempDir.create("@rpc-skill-diagnostics-plugin-");
		const project = temp.join("project");
		const agentDir = temp.join("agent");
		const customRoot = temp.join("custom");
		const pluginRoot = temp.join("plugin");
		await Promise.all([fs.mkdir(project), fs.mkdir(agentDir)]);
		await writeSkill(customRoot, "---\nname: review\ndescription: Custom\n---\n\ncustom body\n");
		const pluginSkill = await writeSkill(
			path.join(pluginRoot, "skills"),
			"---\nname: review\ndescription: Plugin\n---\n\nplugin body\n",
		);
		await Bun.write(
			path.join(pluginRoot, "plugin.json"),
			JSON.stringify({ $schema: AGENT_PLUGIN_MANIFEST_SCHEMA, name: "acme-tools" }),
		);
		await Bun.write(path.join(agentDir, "config.yml"), skillConfig([customRoot]));

		const rpc = await spawnRpc({
			cwd: project,
			agentDir,
			args: [
				"--mode",
				"rpc",
				"--no-extensions",
				"--no-rules",
				"--no-tools",
				"--plugin-dir",
				pluginRoot,
				"--provider",
				"anthropic",
				"--model",
				"claude-sonnet-4-5",
			],
		});
		try {
			const snapshot = responseData(await rpc.request("plugin-getter", { type: "get_skill_diagnostics" }));
			// Plugin skills carry `containRoot`/`_source`; the allowlist assertion rejects both in the payload.
			assertAllowlistedSnapshot(snapshot);
			const realPluginSkill = await fs.realpath(pluginSkill);
			const entries = snapshot.diagnostics.flatMap(diagnostic => diagnostic.skills);
			const fromPlugin = entries.filter(
				entry => entry.filePath === realPluginSkill || entry.filePath === pluginSkill,
			);
			expect(fromPlugin).toHaveLength(1);
			// Extracted from the resolver's private `_source`; non-plugin entries carry no key.
			expect(fromPlugin[0]!.pluginName).toBe("acme-tools");
			expect(entries.filter(entry => "pluginName" in entry)).toEqual(fromPlugin);
		} finally {
			await rpc.close();
		}
	}, 60_000);
});
