/**
 * Offline comparison for PR #11885: source retrieval work, rewind durability,
 * and loop-guard cost. Run the same script against each revision with its own
 * module resolution. Timings exclude process startup and fixture setup; no
 * provider requests, generated-token throughput, or API-cost estimates are used.
 *
 * bun packages/coding-agent/bench/harness-fidelity.bench.ts [expected-source-root]
 */
import { strict as assert } from "node:assert";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type } from "@oh-my-pi/omptype";
import { Agent, type AgentTool, type AgentToolContext } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage } from "@oh-my-pi/pi-ai";
import { createMockModel } from "@oh-my-pi/pi-ai/providers/mock";
import { ToolCallLoopGuard, type ToolCallLoopTurn } from "@oh-my-pi/pi-ai/utils/tool-call-loop-guard";
import { ModelRegistry } from "@oh-my-pi/pi-coding-agent/config/model-registry";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { registerArtifactsDir } from "@oh-my-pi/pi-coding-agent/internal-urls/registry-helpers";
import { AgentSession } from "@oh-my-pi/pi-coding-agent/session/agent-session";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent/session/auth-storage";
import { convertToLlm } from "@oh-my-pi/pi-coding-agent/session/messages";
import { SessionManager } from "@oh-my-pi/pi-coding-agent/session/session-manager";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { wrapToolWithMetaNotice } from "@oh-my-pi/pi-coding-agent/tools/output-meta";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import {
	getLatestTodoPhasesFromEntries,
	type TodoPhase,
	USER_TODO_EDIT_CUSTOM_TYPE,
} from "@oh-my-pi/pi-coding-agent/tools/todo";

const WARMUP = 5;
const SAMPLES = 25;
const LOOP_REPETITIONS = 500;
const root = path.resolve(Bun.argv[2] ?? path.join(import.meta.dir, "../../.."));
for (const specifier of [
	"@oh-my-pi/pi-coding-agent/tools/read",
	"@oh-my-pi/pi-coding-agent/session/agent-session",
	"@oh-my-pi/pi-ai/utils/tool-call-loop-guard",
]) {
	const resolved = Bun.resolveSync(specifier, import.meta.dir);
	const relative = path.relative(root, resolved);
	assert(!path.isAbsolute(relative) && !relative.startsWith(".."), `Wrong revision imported: ${resolved}`);
}
const scratchParent = path.join(root, "tmp");
await fs.mkdir(scratchParent, { recursive: true });
const scratch = await fs.mkdtemp(path.join(scratchParent, "harness-fidelity-"));

function distribution(samples: number[]) {
	const sorted = [...samples].sort((a, b) => a - b);
	return {
		medianMs: sorted[Math.floor(sorted.length / 2)]!,
		p25Ms: sorted[Math.floor(sorted.length / 4)]!,
		p75Ms: sorted[Math.floor((sorted.length * 3) / 4)]!,
	};
}

async function readScenario(editorBuffer: boolean, spillKB: number) {
	const cwd = path.join(scratch, `${editorBuffer ? "acp" : "disk"}-${spillKB}`);
	await fs.mkdir(cwd, { recursive: true });
	const source = Array.from({ length: 56 }, (_, index) => `const declaration_${index} = "${"x".repeat(64)}";`).join(
		"\n",
	);
	await Bun.write(path.join(cwd, "fixture.ts"), editorBuffer ? "// stale disk buffer\n" : source);
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const artifactDir = manager.getArtifactsDir();
	assert(artifactDir);
	const unregister = registerArtifactsDir(artifactDir);
	const settings = Settings.isolated({
		"tools.artifactSpillThreshold": spillKB,
		"tools.artifactTailLines": spillKB === 1 ? 5 : 500,
	});
	const toolSession: ToolSession = {
		cwd,
		hasUI: false,
		settings,
		getSessionFile: () => manager.getSessionFile() ?? null,
		getSessionSpawns: () => "*",
		getArtifactsDir: () => artifactDir,
		allocateOutputArtifact: tool => manager.allocateArtifactPath(tool),
		...(editorBuffer
			? { getClientBridge: () => ({ capabilities: { readTextFile: true }, readTextFile: async () => source }) }
			: {}),
	};
	const wrapped = wrapToolWithMetaNotice(new ReadTool(toolSession));
	const context = { settings, sessionManager: manager } as unknown as AgentToolContext;
	const samples: number[] = [];
	let observed:
		| {
				firstVisibleDeclarations: number;
				callsToRetrieveSelection: number;
				artifactWrites: number;
				returnedBytes: number;
		  }
		| undefined;
	try {
		for (let iteration = 0; iteration < WARMUP + SAMPLES; iteration++) {
			const started = performance.now();
			const first = await wrapped.execute(
				`read-${iteration}`,
				{ path: "fixture.ts:1-56" },
				undefined,
				undefined,
				context,
			);
			const firstText = first.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n");
			const firstVisibleDeclarations = new Set(
				[...firstText.matchAll(/const declaration_(\d+) =/g)].map(match => match[1]),
			).size;
			const outputs = [firstText];
			const artifactId = first.details?.meta?.truncation?.artifactId;
			if (firstVisibleDeclarations !== 56) {
				assert(artifactId !== undefined, "Missing source selection has no recovery artifact");
				const recovered = await wrapped.execute(
					`recover-${iteration}`,
					{ path: `artifact://${artifactId}:raw:1-200` },
					undefined,
					undefined,
					context,
				);
				outputs.push(recovered.content.flatMap(block => (block.type === "text" ? [block.text] : [])).join("\n"));
			}
			const elapsed = performance.now() - started;
			const visible = new Set([...outputs.join("\n").matchAll(/const declaration_(\d+) =/g)].map(match => match[1]));
			assert.equal(visible.size, 56, "Both revisions must complete the same source-retrieval workload");
			if (iteration >= WARMUP) samples.push(elapsed);
			observed = {
				firstVisibleDeclarations,
				callsToRetrieveSelection: outputs.length,
				artifactWrites: artifactId === undefined ? 0 : 1,
				returnedBytes: outputs.reduce((sum, output) => sum + Buffer.byteLength(output), 0),
			};
		}
		return { editorBuffer, spillKB, ...observed, ...distribution(samples), samplesMs: samples };
	} finally {
		unregister();
		await manager.close();
	}
}

async function rewindScenario() {
	const cwd = path.join(scratch, "rewind");
	await fs.mkdir(cwd, { recursive: true });
	const auth = await AuthStorage.create(":memory:");
	auth.setRuntimeApiKey("mock", "test-key");
	const original: TodoPhase[] = [{ name: "Work", tasks: [{ content: "Existing obligation", status: "in_progress" }] }];
	const updated: TodoPhase[] = [
		{
			name: "Work",
			tasks: [
				{ content: "Existing obligation", status: "completed" },
				{ content: "New obligation", status: "blocked", blocker: "External dependency" },
			],
		},
	];
	const checkpointSchema = type({ goal: "string" });
	const checkpoint: AgentTool<typeof checkpointSchema> = {
		name: "checkpoint",
		label: "Checkpoint",
		description: "Fixture checkpoint",
		parameters: checkpointSchema,
		execute: async () => ({
			content: [{ type: "text", text: "Checkpoint" }],
			details: { startedAt: "2026-01-01T00:00:00.000Z" },
		}),
	};
	const rewindSchema = type({ report: "string" });
	const rewind: AgentTool<typeof rewindSchema> = {
		name: "rewind",
		label: "Rewind",
		description: "Fixture rewind",
		parameters: rewindSchema,
		execute: async (_id, args) => ({
			content: [{ type: "text", text: "Rewind" }],
			details: { report: args.report, rewound: true },
		}),
	};
	const todo: AgentTool = {
		name: "todo",
		label: "Todo",
		description: "Update fixture tasks",
		parameters: type({}),
		execute: async () => {
			session.setTodoPhases(updated);
			return { content: [{ type: "text", text: "Updated" }], details: { op: "append", phases: updated } };
		},
	};
	const mock = createMockModel({
		responses: [
			{
				content: [{ type: "toolCall", id: "checkpoint", name: "checkpoint", arguments: { goal: "inspect" } }],
				stopReason: "toolUse",
			},
			{ content: [{ type: "toolCall", id: "todo", name: "todo", arguments: {} }], stopReason: "toolUse" },
			{
				content: [{ type: "toolCall", id: "rewind", name: "rewind", arguments: { report: "Inspection complete" } }],
				stopReason: "toolUse",
			},
			{ content: ["Done"], stopReason: "stop" },
		],
	});
	const tools: AgentTool[] = [checkpoint as AgentTool, rewind as AgentTool, todo];
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const manager = SessionManager.create(cwd, path.join(cwd, "sessions"));
	const session = new AgentSession({
		agent: new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mock, systemPrompt: ["Offline fixture"], tools, messages: [] },
			convertToLlm,
			streamFn: mock.stream,
		}),
		sessionManager: manager,
		settings,
		modelRegistry: new ModelRegistry(auth, path.join(cwd, "models.yml")),
		toolRegistry: new Map(tools.map(tool => [tool.name, tool])),
	});
	try {
		session.setTodoPhases(original);
		manager.appendCustomEntry(USER_TODO_EDIT_CUSTOM_TYPE, { phases: original });
		await session.prompt("Inspect and reconcile the fixture");
		await session.waitForIdle();
		await manager.flush();
		const reopened = await SessionManager.open(manager.getSessionFile()!);
		try {
			const persisted = getLatestTodoPhasesFromEntries(reopened.getBranch());
			return {
				expectedTasks: 2,
				liveTasks: session.getTodoPhases().flatMap(phase => phase.tasks).length,
				persistedTasks: persisted.flatMap(phase => phase.tasks).length,
				exactStatePreserved: JSON.stringify(persisted) === JSON.stringify(updated),
				modelCalls: mock.calls.length,
			};
		} finally {
			await reopened.close();
		}
	} finally {
		await session.dispose();
		auth.close();
	}
}

const zeroUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
} satisfies AssistantMessage["usage"];
function loopScenario(kind: "unchanged-cycle" | "fresh-results") {
	const turns: ToolCallLoopTurn[] = Array.from({ length: 40 }, (_, index) => {
		const name = kind === "unchanged-cycle" && index % 2 === 1 ? "grep" : "read";
		return {
			message: {
				role: "assistant",
				content: [{ type: "toolCall", id: `call-${index}`, name, arguments: { path: "fixture.ts" } }],
				api: "mock",
				provider: "mock",
				model: "benchmark",
				usage: zeroUsage,
				stopReason: "toolUse",
				timestamp: index,
			},
			toolResults: [
				{
					role: "toolResult",
					toolCallId: `call-${index}`,
					toolName: name,
					content: [{ type: "text", text: kind === "fresh-results" ? `New result ${index}` : "Unchanged result" }],
					isError: false,
					timestamp: index,
				},
			],
		};
	});
	const samples: number[] = [];
	let detections = 0;
	let firstDetection: number | null = null;
	for (let iteration = 0; iteration < WARMUP + SAMPLES; iteration++) {
		const started = performance.now();
		for (let repeat = 0; repeat < LOOP_REPETITIONS; repeat++) {
			const guard = new ToolCallLoopGuard({ threshold: 5, exemptTools: [] });
			let hits = 0;
			let first: number | null = null;
			for (let index = 0; index < turns.length; index++) {
				if (guard.recordTurn(turns[index]!)) {
					hits++;
					first ??= index + 1;
				}
			}
			detections = hits;
			firstDetection = first;
		}
		const elapsedPerTurn = (performance.now() - started) / (LOOP_REPETITIONS * turns.length);
		if (iteration >= WARMUP) samples.push(elapsedPerTurn);
	}
	return { kind, turns: turns.length, detections, firstDetection, ...distribution(samples), samplesMs: samples };
}

try {
	const reads = [];
	for (const editorBuffer of [false, true])
		for (const spillKB of [1, 50]) reads.push(await readScenario(editorBuffer, spillKB));
	const rewind = await rewindScenario();
	const loops = [loopScenario("unchanged-cycle"), loopScenario("fresh-results")];
	console.log(
		JSON.stringify(
			{
				schemaVersion: 1,
				environment: { bun: Bun.version, platform: process.platform, arch: process.arch, cpu: os.cpus()[0]?.model },
				verifiedLocalImports: true,
				sampling: { warmup: WARMUP, samples: SAMPLES, loopRepetitions: LOOP_REPETITIONS },
				reads,
				rewind,
				loops,
			},
			null,
			2,
		),
	);
} finally {
	await fs.rm(scratch, { recursive: true, force: true });
}
