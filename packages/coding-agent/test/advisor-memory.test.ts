import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import type { Model } from "@oh-my-pi/pi-ai";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { getMemoryRoot } from "@oh-my-pi/pi-coding-agent/memories";
import { AgentRegistry } from "@oh-my-pi/pi-coding-agent/registry/agent-registry";
import { createAgentSession } from "@oh-my-pi/pi-coding-agent/sdk";
import type { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import { sharpshooterMemoryFilePath } from "@oh-my-pi/pi-coding-agent/sharpshooter/paths";
import { getAgentDir, setAgentDir, TempDir } from "@oh-my-pi/pi-utils";
import { createInMemoryAuthStorage } from "./helpers/agent-session-setup";

describe("advisor memory context", () => {
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;

	beforeAll(() => {
		authStorage = createInMemoryAuthStorage();
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(() => {
		authStorage.close();
	});

	let tempDir: TempDir;
	let session: AgentSession | undefined;

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		try {
			await tempDir.remove();
		} catch {}
	});

	async function createAdvisedSession(
		backend: string,
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path()),
	): Promise<AgentSession> {
		const settings = Settings.isolated({
			"async.enabled": false,
			"advisor.enabled": true,
			"compaction.enabled": false,
			"memory.backend": backend,
			"mnemopi.noEmbeddings": true,
			"mnemopi.llmMode": "none",
			"mnemopi.autoRecall": false,
			"mnemopi.autoRetain": false,
		});
		settings.setModelRole("advisor", `${model.provider}/${model.id}`);
		await settings.reloadForCwd(tempDir.path());
		const result = await createAgentSession({
			cwd: tempDir.path(),
			agentDir: tempDir.path(),
			sessionManager,
			agentRegistry: new AgentRegistry(),
			authStorage,
			modelRegistry,
			settings,
			model,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			workspaceTree: {
				rootPath: tempDir.path(),
				rendered: "",
				truncated: false,
				totalLines: 0,
				agentsMdFiles: [],
			},
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
		});
		return result.session;
	}

	it("injects the sharpshooter summary into main and advisor prompts without a recall tool", async () => {
		tempDir = TempDir.createSync("@pi-advisor-memory-");
		const decision = "Keep storage project-scoped for advisor memory test.";
		const memoryFile = sharpshooterMemoryFilePath(tempDir.path(), tempDir.path(), "architecture.md");
		await fs.mkdir(memoryFile.slice(0, memoryFile.lastIndexOf("/")), { recursive: true });
		await Bun.write(memoryFile, `- ${decision}\n`);

		session = await createAdvisedSession("sharpshooter");
		// Primary path: the decision file lands in the main agent's system prompt.
		expect(session.agent.state.systemPrompt.join("\n")).toContain(decision);

		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to exist");
		// Advisor path: same summary, wrapped as shared background knowledge.
		const advisorPrompt = advisor.state.systemPrompt.join("\n");
		expect(advisorPrompt).toContain("<memory-context>");
		expect(advisorPrompt).toContain(decision);
		// Sharpshooter builds no recall tool, so the default roster stays read-only.
		expect(advisor.state.tools.map(tool => tool.name)).not.toContain("recall");
	});

	it("grants the default advisor roster a recall tool when the backend builds one", async () => {
		tempDir = TempDir.createSync("@pi-advisor-memory-");
		// Hindsight without apiUrl is inert at runtime but still builds the recall
		// tool (MemoryRecallTool.createIf gates on the setting alone), which is
		// exactly what the advisor roster filter consumes.
		session = await createAdvisedSession("hindsight");
		const advisor = session.getAdvisorAgent();
		if (!advisor) throw new Error("Expected advisor agent to exist");
		const names = advisor.state.tools.map(tool => tool.name);
		expect(names).toContain("recall");
		// Default read-only investigative set is unchanged otherwise.
		expect(names).toContain("read");
		expect(names).not.toContain("retain");
		expect(names).not.toContain("edit");
	});

	it.each(["hindsight", "mnemopi"])("keeps in-memory advisor URL tools bound to the %s session", async backend => {
		tempDir = TempDir.createSync("@pi-advisor-memory-urls-");
		const previousAgentDir = getAgentDir();
		setAgentDir(tempDir.path());
		try {
			const memoryRoot = getMemoryRoot(tempDir.path(), tempDir.path());
			await fs.mkdir(memoryRoot, { recursive: true });
			await Bun.write(`${memoryRoot}/memory_summary.md`, "Advisor project summary marker.\n");
			session = await createAdvisedSession(backend, SessionManager.inMemory(tempDir.path()));
			expect(session.sessionFile).toBeUndefined();
			const advisor = session.getAdvisorAgent();
			if (!advisor) throw new Error("Expected advisor agent to exist");
			const read = advisor.state.tools.find(tool => tool.name === "read");
			const grep = advisor.state.tools.find(tool => tool.name === "grep");
			const glob = advisor.state.tools.find(tool => tool.name === "glob");
			if (!read || !grep || !glob) throw new Error("Expected default advisor URL tools");

			const readResult = await read.execute("advisor-root-read", { path: "memory://root" });
			expect(JSON.stringify(readResult.content)).toContain("Advisor project summary marker.");
			const grepResult = await grep.execute("advisor-root-grep", {
				path: "memory://root",
				pattern: "Advisor project summary marker",
			});
			expect(JSON.stringify(grepResult.content)).toContain("Advisor project summary marker.");
			for (const path of ["memory://root", "memory://root/*.md"]) {
				const globResult = await glob.execute("advisor-root-glob", { path });
				expect(JSON.stringify(globResult.content)).toContain("memory_summary.md");
			}

			if (backend === "mnemopi") {
				for (let attempt = 0; !session.getMnemopiSessionState() && attempt < 100; attempt++) {
					await Bun.sleep(10);
				}
				const id = session.getMnemopiSessionState()?.rememberInScope("Advisor scoped memory marker.");
				if (!id) throw new Error("Expected a stored memory id");
				const row = await read.execute("advisor-memory-read", { path: `memory://${id}` });
				expect(JSON.stringify(row.content)).toContain("Advisor scoped memory marker.");
				const match = await grep.execute("advisor-memory-grep", {
					path: `memory://${id}`,
					pattern: "Advisor scoped memory marker",
				});
				expect(JSON.stringify(match.content)).toContain("Advisor scoped memory marker.");
			} else {
				await expect(read.execute("advisor-memory-read", { path: "memory://some-id" })).rejects.toThrow(
					"Hindsight memories are not addressable via memory://",
				);
			}
		} finally {
			await session?.dispose();
			session = undefined;
			setAgentDir(previousAgentDir);
		}
	});
});
