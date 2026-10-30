import { afterAll, beforeAll, describe, expect, it, type Mock, spyOn } from "bun:test";
import * as os from "node:os";
import { AuthStorage } from "@oh-my-pi/pi-ai";
import { closeModelCache } from "@oh-my-pi/pi-catalog/model-cache";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { buildSessionOptions } from "@oh-my-pi/pi-coding-agent/main";
import * as sdkModule from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { __resetDirsFromEnvForTests, getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";

const PRIMARY_MARKER = "primary-context-marker-7f3a";
const EXTRA_ROOT_MARKER = "extra-root-context-marker-2c9d";
const IMPORTED_MARKER = "imported-context-marker-5e1b";
const USER_AGENTS_MARKER = "user-agents-marker-9b41";
const EXTRA_CLAUDE_MARKER = "extra-claude-marker-6a07";
const NESTED_DIR = "nested-context-dir-4d8e";
// A nested AGENTS.md is not inlined; the prompt lists its path for the agent to read.
const NESTED_LISTING = `${NESTED_DIR}/AGENTS.md`;
const MARKERS = [
	PRIMARY_MARKER,
	EXTRA_ROOT_MARKER,
	IMPORTED_MARKER,
	USER_AGENTS_MARKER,
	EXTRA_CLAUDE_MARKER,
	NESTED_LISTING,
];
const ENV_KEYS = ["PI_CODING_AGENT_DIR", "OMP_PROFILE", "PI_PROFILE"] as const;

describe("--no-context-files", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let homedirSpy: Mock<typeof os.homedir>;
	const originalEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]));

	beforeAll(async () => {
		tempDir = await TempDir.create("@cli-no-context-files-");
		// User-level discovery reads the process-global agent dir and home: point both at the
		// fixture so neither run picks up the developer's own config.
		setAgentDir(tempDir.join("home/.omp/agent"));
		homedirSpy = spyOn(os, "homedir").mockReturnValue(tempDir.join("home"));
		await Promise.all([
			Bun.write(tempDir.join("project/AGENTS.md"), `${PRIMARY_MARKER}\n`),
			Bun.write(tempDir.join(`project/${NESTED_DIR}/AGENTS.md`), "nested\n"),
			Bun.write(tempDir.join("extra/AGENTS.md"), `${EXTRA_ROOT_MARKER}\n@imported.md\n`),
			Bun.write(tempDir.join("extra/imported.md"), `${IMPORTED_MARKER}\n`),
			Bun.write(tempDir.join("home/.omp/agent/AGENTS.md"), `${USER_AGENTS_MARKER}\n`),
			Bun.write(tempDir.join("extra-claude/CLAUDE.md"), `${EXTRA_CLAUDE_MARKER}\n`),
		]);
		authStorage = await AuthStorage.create(tempDir.join("auth.db"));
		authStorage.keys.setRuntime("openai", "test-key");
		modelRegistry = new ModelRegistry(authStorage, tempDir.join("models.yml"));
	});

	afterAll(async () => {
		authStorage.close();
		closeModelCache();
		homedirSpy.mockRestore();
		for (const key of ENV_KEYS) {
			if (originalEnv[key] === undefined) delete process.env[key];
			else process.env[key] = originalEnv[key];
		}
		__resetDirsFromEnvForTests();
		await tempDir.remove();
	});

	async function createSession(flags: string[]) {
		const settings = Settings.isolated({
			"async.enabled": false,
			"task.isolation.enabled": false,
			"task.enableLsp": false,
			"advisor.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			includeWorkspaceTree: true,
		});
		const args = parseArgs([
			"--cwd",
			tempDir.join("project"),
			"--add-dir",
			tempDir.join("extra"),
			"--add-dir",
			tempDir.join("extra-claude"),
			...flags,
		]);
		const options = await buildSessionOptions(args, [], SessionManager.inMemory(args.cwd), modelRegistry, settings);
		const { session } = await sdkModule.createAgentSession({
			...options,
			agentDir: getAgentDir(),
			modelRegistry,
			settings,
			model: getBundledModel("openai", "gpt-4o-mini"),
			enableLsp: false,
			skipPythonPreflight: true,
		});
		return session;
	}

	/** Spawns one `task` subagent through the session's own task tool and returns the child's system prompt. */
	async function subagentPrompt(session: AgentSession): Promise<string> {
		const createChild = sdkModule.createAgentSession;
		let childPrompt: string | undefined;
		// The child's prompt is settled once it is created; stop before its first model call.
		const createSpy = spyOn(sdkModule, "createAgentSession").mockImplementation(async childOptions => {
			const created = await createChild(childOptions);
			childPrompt = created.session.systemPrompt.join("\n");
			await created.session.dispose();
			throw new Error("child prompt captured");
		});
		try {
			await session.getToolByName("task")?.execute("no-context-files-child", {
				agent: "task",
				name: "ContextProbe",
				task: "Report.",
				solutionSpace: "one fix: probe only",
			});
		} finally {
			createSpy.mockRestore();
		}
		if (childPrompt === undefined) throw new Error("task tool did not create a subagent session");
		return childPrompt;
	}

	it("keeps every context file, including additional roots' and their imports, out of the session and its subagents", async () => {
		const ambient = await createSession([]);
		try {
			const prompt = ambient.systemPrompt.join("\n");
			for (const marker of MARKERS) expect(prompt).toContain(marker);
			// Subagents rediscover additional roots but never receive an AGENTS.md: not the
			// parent's, not the user-level one, and not one found under an additional root.
			const childPrompt = await subagentPrompt(ambient);
			expect(childPrompt).toContain(EXTRA_CLAUDE_MARKER);
			for (const marker of [PRIMARY_MARKER, EXTRA_ROOT_MARKER, IMPORTED_MARKER, USER_AGENTS_MARKER]) {
				expect(childPrompt).not.toContain(marker);
			}
		} finally {
			await ambient.dispose();
		}

		const session = await createSession(["--no-context-files"]);
		try {
			for (const marker of MARKERS) expect(session.systemPrompt.join("\n")).not.toContain(marker);
			await session.refreshBaseSystemPrompt();
			for (const marker of MARKERS) expect(session.systemPrompt.join("\n")).not.toContain(marker);
			const childPrompt = await subagentPrompt(session);
			for (const marker of MARKERS) expect(childPrompt).not.toContain(marker);
		} finally {
			await session.dispose();
		}
	}, 60_000);
});
