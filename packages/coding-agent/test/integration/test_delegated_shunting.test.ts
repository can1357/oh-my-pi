import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { create } from "@bufbuild/protobuf";
import { Agent } from "@pk-nerdsaver-ai/pi-agent-core";
import { createMockModel, type MockModel, type MockResponse } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import {
	DeleteArgsSchema,
	ShellArgsSchema,
	WriteArgsSchema,
} from "@pk-nerdsaver-ai/pi-catalog/discovery/cursor-gen/agent_pb";
import { getBundledModel } from "@pk-nerdsaver-ai/pi-catalog/models";
import { TempDir } from "@pk-nerdsaver-ai/pi-utils";
import { __resetDirsFromEnvForTests, getActiveProfile, getAgentDir, setAgentDir } from "@pk-nerdsaver-ai/pi-utils/dirs";
import { type } from "arktype";
import { AsyncJobManager } from "../../src/async";
import { ModelRegistry } from "../../src/config/model-registry";
import { Settings } from "../../src/config/settings";
import { parseNativeTaskJobPayload } from "../../src/operational/native-task-payload";
import { OperationalStore } from "../../src/operational/store";
import { AgentLifecycleManager } from "../../src/registry/agent-lifecycle";
import { AgentRegistry } from "../../src/registry/agent-registry";
import * as sdk from "../../src/sdk";
import type { AgentSession } from "../../src/session/agent-session";
import { AuthStorage } from "../../src/session/auth-storage";
import { SessionManager } from "../../src/session/session-manager";
import { TaskTool } from "../../src/task";
import { projectEvidenceDigest } from "../../src/task/delegated-output";
import * as discovery from "../../src/task/discovery";
import { finalizeSubagentLifecycle } from "../../src/task/executor";
import { AgentOutputManager } from "../../src/task/output-manager";
import { type AgentDefinition, getTaskSchema } from "../../src/task/types";
import * as worktree from "../../src/task/worktree";
import type { ToolSession } from "../../src/tools";
import { checkBashInterception } from "../../src/tools/bash-interceptor";

// pi/task is a model-role/tool dispatch, not an HTTP endpoint. The runtime
// Public contracts use real restricted child sessions and parent receipt projection.
// Only provider responses are scripted; filesystem, isolation, integration and tools are real.
const workerDefinition: AgentDefinition = {
	name: "task",
	description: "Deterministic delegated worker",
	systemPrompt: "Read or write the assigned file, then yield only the requested result.",
	tools: ["read", "write", "yield"],
	source: "bundled",
};
const createRealSession = sdk.createAgentSession;

describe("delegated shunting integration", () => {
	let directory: TempDir;
	let auth: AuthStorage;
	let tool: TaskTool;
	let settings: Settings;
	let workerResponses: MockResponse[];
	const children: AgentSession[] = [];
	const nativeSessions: AgentSession[] = [];
	let registry: ModelRegistry;
	let workerHandler: NonNullable<Parameters<typeof createMockModel>[0]>["handler"];
	let onChildCreated: ((session: AgentSession) => Promise<void>) | undefined;
	let onNativeCreated: ((session: AgentSession) => Promise<void>) | undefined;
	const parents: AgentSession[] = [];
	const models: MockModel[] = [];
	let originalDirs: {
		agent: string | undefined;
		ompProfile: string | undefined;
		piProfile: string | undefined;
		effective: string;
		profile: string | undefined;
	};

	beforeEach(async () => {
		directory = TempDir.createSync("@pi-delegated-shunting-");
		originalDirs = {
			agent: Bun.env.PI_CODING_AGENT_DIR,
			ompProfile: Bun.env.OMP_PROFILE,
			piProfile: Bun.env.PI_PROFILE,
			effective: getAgentDir(),
			profile: getActiveProfile(),
		};
		setAgentDir(directory.path());
		expect(getAgentDir()).toBe(directory.path());
		const probe = OperationalStore.open();
		try {
			expect(probe.dbPath).toBe(path.join(directory.path(), "operational.db"));
		} finally {
			probe.close();
		}
		expect(path.join(getAgentDir(), "operational", "native-tasks")).toBe(
			path.join(directory.path(), "operational", "native-tasks"),
		);
		auth = await AuthStorage.create(path.join(directory.path(), "auth.db"));
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Missing bundled test model");
		auth.setRuntimeApiKey(model.provider, "test-key");
		registry = new ModelRegistry(auth, path.join(directory.path(), "models.yml"));
		settings = Settings.isolated({
			"async.enabled": false,
			"task.batch": false,
			"task.prefetch.enabled": false,
			"compaction.enabled": false,
			"retry.enabled": false,
			"tools.approvalMode": "yolo",
			modelRoles: { task: `${model.provider}/${model.id}`, smol: `${model.provider}/${model.id}` },
		});
		AgentRegistry.resetGlobalForTests();
		AgentLifecycleManager.resetGlobalForTests();
		vi.spyOn(discovery, "discoverAgents").mockResolvedValue({ agents: [workerDefinition], projectAgentsDir: null });
		workerResponses = [];
		workerHandler = undefined;
		onChildCreated = undefined;
		onNativeCreated = undefined;
		vi.spyOn(sdk, "createAgentSession").mockImplementation(async (options = {}) => {
			// Keep the executor, SDK session, built-in tools, yield extraction and
			// cleanup real. Only the provider transport is replaced with a script.
			const created = await createRealSession({
				...options,
				agentDir: directory.path(),
				authStorage: auth,
				modelRegistry: registry,
				model,
				enableMCP: false,
				enableIrc: false,
				enableLsp: false,
				skipPythonPreflight: true,
				disableExtensionDiscovery: true,
				preloadedExtensionPaths: [],
				preloadedCustomToolPaths: [],
				skills: [],
				rules: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
			});
			vi.spyOn(created.session, "dispose");
			if (options.nativeTaskExecution) {
				nativeSessions.push(created.session);
				created.session.agent.streamFn = () => {
					throw new Error("Internal executor must not prompt its model");
				};
				await onNativeCreated?.(created.session);
				return created;
			}
			const scripted = createMockModel(workerHandler ? { handler: workerHandler } : { responses: workerResponses });
			created.session.agent.streamFn = scripted.stream;
			models.push(scripted);
			children.push(created.session);
			await onChildCreated?.(created.session);
			return created;
		});
		tool = await TaskTool.create({
			cwd: directory.path(),
			hasUI: false,
			settings,
			modelRegistry: registry,
			agentOutputManager: new AgentOutputManager(() => null),
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
		} as unknown as ToolSession);
	});

	afterEach(async () => {
		try {
			for (const parent of parents.splice(0)) await parent.dispose();
			for (const child of children.splice(0)) await child.dispose();
			for (const nativeSession of nativeSessions.splice(0)) await nativeSession.dispose();
		} finally {
			try {
				models.splice(0);
				AgentLifecycleManager.resetGlobalForTests();
				AgentRegistry.resetGlobalForTests();
				auth?.close();
			} finally {
				vi.restoreAllMocks();
				try {
					for (const [key, value] of [
						["PI_CODING_AGENT_DIR", originalDirs.agent],
						["OMP_PROFILE", originalDirs.ompProfile],
						["PI_PROFILE", originalDirs.piProfile],
					] as const) {
						if (value === undefined) delete Bun.env[key];
						else Bun.env[key] = value;
					}
					__resetDirsFromEnvForTests();
					expect(getAgentDir()).toBe(originalDirs.effective);
					expect(getActiveProfile()).toBe(originalDirs.profile);
				} finally {
					await directory.remove();
				}
			}
		}
	});

	async function git(repo: string, ...args: string[]): Promise<string> {
		const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		const [stdout, stderr, code] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (code !== 0) throw new Error(`Fixture git failed: ${stderr}`);
		return stdout.trim();
	}

	async function rootSession(
		options: {
			repo?: boolean;
			mode?: "autonomous" | "delegate" | "escalate" | "off" | "savings" | "token-savings";
			async?: boolean;
			merge?: "patch" | "branch";
			batch?: boolean;
			outputSchema?: sdk.CreateAgentSessionOptions["outputSchema"];
		} = {},
	) {
		const cwd = path.join(directory.path(), "workspace");
		await fs.mkdir(cwd, { recursive: true });
		await Bun.write(path.join(cwd, "reference.ts"), 'export const REFERENCE_SENTINEL = "conventions";\n');
		if (options.repo !== false) {
			await git(cwd, "init");
			await git(cwd, "config", "user.email", "test@example.com");
			await git(cwd, "config", "user.name", "Native I/O Test");
			await git(cwd, "add", ".");
			await git(cwd, "commit", "-m", "fixture baseline");
		}
		settings.override("fusion.enabled", true);
		settings.override("fusion.mode", options.mode ?? "token-savings");
		settings.override("async.enabled", options.async ?? false);
		settings.override("task.batch", options.batch ?? false);
		settings.override("task.isolation.mode", "none");
		settings.override("task.isolation.merge", options.merge ?? "patch");
		settings.override("tools.discoveryMode", "off");
		settings.override("read.summarize.enabled", false);
		const created = await createRealSession({
			cwd,
			agentDir: directory.path(),
			model: registry.getAll()[0],
			modelRegistry: registry,
			authStorage: auth,
			settings,
			outputSchema: options.outputSchema,
			sessionManager: SessionManager.inMemory(cwd),
			toolNames: ["read", "write", "task", "bash", "yield", "job"],
			disableExtensionDiscovery: true,
			preloadedCustomToolPaths: [],
			preloadedExtensionPaths: [],
			enableMCP: false,
			enableIrc: false,
			enableLsp: false,
			skipPythonPreflight: true,
			skills: [],
			rules: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
		});
		parents.push(created.session);
		return created.session;
	}

	const generationRequest = {
		agent: "task",
		assignment:
			"Create the module. Acceptance: follow reference naming, exactly 100 source lines, no extra files; report unavailable checks.",
		codeWrite: {
			spec: "Generate settled boilerplate declarations.",
			reference: "reference.ts",
			target: "generated.ts",
		},
		model: "pi/task",
	};
	const generatedSource = `${Array.from({ length: 100 }, (_, i) => `export const GENERATED_SOURCE_SENTINEL_${i} = ${i};`).join("\n")}\n`;

	it("guards local read selectors at 350 lines without exposing the blocked corpus", async () => {
		const root = await rootSession({ repo: false, mode: "autonomous" });
		const file = path.join(root.sessionManager.getCwd(), "bulk.txt");
		await Bun.write(file, Array.from({ length: 351 }, (_, i) => `BULK_SENTINEL_${i + 1}`).join("\r\n"));
		const reader = root.getToolByName("read")!;
		for (const suffix of ["", ":raw", ":1-999999", ":1-351:raw", ":1-", ":1", ":1-175,177-999999"]) {
			await expect(reader.execute("blocked", { path: `${file}${suffix}` })).rejects.toThrow(
				"[Fusion I/O] Bulk read blocked",
			);
		}
		for (const suffix of [":1-350", ":raw:1-350", ":2-", ":2", ":1-175,177-351", ":351+1"]) {
			const result = await reader.execute("bounded", { path: `${file}${suffix}` });
			expect(JSON.stringify(result.content)).toContain("BULK_SENTINEL_");
		}
		await expect(reader.execute("invalid", { path: `${file}:0-3` })).rejects.toThrow("Line selector 0");
		const delimited = await reader.execute("delimited", { path: `reference.ts, ${file}` });
		expect(JSON.stringify(delimited.content)).toContain("[Fusion I/O]");
		expect(JSON.stringify(delimited.content)).not.toContain("BULK_SENTINEL_");
		await Bun.write(
			path.join(root.sessionManager.getCwd(), "exact.txt"),
			`${Array.from({ length: 350 }, (_, i) => `EXACT_${i}`).join("\n")}\n`,
		);
		expect(JSON.stringify((await reader.execute("exact", { path: "exact.txt" })).content)).toContain("EXACT_0");
		expect(JSON.stringify((await reader.execute("exact-bounded", { path: "exact.txt:1-350" })).content)).toContain(
			"EXACT_349",
		);
		const scripted = createMockModel({
			responses: [
				{ content: [{ type: "toolCall", name: "read", arguments: { path: file } }] },
				{ content: ["Use bounded evidence instead."] },
			],
		});
		root.agent.streamFn = scripted.stream;
		await root.agent.prompt("Read the bulk fixture.");
		expect(JSON.stringify(scripted.calls.map(call => call.context.messages))).not.toContain("BULK_SENTINEL_");
		expect(JSON.stringify(root.messages)).toContain("[Fusion I/O]");
	});

	it("routes literal shell display commands even with ordinary interception disabled", async () => {
		const root = await rootSession({ repo: false });
		settings.override("bashInterceptor.enabled", false);
		for (const command of [
			"cat reference.ts",
			'"cat" reference.ts',
			"echo ok && head reference.ts",
			"echo ok | tail reference.ts",
			"echo ok; less reference.ts",
			"more reference.ts",
			"type reference.ts",
			"Get-Content reference.ts",
			"& 'Get-Content' reference.ts",
			"echo ok\n'cat' reference.ts",
		]) {
			expect(checkBashInterception(command, [], [], true).block).toBe(true);
			await expect(root.getToolByName("bash")!.execute("display", { command })).rejects.toThrow("[Fusion I/O]");
		}
		expect(checkBashInterception("echo cat", [], [], true).block).toBe(false);
		expect(checkBashInterception("cat reference.ts", [], [], false).block).toBe(false);
	});

	it("enforces digest capabilities, cites missing evidence, and caps UTF-8 output with a retained artifact", async () => {
		const root = await rootSession({ repo: false, mode: "autonomous" });
		await Bun.write(path.join(root.sessionManager.getCwd(), "bulk.txt"), `${"WORKER_BULK_SENTINEL\n".repeat(351)}`);
		const prose = `[missing.txt:1] Failed to read missing file; no evidence available.\n${"évidence ".repeat(1600)}`;
		workerResponses.push(
			{
				content: [
					{ type: "toolCall", name: "read", arguments: { path: "bulk.txt" } },
					{ type: "toolCall", name: "read", arguments: { path: "missing.txt" } },
					{ type: "toolCall", name: "write", arguments: { path: "forbidden.txt", content: "bad" } },
				],
			},
			{ content: [{ type: "toolCall", name: "yield", arguments: { result: { data: { evidence: prose } } } }] },
		);
		const result = await root.getToolByName("task")!.execute("digest", {
			agent: "task",
			model: "pi/task",
			assignment: "Read the named evidence; cite missing files, never fabricate findings.",
			evidenceDigest: { paths: ["bulk.txt", "missing.txt"], question: "What evidence exists?" },
		});
		const details = result.details as import("../../src/task/types").TaskToolDetails;
		const digest = details.results[0]!;
		const { output, transcriptArtifact } = digest;
		expect(digest.exitCode).toBe(0);
		expect(digest.isError).toBe(false);
		expect(digest.truncated).toBe(true);
		expect(new TextEncoder().encode(output).byteLength).toBeLessThanOrEqual(8000);
		expect(output).not.toContain("\uFFFD");
		expect(output).toContain("Incomplete evidence digest");
		expect(transcriptArtifact).toMatch(/^artifact:\/\/\d+$/);
		const footer = `\n[Incomplete evidence digest: capped at 8,000 UTF-8 bytes. Full output: ${transcriptArtifact}]`;
		expect(output.endsWith(footer)).toBe(true);
		expect(output.split(footer)).toHaveLength(2);
		const artifact = await root
			.getToolByName("read")!
			.execute("digest-artifact", { path: `${transcriptArtifact}:raw` });
		expect(JSON.stringify(artifact.content)).toContain("[missing.txt:1]");
		expect(await Bun.file(digest.outputPath!).text()).toBe(output);
		expect(digest.outputMeta).toEqual({ lineCount: output.split("\n").length, charCount: output.length });
		const artifactId = transcriptArtifact!.slice("artifact://".length);
		const artifactPath = await root.sessionManager.getArtifactManager()!.getPath(artifactId);
		expect(artifactPath).not.toBeNull();
		const fullArtifact = Bun.file(artifactPath!);
		expect(await fullArtifact.exists()).toBe(true);
		const fullOutput = await fullArtifact.text();
		expect(new TextEncoder().encode(fullOutput).byteLength).toBeGreaterThan(8000);
		expect(fullOutput).toContain("évidence ".repeat(1600));
		expect(fullOutput).not.toContain("Incomplete evidence digest");
		expect(output).toContain("[missing.txt:1]");
		expect(JSON.stringify(children[0]!.messages)).toContain("WORKER_BULK_SENTINEL");
		expect(children[0]!.getAllToolNames().sort()).toEqual(["ast_grep", "glob", "grep", "read", "yield"]);
		expect(models[0]!.calls[0]!.context.tools?.map(tool => tool.name).sort()).toEqual([
			"ast_grep",
			"glob",
			"grep",
			"read",
			"yield",
		]);
		const handle = await root
			.getToolByName("read")!
			.execute("digest-handle", { path: `agent://${details.results[0]!.id}:raw` });
		expect(JSON.stringify(handle.content)).not.toContain("WORKER_BULK_SENTINEL");
		expect(await Bun.file(path.join(root.sessionManager.getCwd(), "forbidden.txt")).exists()).toBe(false);
		expect(JSON.stringify(result.content)).not.toContain("WORKER_BULK_SENTINEL");
		expect(projectEvidenceDigest("", "artifact://1")).toEqual({ output: "", truncated: false });
		const exact = "a".repeat(8000);
		expect(projectEvidenceDigest(exact, "artifact://1")).toEqual({ output: exact, truncated: false });
		const over = projectEvidenceDigest(`${exact}a`, "artifact://1");
		expect(over.truncated).toBe(true);
		expect(new TextEncoder().encode(over.output).byteLength).toBeLessThanOrEqual(8000);
		expect(over.output.endsWith("Full output: artifact://1]")).toBe(true);
		expect(() => projectEvidenceDigest(`${exact}a`, "r".repeat(8000))).toThrow(
			"Evidence digest reference exceeds the 8,000-byte output budget.",
		);
	});

	it("validates new-file generation before allocating a child", async () => {
		const root = await rootSession({ repo: false });
		await Bun.write(path.join(root.sessionManager.getCwd(), "existing.ts"), "existing");
		for (const override of [
			{ codeWrite: { ...generationRequest.codeWrite, reference: "missing.ts" } },
			{ codeWrite: { ...generationRequest.codeWrite, target: "existing.ts" } },
			{ codeWrite: { ...generationRequest.codeWrite, target: "../outside.ts" } },
			{ codeWrite: { ...generationRequest.codeWrite, target: "reference.ts" } },
			{ codeWrite: { ...generationRequest.codeWrite, spec: " " } },
			{ evidenceDigest: { paths: ["reference.ts"], question: "What?" } },
			{ fork: true },
			{ isolated: false },
		]) {
			const result = await root
				.getToolByName("task")!
				.execute("invalid-code", { ...generationRequest, ...override });
			expect((result.details as import("../../src/task/types").TaskToolDetails).results).toHaveLength(0);
		}
		const outside = path.join(directory.path(), "outside");
		await fs.mkdir(outside);
		await fs.symlink(outside, path.join(root.sessionManager.getCwd(), "escape"), "junction");
		const escapeResult = await root.getToolByName("task")!.execute("escape", {
			...generationRequest,
			codeWrite: { ...generationRequest.codeWrite, target: "escape/new.ts" },
		});
		expect(JSON.stringify(escapeResult.content)).toContain("escapes the workspace");
		expect(children).toHaveLength(0);
	});

	it.each(["flat-output", "flat-outputSchema", "batch-output", "inherited"])(
		"rejects supplied schema %s before codeWrite allocation in a real repository",
		async form => {
			const outputSchema = { type: "object", properties: { value: { type: "string" } } };
			const root = await rootSession({
				batch: form === "batch-output",
				outputSchema: form === "inherited" ? outputSchema : undefined,
			});
			const request =
				form === "batch-output"
					? {
							agent: "task",
							context: "Use native receipt only.",
							tasks: [{ ...generationRequest, output: outputSchema }],
						}
					: {
							...generationRequest,
							...(form === "inherited"
								? {}
								: { [form === "flat-outputSchema" ? "outputSchema" : "output"]: outputSchema }),
						};
			const isolation = vi.spyOn(worktree, "ensureIsolation");
			const result = await root.getToolByName("task")!.execute("schema-rejection", request);
			expect(JSON.stringify(result.content)).toContain(
				"Task codeWrite rejects output schemas; its native receipt is the only result contract.",
			);
			expect((result.details as import("../../src/task/types").TaskToolDetails).results).toHaveLength(0);
			expect(children).toHaveLength(0);
			expect(isolation).not.toHaveBeenCalled();
			expect(await Bun.file(path.join(root.sessionManager.getCwd(), "generated.ts")).exists()).toBe(false);
		},
	);

	it.each([
		{ merge: "patch" as const, target: "new file.ts" },
		{ merge: "patch" as const, target: "café.ts" },
		{ merge: "branch" as const, target: "new file.ts" },
		{ merge: "branch" as const, target: "café.ts" },
	])("integrates lossless filename $target through $merge", async ({ merge, target }) => {
		const root = await rootSession({ merge });
		let call = 0;
		workerHandler = async () =>
			call++ === 0
				? { content: [{ type: "toolCall", name: "write", arguments: { path: target, content: generatedSource } }] }
				: { content: [{ type: "toolCall", name: "yield", arguments: { result: { data: "complete" } } }] };
		const result = await root
			.getToolByName("task")!
			.execute("filename", { ...generationRequest, codeWrite: { ...generationRequest.codeWrite, target } });
		const settled = (result.details as import("../../src/task/types").TaskToolDetails).results[0]!;
		expect(settled.error).toBeUndefined();
		expect(settled.exitCode).toBe(0);
		const observed = await Bun.file(path.join(root.sessionManager.getCwd(), target)).text();
		expect(observed.replaceAll("\r\n", "\n")).toBe(generatedSource);
		expect(JSON.parse(settled.output)).toEqual({
			kind: "code-write",
			target,
			lines: 100,
			bytes: new TextEncoder().encode(observed).byteLength,
			sha256: new Bun.CryptoHasher("sha256").update(observed).digest("hex"),
			changesApplied: true,
		});
	});

	it.each(["patch", "branch"] as const)(
		"rejects ambiguous extra filename through %s before integrating either file",
		async merge => {
			const root = await rootSession({ merge });
			const target = "new.ts";
			const extra = "new.ts b/new.ts";
			let call = 0;
			workerHandler = async () => {
				if (call++ === 0)
					return {
						content: [{ type: "toolCall", name: "write", arguments: { path: target, content: generatedSource } }],
					};
				// Exercise the post-generation scope boundary directly: native write restrictions alone are insufficient.
				await Bun.write(path.join(children[0]!.sessionManager.getCwd(), extra), "unexpected file");
				return { content: [{ type: "toolCall", name: "yield", arguments: { result: { data: "complete" } } }] };
			};
			const result = await root.getToolByName("task")!.execute("ambiguous-filename", {
				...generationRequest,
				codeWrite: { ...generationRequest.codeWrite, target },
			});
			const settled = (result.details as import("../../src/task/types").TaskToolDetails).results[0]!;
			expect(settled.exitCode).toBe(1);
			expect(settled.isError).toBe(true);
			expect(settled.changesApplied).toBe(false);
			expect(await Bun.file(path.join(root.sessionManager.getCwd(), target)).exists()).toBe(false);
			expect(await Bun.file(path.join(root.sessionManager.getCwd(), extra)).exists()).toBe(false);
			expect(settled.patchPath).toBeDefined();
			expect(await Bun.file(settled.patchPath!).text()).toContain("new.ts b/new.ts");
			const artifactPath = await root.sessionManager
				.getArtifactManager()!
				.getPath(settled.transcriptArtifact!.replace("artifact://", ""));
			expect(await Bun.file(artifactPath!).text()).toContain("codeWrite changed paths other than its target");
		},
	);

	it.each(["patch", "branch"] as const)(
		"integrates codeWrite through %s and projects only an observed receipt",
		async merge => {
			const root = await rootSession({ merge });
			const target = path.join(root.sessionManager.getCwd(), "generated.ts");
			let workerCall = 0;
			workerHandler = async () => {
				const index = workerCall++;
				expect(children[0]!.sessionManager.getCwd()).not.toBe(root.sessionManager.getCwd());
				expect(await Bun.file(target).exists()).toBe(false);
				if (index === 0)
					return { content: [{ type: "toolCall", name: "read", arguments: { path: "reference.ts" } }] };
				if (index === 1)
					return {
						content: [
							{ type: "toolCall", name: "write", arguments: { path: "generated.ts", content: generatedSource } },
						],
					};
				return {
					content: [
						{
							type: "toolCall",
							name: "yield",
							arguments: { result: { data: { raw: generatedSource, reference: "REFERENCE_SENTINEL" } } },
						},
					],
				};
			};
			const provider = createMockModel({
				responses: [
					{ content: [{ type: "toolCall", name: "task", arguments: generationRequest }] },
					{ content: ["Receipt received."] },
				],
			});
			root.agent.streamFn = provider.stream;
			await root.agent.prompt("Generate the settled module through native delegation.");
			const result = root.messages.find(message => message.role === "toolResult" && message.toolName === "task");
			if (result?.role !== "toolResult") throw new Error("Missing native task result");
			const text = result.content
				.filter(part => part.type === "text")
				.map(part => part.text)
				.join("");
			if (text.startsWith("[Fusion I/O]")) {
				const settled = (result.details as import("../../src/task/types").TaskToolDetails).results[0]!;
				const artifactPath = await root.sessionManager
					.getArtifactManager()
					?.getPath(settled.transcriptArtifact!.replace("artifact://", ""));
				if (!artifactPath) throw new Error(`Missing retained failure diagnostic: ${text}`);
				const retained = await Bun.file(artifactPath).text();
				const diagnostic = retained.split("\n").flatMap(line => {
					try {
						const value = JSON.parse(line);
						return value.id === settled.id && "exitCode" in value
							? [value.error ?? value.stderr ?? "No diagnostic recorded"]
							: [];
					} catch {
						return [];
					}
				});
				throw new Error(`Native codeWrite failed (${merge}): ${diagnostic.join("; ").slice(0, 1200)}`);
			}
			const receipt = JSON.parse(text);
			const observedSource = await Bun.file(target).text();
			expect(receipt).toEqual({
				kind: "code-write",
				target: "generated.ts",
				lines: 100,
				bytes: new TextEncoder().encode(observedSource).byteLength,
				sha256: new Bun.CryptoHasher("sha256").update(observedSource).digest("hex"),
				changesApplied: true,
			});
			const details = result.details as import("../../src/task/types").TaskToolDetails;
			expect(await Bun.file(details.results[0]!.outputPath!).text()).toBe(text);
			const handle = await root
				.getToolByName("read")!
				.execute("receipt-handle", { path: `agent://${details.results[0]!.id}:raw` });
			expect(JSON.stringify(handle.content)).not.toContain("GENERATED_SOURCE_SENTINEL");
			expect(JSON.stringify(handle.content)).toContain("code-write");
			expect(observedSource.replaceAll("\r\n", "\n")).toBe(generatedSource);
			expect(children[0]!.getAllToolNames().sort()).toEqual(["read", "write", "yield"]);
			expect(models[0]!.calls[0]!.context.tools?.map(tool => tool.name).sort()).toEqual(["read", "write", "yield"]);
			const parentContext = JSON.stringify({
				messages: root.messages,
				requests: provider.calls.map(call => call.context.messages),
			});
			expect(parentContext).not.toContain("GENERATED_SOURCE_SENTINEL");
			expect(parentContext).not.toContain("REFERENCE_SENTINEL");
		},
	);

	it("projects async codeWrite completion and output handles without worker source", async () => {
		const root = await rootSession({ async: true });
		workerResponses.push(
			{ content: [{ type: "toolCall", name: "read", arguments: { path: "reference.ts" } }] },
			{
				content: [
					{ type: "toolCall", name: "write", arguments: { path: "generated.ts", content: generatedSource } },
				],
			},
			{
				content: [
					{
						type: "toolCall",
						name: "yield",
						arguments: { result: { data: { raw: generatedSource, reference: "REFERENCE_SENTINEL" } } },
					},
				],
			},
		);
		const updates: unknown[] = [];
		const scheduled = await root
			.getToolByName("task")!
			.execute("async-generation", generationRequest, undefined, update => updates.push(update));
		const jobId = (scheduled.details as import("../../src/task/types").TaskToolDetails).async?.jobId;
		expect(jobId).toBeDefined();
		const job = AsyncJobManager.instance()?.getJob(jobId!);
		if (!job) throw new Error("Native async job was not registered");
		await job.promise;
		expect(job.status).toBe("completed");
		const receipt = JSON.parse(job.resultText!);
		expect(receipt).toMatchObject({ kind: "code-write", target: "generated.ts", lines: 100, changesApplied: true });
		expect(
			(await Bun.file(path.join(root.sessionManager.getCwd(), "generated.ts")).text()).replaceAll("\r\n", "\n"),
		).toBe(generatedSource);
		expect(JSON.stringify({ scheduled, updates, completion: job.resultText })).not.toContain(
			"GENERATED_SOURCE_SENTINEL",
		);
		expect(JSON.stringify({ scheduled, updates, completion: job.resultText })).not.toContain("REFERENCE_SENTINEL");
	});

	it.each(["missing", "fenced", "extra", "conflict"])(
		"rejects %s generated output without applying it and retains recovery artifacts",
		async outcome => {
			const root = await rootSession();
			let workerCall = 0;
			workerHandler = async () => {
				const index = workerCall++;
				if (index === 0 && outcome !== "missing")
					return {
						content: [
							{
								type: "toolCall",
								name: "write",
								arguments: {
									path: "generated.ts",
									content: outcome === "fenced" ? `\`\`\`ts\n${generatedSource}\`\`\`\n` : generatedSource,
								},
							},
						],
					};
				if (outcome === "extra")
					await Bun.write(
						path.join(children[0]!.sessionManager.getCwd(), "unexpected.ts"),
						"EXTRA_SOURCE_SENTINEL",
					);
				if (outcome === "conflict")
					await Bun.write(path.join(root.sessionManager.getCwd(), "generated.ts"), "competing parent file");
				return {
					content: [
						{ type: "toolCall", name: "yield", arguments: { result: { data: { raw: generatedSource } } } },
					],
				};
			};
			const updates: unknown[] = [];
			const result = await root
				.getToolByName("task")!
				.execute("invalid-generation", generationRequest, undefined, update => updates.push(update));
			const settled = (result.details as import("../../src/task/types").TaskToolDetails).results[0]!;
			expect(settled.exitCode).not.toBe(0);
			expect(settled.isError).toBe(true);
			expect(settled.transcriptArtifact).toContain("artifact://");
			expect(settled.patchPath).toBeDefined();
			expect(await Bun.file(settled.patchPath!).exists()).toBe(true);
			expect(JSON.stringify({ result, updates })).not.toContain("GENERATED_SOURCE_SENTINEL");
			expect(await Bun.file(path.join(root.sessionManager.getCwd(), "unexpected.ts")).exists()).toBe(false);
			if (outcome === "conflict")
				expect(await Bun.file(path.join(root.sessionManager.getCwd(), "generated.ts")).text()).toBe(
					"competing parent file",
				);
			else expect(await Bun.file(path.join(root.sessionManager.getCwd(), "generated.ts")).exists()).toBe(false);
		},
	);

	it("rejects restricted Cursor execution and codeWrite writes outside its assigned target", async () => {
		const root = await rootSession();
		const denied: unknown[] = [];
		let workerCall = 0;
		workerHandler = async (_context, options) => {
			if (workerCall++ === 0) {
				const bridge = options?.cursorExecHandlers;
				if (!bridge?.write || !bridge.delete || !bridge.shellStream || !bridge.mcp)
					throw new Error("Missing actual SDK Cursor handlers");
				denied.push(await bridge.delete(create(DeleteArgsSchema, { path: "reference.ts" })));
				denied.push(
					await bridge.shellStream(create(ShellArgsSchema, { command: "echo BLOCKED" }), {
						onStdout: () => {
							throw new Error("Blocked stream produced output");
						},
						onStderr: () => {
							throw new Error("Blocked stream produced output");
						},
					}),
				);
				denied.push(
					await bridge.mcp({
						name: "unknown_execution",
						toolName: "unknown_execution",
						providerIdentifier: "test",
						toolCallId: "unknown",
						args: {},
						rawArgs: {},
					}),
				);
				denied.push(await bridge.write(create(WriteArgsSchema, { path: "reference.ts", fileText: "OVERWRITE" })));
				denied.push(await bridge.write(create(WriteArgsSchema, { path: "../escaped.ts", fileText: "ESCAPE" })));
				children[0]!.settings.override("tools.discoveryMode", "all");
				return {
					content: [
						{ type: "toolCall", name: "write", arguments: { path: "generated.ts", content: generatedSource } },
					],
				};
			}
			return { content: [{ type: "toolCall", name: "yield", arguments: { result: { data: "complete" } } }] };
		};
		const result = await root.getToolByName("task")!.execute("restricted-cursor", generationRequest);
		expect((result.details as import("../../src/task/types").TaskToolDetails).results[0]?.exitCode).toBe(0);
		expect(denied).toHaveLength(5);
		for (const value of denied) expect(value).toMatchObject({ isError: true });
		expect(children[0]!.getAllToolNames().sort()).toEqual(["read", "write", "yield"]);
		expect(await Bun.file(path.join(root.sessionManager.getCwd(), "reference.ts")).text()).toContain(
			"REFERENCE_SENTINEL",
		);
		expect(await Bun.file(path.join(root.sessionManager.getCwd(), "../escaped.ts")).exists()).toBe(false);
	});

	it("isolates two autonomous writers separately with default none and integrates after generation", async () => {
		const root = await rootSession({ mode: "autonomous", batch: true });
		settings.override("task.maxConcurrency", 2);
		const sharedContext =
			"SHARED_CONTEXT_REPLAY_SENTINEL: Generate independent modules; integrate each accepted new file.";
		const baseProbe = { agent: "task", assignment: "Reject this validation probe without spawning." };
		settings.override("task.batch", false);
		try {
			for (const [id, extra, field] of [
				["public-context-probe", { context: "SHAPE_REJECTION_SENTINEL" }, "context"],
				["public-tasks-probe", { tasks: [{ assignment: "Never execute this nested item." }] }, "tasks"],
				["public-schema-probe", { schema: { type: "object" } }, "schema"],
			] as const) {
				const rejected = await root.getToolByName("task")!.execute(id, { ...baseProbe, ...extra });
				const text = rejected.content
					.filter(part => part.type === "text")
					.map(part => part.text)
					.join("\n");
				if (field === "schema") expect(text).toContain("The task tool does not accept `schema`");
				else {
					expect(text).toContain("task.batch is disabled");
					expect(text).toContain(`\`${field}\``);
				}
				expect((rejected.details as import("../../src/task/types").TaskToolDetails).results).toHaveLength(0);
			}
			expect(children).toHaveLength(0);
			expect(nativeSessions).toHaveLength(0);
		} finally {
			settings.override("task.batch", true);
		}
		onNativeCreated = async session => {
			for (const [id, extra, field] of [
				["native-tasks-probe", { tasks: [{ assignment: "Never execute this nested item." }] }, "tasks"],
				["native-schema-probe", { schema: { type: "object" } }, "schema"],
			] as const) {
				const rejected = await session.getToolByName("task")!.execute(id, { ...baseProbe, ...extra });
				const text = rejected.content
					.filter(part => part.type === "text")
					.map(part => part.text)
					.join("\n");
				if (field === "schema") expect(text).toContain("The task tool does not accept `schema`");
				else {
					expect(text).toContain("task.batch is disabled");
					expect(text).toContain("`tasks`");
				}
				expect((rejected.details as import("../../src/task/types").TaskToolDetails).results).toHaveLength(0);
			}
		};
		const ready = Promise.withResolvers<void>();
		const generated = Promise.withResolvers<void>();
		let generatedCount = 0;
		onChildCreated = async () => {
			if (children.length === 2) ready.resolve();
			await ready.promise;
		};
		workerHandler = async context => {
			const prompt = JSON.stringify(context.messages);
			expect(context.systemPrompt?.join("\n")).toContain(sharedContext);
			const name = prompt.includes("first.ts") ? "first.ts" : "second.ts";
			if (!context.messages.some(message => message.role === "toolResult" && message.toolName === "write")) {
				expect(await Bun.file(path.join(root.sessionManager.getCwd(), name)).exists()).toBe(false);
				return {
					content: [{ type: "toolCall", name: "write", arguments: { path: name, content: generatedSource } }],
				};
			}
			if (context.messages.some(message => message.role === "toolResult" && message.toolName === "yield")) {
				return { content: [{ type: "text", text: "done" }] };
			}
			if (++generatedCount === 2) generated.resolve();
			await generated.promise;
			return { content: [{ type: "toolCall", name: "yield", arguments: { result: { data: "complete" } } }] };
		};
		const result = await root.getToolByName("task")!.execute("two-writers", {
			agent: "task",
			context: sharedContext,
			tasks: ["first.ts", "second.ts"].map(target => ({
				model: "pi/task",
				assignment: generationRequest.assignment,
				codeWrite: { ...generationRequest.codeWrite, target },
			})),
		});
		const settled = (result.details as import("../../src/task/types").TaskToolDetails).results;
		if (settled.length === 0) throw new Error(JSON.stringify(result.content));
		expect(settled).toHaveLength(2);
		expect(settled.every(item => item.exitCode === 0 && item.changesApplied)).toBe(true);
		expect(children).toHaveLength(2);
		expect(nativeSessions).toHaveLength(2);
		expect(generatedCount).toBe(2);
		expect(new Set(children.map(child => child.sessionManager.getCwd())).size).toBe(2);
		for (const child of children) expect(child.sessionManager.getCwd()).not.toBe(root.sessionManager.getCwd());
		for (const file of ["first.ts", "second.ts"])
			expect((await Bun.file(path.join(root.sessionManager.getCwd(), file)).text()).replaceAll("\r\n", "\n")).toBe(
				generatedSource,
			);
		const durableJobIds = settled.map(item => item.durableJobId);
		for (const id of durableJobIds) expect(id).toBeDefined();
		expect(new Set(durableJobIds).size).toBe(2);
		const store = OperationalStore.open();
		try {
			for (const id of durableJobIds) {
				const job = store.getJob(id!);
				expect(job).not.toBeNull();
				expect(job!.status).toBe("completed");
				const payload = parseNativeTaskJobPayload(job!.payload);
				expect(payload.params.context).toBe(sharedContext);
				expect(Object.hasOwn(payload.params, "tasks")).toBe(false);
			}
		} finally {
			store.close();
		}
	}, 30_000);

	it("fails mandatory isolation setup before constructing any child", async () => {
		const root = await rootSession();
		vi.spyOn(worktree, "ensureIsolation").mockRejectedValueOnce(new Error("Fixture isolation unavailable"));
		const result = await root.getToolByName("task")!.execute("isolation-failure", generationRequest);
		expect((result.details as import("../../src/task/types").TaskToolDetails).results[0]?.exitCode).toBe(1);
		expect(children).toHaveLength(0);
		expect(await Bun.file(path.join(root.sessionManager.getCwd(), "generated.ts")).exists()).toBe(false);
	});

	async function dispatch(assignment: string, evidenceDigest?: { paths: string[]; question: string }) {
		const parentModel = createMockModel({
			responses: [
				{
					content: [
						{
							type: "toolCall",
							id: "delegate",
							name: "task",
							arguments: {
								agent: "task",
								id: "ShuntingWorker",
								assignment,
								model: "pi/task",
								...(evidenceDigest ? { evidenceDigest } : {}),
							},
						},
					],
				},
				{ content: ["Delegated work received."] },
			],
		});
		const parent = new Agent({
			getApiKey: () => "test-key",
			initialState: {
				model: parentModel.model,
				systemPrompt: ["Delegate the assignment."],
				tools: [
					{
						name: tool.name,
						label: tool.label,
						description: tool.description,
						parameters: tool.parameters,
						execute: tool.execute.bind(tool),
					},
				],
				messages: [],
			},
			streamFn: parentModel.stream,
		});
		await parent.prompt("Execute the delegated assignment.");
		const result = parent.state.messages.find(
			message => message.role === "toolResult" && message.toolCallId === "delegate",
		);
		expect(result).toBeDefined();
		if (result?.role !== "toolResult") throw new Error("Missing task result");
		if (result.isError) throw new Error(JSON.stringify(result));
		expect(result.isError).not.toBe(true);
		return { parent, result, parentModel };
	}

	it("deserializes the actual evidence request and rejects missing or malformed fields before allocation", async () => {
		const schema = getTaskSchema({ isolationEnabled: false, batchEnabled: false });
		const base = { agent: "task", assignment: "Inspect the fixture.", model: "pi/task" };
		const valid = schema(
			JSON.parse(
				JSON.stringify({ ...base, evidenceDigest: { paths: ["fixture.txt"], question: "What is present?" } }),
			),
		);
		expect(valid instanceof type.errors).toBe(false);
		for (const evidenceDigest of [
			{ paths: ["fixture.txt"] },
			{ question: "What?" },
			{ paths: [], question: "What?" },
			{ paths: [42], question: "What?" },
			{ paths: ["fixture.txt"], question: "" },
			{ paths: ["fixture.txt"], question: 42 },
		]) {
			const invalid = schema({ ...base, evidenceDigest });
			expect(invalid instanceof type.errors).toBe(true);
			if (!(invalid instanceof type.errors)) throw new Error("Expected explicit schema errors");
			expect(invalid.summary).toContain("evidenceDigest");
		}
		for (const evidenceDigest of [
			{ paths: [], question: "What?" },
			{ paths: [""], question: "What?" },
			{ paths: [" "], question: "What?" },
			{ paths: ["fixture.txt"], question: "" },
			{ paths: ["fixture.txt"], question: " " },
		]) {
			const rejected = await tool.execute("invalid-digest", { ...base, evidenceDigest });
			expect(JSON.stringify(rejected.content)).toContain(
				"evidenceDigest requires non-empty paths and an exact question",
			);
		}
		const incompatible = await tool.execute("fork-digest", {
			...base,
			fork: true,
			evidenceDigest: { paths: ["fixture.txt"], question: "What?" },
		});
		expect(JSON.stringify(incompatible.content)).toContain("evidenceDigest requires a fresh spawn");
		expect(children).toHaveLength(0);
	});

	it("routes pi/task and keeps an actual 450-line worker read out of parent messages and provider context", async () => {
		const fixture = path.join(directory.path(), "fixture.txt");
		const lines = Array.from({ length: 450 }, (_, i) => `FIXTURE_TOKEN_LINE_${i + 1}`);
		await Bun.write(fixture, `${lines.join("\n")}\n`);
		const digest = { facts: ["The fixture contains 450 synthetic lines."], citations: [`${fixture}:50-400`] };
		workerResponses.push(
			{ content: [{ type: "toolCall", name: "read", arguments: { path: `${fixture}:1-450` } }] },
			{ content: [{ type: "toolCall", name: "yield", arguments: { result: { data: digest } } }] },
		);
		const { parent, parentModel, result } = await dispatch("Inspect the fixture and return a concise cited digest.", {
			paths: [fixture],
			question: "How many synthetic lines are present?",
		});
		expect(children).toHaveLength(1);
		expect(sdk.createAgentSession).toHaveBeenCalledWith(
			expect.objectContaining({
				model: expect.objectContaining({ provider: "anthropic", id: "claude-sonnet-4-5" }),
			}),
		);
		expect(children[0]!.model?.id).toBe("claude-sonnet-4-5");
		const workerContext = JSON.stringify(children[0]!.state.messages);
		for (const index of [50, 200, 400, 450]) expect(workerContext).toContain(`FIXTURE_TOKEN_LINE_${index}`);
		expect(
			children[0]!.state.messages.some(
				message => message.role === "toolResult" && message.toolName === "read" && !message.isError,
			),
		).toBe(true);
		expect(JSON.stringify(result.content)).toContain(digest.facts[0]);
		const parentContext = JSON.stringify({
			turns: parent.state.messages,
			requests: parentModel.calls.map(call => call.context.messages),
		});
		for (const line of lines.slice(49, 400)) expect(parentContext).not.toContain(line);
		expect(parentContext).not.toContain("FIXTURE_TOKEN_LINE_");
		expect(models[0]!.calls.length).toBeGreaterThanOrEqual(2);
	}, 30_000);

	it("writes a real 100-line generated file and returns the compliant worker receipt without source", async () => {
		const target = path.join(directory.path(), "generated.ts");
		const body = `${Array.from({ length: 100 }, (_, i) => `export function generated_${i}() { return ${i}; }`).join("\n")}\n`;
		const receipt = { files_written: [target], line_count: 100, checks_run: [], unresolved_issues: [] };
		workerResponses.push(
			{ content: [{ type: "toolCall", name: "write", arguments: { path: target, content: body } }] },
			{ content: [{ type: "toolCall", name: "yield", arguments: { result: { data: receipt } } }] },
		);
		const { parent, result } = await dispatch("Write the generated module and yield only its execution receipt.");
		expect(await Bun.file(target).text()).toBe(body);
		const returned = JSON.stringify(result.content);
		for (const key of Object.keys(receipt)) expect(returned).toContain(key);
		expect(returned).not.toContain("```");
		expect(JSON.stringify(parent.state.messages)).not.toContain("export function generated_");
	}, 30_000);

	it("parks and disposes a completed task automatically after its configured idle TTL", async () => {
		settings.set("task.agentIdleTtlMs", 50);
		workerResponses.push({
			content: [{ type: "toolCall", name: "yield", arguments: { result: { data: { facts: ["Completed."] } } } }],
		});
		await dispatch("Return the completion fact.");
		const child = children[0]!;
		const registry = AgentRegistry.global();
		const lifecycle = AgentLifecycleManager.global();
		expect(lifecycle.has("ShuntingWorker")).toBe(true);
		const deadline = Date.now() + 5000;
		while (registry.get("ShuntingWorker")?.status !== "parked" && Date.now() < deadline) await Bun.sleep(10);
		expect(child.dispose).toHaveBeenCalledTimes(1);
		expect(child.isStreaming).toBe(false);
		expect(registry.get("ShuntingWorker")?.status).toBe("parked");
		expect(registry.get("ShuntingWorker")?.session).toBeNull();
		expect(lifecycle.isParking("ShuntingWorker")).toBe(false);
	}, 30_000);

	it("disposes a completed in-process helper on explicit keep-alive opt-out", async () => {
		workerResponses.push({
			content: [{ type: "toolCall", name: "yield", arguments: { result: { data: { status: "complete" } } } }],
		});
		await dispatch("Return a completion receipt.");
		const child = children[0]!;
		expect(child.isStreaming).toBe(false);
		expect(AgentRegistry.global().get("ShuntingWorker")?.status).toBe("idle");
		expect(child.dispose).not.toHaveBeenCalled();
		const dispose = vi.spyOn(child, "dispose");
		await finalizeSubagentLifecycle({
			id: "ShuntingWorker",
			session: child,
			aborted: false,
			keepAlive: false,
			isolated: false,
			agentIdleTtlMs: 0,
			reviveSession: null,
		});
		expect(dispose).toHaveBeenCalledTimes(1);
		expect(AgentRegistry.global().get("ShuntingWorker")).toBeUndefined();
	}, 30_000);
});
