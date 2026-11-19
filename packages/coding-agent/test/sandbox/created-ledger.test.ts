/**
 * G7: protected paths contained code created or replaced. The identity watch, the ledger in the
 * agent dir, and its consumers (the runtime's protected set, project discovery, host git, Trust and
 * Remove). The contained cases skip where no backend exists.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolContext } from "@oh-my-pi/pi-agent-core";
import { defineCapability, loadCapability, registerProvider } from "@oh-my-pi/pi-coding-agent/capability";
import type { SourceMeta } from "@oh-my-pi/pi-coding-agent/capability/types";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { releaseShellSessions } from "@oh-my-pi/pi-coding-agent/exec/bash-executor";
import { ExtensionRuntime } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@oh-my-pi/pi-coding-agent/extensibility/extensions/wrapper";
import {
	changedIdentities,
	identitySnapshot,
	installSandboxRepoGuard,
	recordSandboxCreated,
	sandboxCreatedEntries,
} from "@oh-my-pi/pi-coding-agent/sandbox/ledger";
import { SandboxRuntime } from "@oh-my-pi/pi-coding-agent/sandbox/runtime";
import { cfgSandboxEnabled, cfgSandboxNetworkMode } from "@oh-my-pi/pi-coding-agent/sandbox/settings";
import type { SandboxAccessRequest } from "@oh-my-pi/pi-coding-agent/sandbox/types";
import { AgentStorage } from "@oh-my-pi/pi-coding-agent/session/agent-storage";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { Tool, ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { BashTool } from "@oh-my-pi/pi-coding-agent/tools/bash";
import { sandboxSupport } from "@oh-my-pi/pi-natives";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { configFileSources } from "@oh-my-pi/pi-coding-agent/utils/config-file-sources";
import { git, SANDBOX_SUPPORTED } from "../helpers/sandbox-test-state";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

const backend = sandboxSupport();

let state: SettingsTestState | undefined;
let settings: Settings;
let scratch: TempDir;
/** `<scratch>/workspace`, realpath'd. */
let workspace: string;
/** `<scratch>/agent`: the agent dir, holding the ledger. */
let agentDir: string;
let runtimes: SandboxRuntime[];

async function runtime(): Promise<SandboxRuntime> {
	const instance = await SandboxRuntime.for(workspace);
	runtimes.push(instance);
	return instance;
}

/** Runs `script` contained in the workspace; resolves once it exited. */
async function run(instance: SandboxRuntime, script: string): Promise<number> {
	const env: Record<string, string> = {};
	for (const [key, value] of Object.entries(process.env)) if (value !== undefined) env[key] = value;
	const child = await instance.spawn({ argv: ["/bin/sh", "-c", script], cwd: workspace, env });
	child.stdin.end();
	await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()]);
	return child.exited;
}

function entry(target: string) {
	return { path: target, real: target, workspace, at: Date.now() };
}

function ledgered(): string[] {
	return sandboxCreatedEntries()
		.map(created => created.path)
		.sort();
}

beforeEach(async () => {
	state = beginSettingsTest();
	// Not under the OS temp dir: on Linux the sandbox hides the host's /tmp.
	scratch = TempDir.createSync(path.join(os.homedir(), ".omp-sandbox-ledger-"));
	const root = fs.realpathSync(scratch.path());
	workspace = path.join(root, "workspace");
	agentDir = path.join(root, "agent");
	const systemTmp = path.join(root, "tmp");
	for (const dir of [workspace, systemTmp]) fs.mkdirSync(dir);
	setAgentDir(agentDir);
	vi.spyOn(os, "tmpdir").mockReturnValue(systemTmp);
	runtimes = [];
	SandboxRuntime.resetForTest();
	settings = await Settings.init({ inMemory: true, cwd: workspace });
});

afterEach(async () => {
	try {
		for (const instance of runtimes) await instance.dispose();
		SandboxRuntime.resetForTest();
		SandboxRuntime.setAccessApprover(undefined);
	} finally {
		restoreSettingsTestState(state);
		state = undefined;
		AgentStorage.close();
		scratch.removeSync();
	}
});

describe("identity watch", () => {
	it.skipIf(process.platform === "win32")(
		"reports what appeared, a replaced ancestor (not its children) and a re-pointed link; never a removal or a leaf replaced in place",
		() => {
			const gitDir = path.join(workspace, ".git");
			const config = path.join(gitDir, "config");
			const link = path.join(workspace, ".mcp.json");
			const removed = path.join(workspace, ".vscode");
			const rewritten = path.join(workspace, "opencode.json");
			const appeared = path.join(workspace, ".omp");
			fs.mkdirSync(gitDir);
			fs.writeFileSync(config, "");
			fs.writeFileSync(path.join(workspace, "a.json"), "{}");
			fs.writeFileSync(path.join(workspace, "b.json"), "{}");
			fs.symlinkSync("a.json", link);
			fs.mkdirSync(removed);
			fs.writeFileSync(rewritten, "{}");
			const before = identitySnapshot([gitDir, config, link, removed, rewritten, appeared]);

			fs.renameSync(gitDir, path.join(workspace, ".git-old"));
			fs.mkdirSync(gitDir);
			fs.writeFileSync(config, "");
			fs.unlinkSync(link);
			fs.symlinkSync("b.json", link);
			fs.rmdirSync(removed);
			// As host git rewrites `.git/config`: a new file renamed over the old one.
			fs.writeFileSync(`${rewritten}.lock`, "{}");
			fs.renameSync(`${rewritten}.lock`, rewritten);
			fs.mkdirSync(appeared);

			expect(changedIdentities(before, identitySnapshot(before.keys()))).toEqual([gitDir, link, appeared]);
		},
	);

	it.skipIf(!backend.supported)(
		"ledgers a protected path a contained command creates; it stays protected",
		async () => {
			cfgSandboxEnabled.set(settings, true);
			cfgSandboxNetworkMode.set(settings, "deny");
			const instance = await runtime();
			const omp = path.join(workspace, ".omp");
			expect(await run(instance, "mkdir .omp && echo x > .omp/x")).toBe(0);

			expect(ledgered()).toEqual([omp]);
			expect(instance.accessDenial([{ kind: "write", target: path.join(omp, "y") }])?.protectedPath).toBe(true);
			expect(await run(instance, "echo y > .omp/y")).not.toBe(0);
			expect(fs.existsSync(path.join(omp, "y"))).toBe(false);
		},
	);

	it.skipIf(!backend.supported)(
		"ledgers the `.git` a contained `git init` creates in a workspace without one",
		async () => {
			cfgSandboxEnabled.set(settings, true);
			cfgSandboxNetworkMode.set(settings, "deny");
			const instance = await runtime();
			expect(await run(instance, "GIT_CONFIG_GLOBAL=/dev/null GIT_CONFIG_SYSTEM=/dev/null git init -q")).toBe(0);
			expect(ledgered()).toEqual([path.join(workspace, ".git")]);
		},
	);

	it.skipIf(!backend.supported)(
		"asks at detection without holding the result; an allow trusts the path, a deny keeps it",
		async () => {
			cfgSandboxEnabled.set(settings, true);
			cfgSandboxNetworkMode.set(settings, "deny");
			const vscode = path.join(workspace, ".vscode");
			const cursor = path.join(workspace, ".cursor");
			const asked: string[] = [];
			const bothAsked = Promise.withResolvers<void>();
			const answer = Promise.withResolvers<void>();
			SandboxRuntime.setAccessApprover(async (request: SandboxAccessRequest) => {
				asked.push(`${request.kind} ${request.target}`);
				if (asked.length === 2) bothAsked.resolve();
				if (request.target === cursor) return { decision: "deny" };
				await answer.promise;
				return { decision: "session" };
			});
			const instance = await runtime();
			// Resolves while the dialogs are still open.
			expect(await run(instance, "mkdir .vscode .cursor")).toBe(0);
			await bothAsked.promise;
			expect(asked.sort()).toEqual([`write ${cursor}`, `write ${vscode}`]);
			expect(ledgered()).toEqual([cursor, vscode]);

			// The removal notifies every runtime (the grant before it does too); the deny settled before it.
			const trusted = Promise.withResolvers<void>();
			const unsubscribe = instance.onChange(() => {
				if (!ledgered().includes(vscode)) trusted.resolve();
			});
			answer.resolve();
			await trusted.promise;
			unsubscribe();
			expect(ledgered()).toEqual([cursor]);
			expect(instance.accessDenial([{ kind: "write", target: path.join(vscode, "x") }])).toBeUndefined();
		},
	);
});

describe("detection when a tool call settles", () => {
	let authRoot: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;

	beforeAll(async () => {
		authRoot = TempDir.createSync("@omp-sandbox-ledger-auth-");
		authStorage = await AuthStorage.create(path.join(authRoot.path(), "testauth.db"));
		modelRegistry = new ModelRegistry(authStorage);
	});
	afterAll(() => {
		authStorage.close();
		authRoot.removeSync();
	});

	it.skipIf(!backend.supported)("ledgers what a bash call wrote through the pooled shell host", async () => {
		cfgSandboxEnabled.set(settings, true);
		cfgSandboxNetworkMode.set(settings, "deny");
		const sessionKey = "created-ledger-bash";
		const toolSession = {
			cwd: workspace,
			hasUI: false,
			skills: [],
			getSessionFile: () => null,
			getSessionId: () => sessionKey,
			settings: Settings.isolated({
				"async.enabled": false,
				"bash.autoBackground.enabled": false,
				"bashInterceptor.enabled": false,
			}),
			getClientBridge: () => undefined,
		} as unknown as ToolSession;
		const session = SessionManager.inMemory(workspace);
		const runner = new ExtensionRunner([], new ExtensionRuntime(), agentDir, session, modelRegistry);
		const bash: Tool = new BashTool(toolSession);
		const wrapper = new ExtensionToolWrapper(bash, runner);
		const context = { sessionManager: session, modelRegistry, settings } as unknown as AgentToolContext;
		await runtime();
		try {
			// The first call starts the pooled host; the second writes through it (no spawn, no exit).
			await wrapper.execute("b1", { command: "true" }, undefined, undefined, context);
			await wrapper.execute("b2", { command: "mkdir .omp && echo x > .omp/x" }, undefined, undefined, context);
			expect(ledgered()).toEqual([path.join(workspace, ".omp")]);
		} finally {
			releaseShellSessions(sessionKey);
		}
	});
});

describe("ledger consumers", () => {
	interface Item {
		name: string;
		_source: SourceMeta;
	}
	const capabilityId = "sandbox-ledger-test";
	let items: Item[] = [];
	defineCapability<Item>({
		id: capabilityId,
		displayName: "Ledger test",
		description: "",
		key: item => item.name,
	});
	registerProvider<Item>(capabilityId, {
		id: "sandbox-ledger-test",
		displayName: "Ledger test",
		description: "",
		priority: 1,
		load: async () => ({ items, warnings: [] }),
	});
	const item = (name: string, file: string, level: SourceMeta["level"]): Item => ({
		name,
		_source: { provider: "sandbox-ledger-test", providerName: "", path: file, level },
	});

	it("skips project items at or under a ledgered path, keeps the others", async () => {
		const omp = path.join(workspace, ".omp");
		recordSandboxCreated([entry(omp)]);
		fs.mkdirSync(omp);
		fs.writeFileSync(path.join(omp, "lsp.json"), "{}");
		items = [
			item("under", path.join(omp, "mcp.json"), "project"),
			item("outside", path.join(workspace, "mcp.json"), "project"),
			item("user", path.join(omp, "user.json"), "user"),
		];
		const result = await loadCapability<Item>(capabilityId, { cwd: workspace });
		expect(result.items.map(loaded => loaded.name)).toEqual(["outside", "user"]);
		expect(result.warnings.some(warning => warning.includes(path.join(omp, "mcp.json")))).toBe(true);
		// Config files read straight from the project dirs (lsp, dap) skip the ledgered `.omp` too.
		const read = configFileSources("lsp", workspace, (_content, file) => file).map(source => source.read());
		expect(read).not.toContain(path.join(omp, "lsp.json"));
	});

	it("refuses host git on a repository holding ledgered metadata, and only there, on a handle taken before", async () => {
		const other = path.join(path.dirname(workspace), "other");
		fs.mkdirSync(other);
		git(workspace, "init", "-q");
		git(other, "init", "-q");
		// Cached like the status line's handle: taken before the guard and the entry exist.
		const handle = vcs.git(workspace)!;
		installSandboxRepoGuard();
		try {
			recordSandboxCreated([entry(path.join(workspace, ".git", "hooks"))]);
			await expect(handle.statusSummary()).rejects.toMatchObject({ code: "Refused" });
			expect(await vcs.git(other)?.statusSummary()).toBeDefined();
		} finally {
			vcs.setRepoGuard(undefined);
		}
	});

	it.skipIf(process.platform === "win32")(
		"treats a `.git` replaced by a file as a change (no throw below it) and refuses the repository its gitdir names",
		async () => {
			const gitDir = path.join(workspace, ".git");
			const evil = path.join(workspace, "evil");
			git(workspace, "init", "-q");
			// Another repository's git dir (its work tree lies outside the workspace).
			git(workspace, "init", "-q", "--separate-git-dir", evil, path.join(path.dirname(workspace), "other"));
			const watched = [gitDir, path.join(gitDir, "config"), path.join(gitDir, "hooks")];
			const before = identitySnapshot(watched);

			fs.renameSync(gitDir, path.join(workspace, ".git-away"));
			fs.writeFileSync(gitDir, `gitdir: ${evil}\n`);
			// `.git/config` now lies below a file: ENOTDIR reads as missing, not an error.
			expect(changedIdentities(before, identitySnapshot(watched))).toEqual([gitDir]);

			recordSandboxCreated([entry(gitDir)]);
			installSandboxRepoGuard();
			try {
				// Its git dir is `evil`, outside the ledgered `.git`: only the git entry path names the ledgered file.
				await expect(vcs.git(workspace)!.statusSummary()).rejects.toMatchObject({ code: "Refused" });
			} finally {
				vcs.setRepoGuard(undefined);
			}
		},
	);

	it("Trust lifts the ledger's protection; Remove keeps a path that still exists", async () => {
		SandboxRuntime.resetForTest(SANDBOX_SUPPORTED);
		cfgSandboxEnabled.set(settings, true);
		const scripts = path.join(workspace, "scripts");
		const gone = path.join(workspace, "gone");
		fs.mkdirSync(scripts);
		recordSandboxCreated([entry(scripts), entry(gone)]);
		const instance = await runtime();
		const write = [{ kind: "write" as const, target: path.join(scripts, "x") }];
		expect(instance.accessDenial(write)?.protectedPath).toBe(true);

		expect(() => instance.forgetCreated(scripts)).toThrow("still exists");
		instance.forgetCreated(gone);
		expect(ledgered()).toEqual([scripts]);

		instance.trustCreated(scripts);
		expect(sandboxCreatedEntries()).toEqual([]);
		expect(instance.accessDenial(write)).toBeUndefined();
	});
});
