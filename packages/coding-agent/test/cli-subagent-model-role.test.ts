import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TempDir } from "@oh-my-pi/pi-utils";
import { endpoint, sse, textEvents, toolEvents } from "../../ai/test/fixtures/openai-responses-server";

const cliEntry = path.resolve(import.meta.dir, "../src/cli.ts");
const testTimeout = 90_000;

const PROVIDER = "loopback";
const PARENT_MODEL = "parent-model";
const SMOL_PRIMARY = "smol-primary";
const SMOL_FALLBACK = "smol-fallback";
const SLOW_PRIMARY = "slow-primary";
/** Only the parent's own user prompt carries this; subagents never see it. */
const PARENT_MARKER = "PARENT_PROMPT_MARKER";
const SMOL_ASSIGNMENT = "ASSIGNMENT_FOR_SMOL_WORKER";
const SLOW_ASSIGNMENT = "ASSIGNMENT_FOR_SLOW_WORKER";
const SMOL_RESULT = "SMOL_ROLE_RESULT_7319";
const SLOW_RESULT = "SLOW_ROLE_RESULT_4402";
const PARENT_FINAL = "PARENT_FINAL_ANSWER_5150";

function loopbackModel(id: string) {
	return {
		id,
		name: id,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 131072,
		maxTokens: 1024,
	};
}

function inputText(body: Record<string, unknown>): string {
	return JSON.stringify(body.input ?? null);
}

function hasToolOutput(body: Record<string, unknown>): boolean {
	return (
		Array.isArray(body.input) &&
		body.input.some(
			item => typeof item === "object" && item !== null && "type" in item && item.type === "function_call_output",
		)
	);
}

/** Agent turns carry tools; stock side requests (spawn labels) carry none. */
function hasTools(body: Record<string, unknown>): boolean {
	return Array.isArray(body.tools) && body.tools.length > 0;
}

/** The parent's one `task` call: the bundled `task` agent twice, each under a different bare role. */
function taskCallEvents() {
	return toolEvents(
		"task",
		JSON.stringify({
			i: "Delegating two role workers",
			context: "Each worker replies with one line and nothing else.",
			tasks: [
				{
					name: "SmolWorker",
					agent: "task",
					task: `${SMOL_ASSIGNMENT}: reply with the routine result.`,
					solutionSpace: "one fix: reply with the routine result",
					modelRole: "smol",
				},
				{
					name: "SlowWorker",
					agent: "task",
					task: `${SLOW_ASSIGNMENT}: reply with the complex result.`,
					solutionSpace: "one fix: reply with the complex result",
					modelRole: "slow",
				},
			],
		}),
		"resp_parent_task",
		"call_task_roles",
	);
}

describe("real CLI subagent modelRole", () => {
	test(
		"routes the bundled task agent to smol and slow roles, recovers smol through its role fallback, and keeps the parent unchanged",
		async () => {
			const fixture = endpoint(undefined, {
				httpResponse: body => {
					const model = String(body.model);
					const input = inputText(body);
					const n = fixture.httpRequests.length;
					if (input.includes(PARENT_MARKER)) {
						return hasToolOutput(body)
							? sse(textEvents(PARENT_FINAL, `resp_parent_final_${n}`))
							: sse(taskCallEvents());
					}
					// Stock tool-less side requests (the spawn label on the smol role) always succeed, so
					// they never walk a fallback chain and never count as worker turns.
					if (!hasTools(body)) return sse(textEvents("Role worker", `resp_side_${n}`));
					// Retry-eligible primary failure: only the explicit smol fallback can serve this worker.
					if (model === SMOL_PRIMARY) {
						return Response.json(
							{ error: { message: "loopback smol primary overloaded", type: "server_error" } },
							{ status: 503 },
						);
					}
					if (model === SMOL_FALLBACK) return sse(textEvents(SMOL_RESULT, `resp_smol_fallback_${n}`));
					if (model === SLOW_PRIMARY) return sse(textEvents(SLOW_RESULT, `resp_slow_${n}`));
					// A child on any other model (e.g. the parent's) never produces a role result.
					return sse(textEvents(`UNEXPECTED_CHILD_ON_${model}`, `resp_unexpected_${n}`));
				},
			});
			using tempDir = TempDir.createSync("@omp-subagent-model-role-");
			const home = tempDir.join("home");
			const project = tempDir.join("project");
			const agentDir = tempDir.join("agent");
			const tmp = tempDir.join("tmp");
			const xdg = tempDir.join("xdg");
			try {
				await Promise.all([home, project, agentDir, tmp, xdg].map(dir => fs.mkdir(dir, { recursive: true })));
				await Bun.write(
					path.join(agentDir, "models.yml"),
					JSON.stringify({
						providers: {
							[PROVIDER]: {
								baseUrl: `${fixture.server.url.origin}/v1`,
								api: "openai-responses",
								auth: "none",
								models: [PARENT_MODEL, SMOL_PRIMARY, SMOL_FALLBACK, SLOW_PRIMARY].map(loopbackModel),
							},
						},
					}),
				);
				await Bun.write(
					path.join(agentDir, "config.yml"),
					JSON.stringify({
						modelRoles: {
							default: `${PROVIDER}/${PARENT_MODEL}`,
							smol: `${PROVIDER}/${SMOL_PRIMARY}`,
							slow: `${PROVIDER}/${SLOW_PRIMARY}`,
						},
						defaultThinkingLevel: "off",
						retry: {
							enabled: true,
							maxRetries: 1,
							baseDelayMs: 1,
							maxDelayMs: 1000,
							modelFallback: true,
							fallbackChains: { smol: [`${PROVIDER}/${SMOL_FALLBACK}`] },
						},
						task: { batch: true },
						async: { enabled: false },
						providers: { openaiResponsesWebsockets: false, cacheWarming: "off" },
						compaction: { enabled: false },
					}),
				);
				const env: Record<string, string> = {
					PATH: process.env.PATH ?? "/usr/bin:/bin",
					HOME: home,
					USERPROFILE: home,
					PI_CODING_AGENT_DIR: agentDir,
					XDG_CONFIG_HOME: path.join(xdg, "config"),
					XDG_CACHE_HOME: path.join(xdg, "cache"),
					XDG_DATA_HOME: path.join(xdg, "data"),
					XDG_STATE_HOME: path.join(xdg, "state"),
					TMPDIR: tmp,
					TMP: tmp,
					TEMP: tmp,
					SHELL: "/bin/sh",
					NO_COLOR: "1",
					TERM: "dumb",
					...(process.env.PI_NATIVES_DIR ? { PI_NATIVES_DIR: process.env.PI_NATIVES_DIR } : {}),
				};
				const proc = Bun.spawn(
					[
						process.execPath,
						cliEntry,
						"--no-title",
						"--no-lsp",
						"--no-extensions",
						"--no-context-files",
						"-p",
						`${PARENT_MARKER}: delegate both workers, then report.`,
					],
					{ cwd: project, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" },
				);
				let stdout: string;
				let stderr: string;
				let exitCode: number;
				try {
					[stdout, stderr, exitCode] = await Promise.all([
						new Response(proc.stdout).text(),
						new Response(proc.stderr).text(),
						proc.exited,
					]);
				} finally {
					proc.kill();
					await proc.exited;
				}

				const requests = fixture.httpRequests;
				const diagnostics = JSON.stringify(
					{
						stdout,
						stderr,
						exitCode,
						requests: requests.map(body => ({ model: body.model, tools: hasTools(body) })),
					},
					null,
					2,
				);
				const parent = requests.filter(body => inputText(body).includes(PARENT_MARKER));
				// Subagent agent turns only; tool-less spawn-label side requests are stock behavior.
				const children = requests.filter(body => hasTools(body) && !inputText(body).includes(PARENT_MARKER));
				const byModel = (model: string) => children.filter(body => body.model === model);

				// The parent ran entirely on its own default-role model: one task call, one continuation.
				expect(
					parent.map(body => body.model),
					diagnostics,
				).toEqual([PARENT_MODEL, PARENT_MODEL]);
				expect(hasToolOutput(parent[0]!)).toBe(false);
				expect(hasToolOutput(parent[1]!)).toBe(true);

				// Children never touched the parent's model; each role reached its own primary.
				expect(byModel(PARENT_MODEL), diagnostics).toHaveLength(0);
				expect(new Set(children.map(body => body.model)), diagnostics).toEqual(
					new Set([SMOL_PRIMARY, SMOL_FALLBACK, SLOW_PRIMARY]),
				);

				// smol: its primary failed retry-eligibly, then the explicit smol fallback served the worker.
				const smolPrimary = byModel(SMOL_PRIMARY);
				expect(smolPrimary.length, diagnostics).toBeGreaterThanOrEqual(1);
				for (const body of smolPrimary) expect(inputText(body)).toContain(SMOL_ASSIGNMENT);
				const smolFallback = byModel(SMOL_FALLBACK);
				expect(smolFallback, diagnostics).toHaveLength(1);
				expect(inputText(smolFallback[0]!)).toContain(SMOL_ASSIGNMENT);
				expect(inputText(smolFallback[0]!)).not.toContain(SLOW_ASSIGNMENT);

				// slow: its primary served the worker on the first try.
				const slowPrimary = byModel(SLOW_PRIMARY);
				expect(slowPrimary, diagnostics).toHaveLength(1);
				expect(inputText(slowPrimary[0]!)).toContain(SLOW_ASSIGNMENT);
				expect(inputText(slowPrimary[0]!)).not.toContain(SMOL_ASSIGNMENT);

				// The parent received both workers' outputs as its task result and continued to a normal finish.
				const continuation = inputText(parent[1]!);
				expect(continuation).toContain(SMOL_RESULT);
				expect(continuation).toContain(SLOW_RESULT);
				expect(continuation).not.toContain("UNEXPECTED_CHILD_ON_");
				expect(stdout.trim(), diagnostics).toBe(PARENT_FINAL);
				expect(exitCode, diagnostics).toBe(0);
			} finally {
				await fixture.server.stop(true);
			}
		},
		testTimeout,
	);
});
