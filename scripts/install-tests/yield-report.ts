import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const cli = process.argv.slice(2).map(arg => (arg.includes("/") ? path.resolve(arg) : arg));
assert(cli.length > 0, "Usage: bun scripts/install-tests/yield-report.ts <cli> [cli entrypoint]");
const work = await fs.mkdtemp(path.join(os.tmpdir(), "omp-yield-report-"));
const cwd = path.join(work, "project");
const agentDir = path.join(work, "agent");
const extensionPath = path.join(work, "probe.mjs");
const resultPath = path.join(work, "result.json");
const report = "# Review report\nNo confirmed defects.\nEvidence: the fixture reached its final report.";
const requests: unknown[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const body = (await request.json()) as {
			model: string;
			tools?: { function: { name: string } }[];
		};
		const canYield = body.tools?.some(tool => tool.function.name === "yield");
		if (canYield) requests.push(body);
		const submit = canYield && requests.length > 1;
		const delta = submit
			? {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: `yield-report-${requests.length}`,
							type: "function",
							function: {
								name: "yield",
								arguments: JSON.stringify(
									requests.length === 2
										? { type: "result" }
										: { type: "result", error: "The omitted-data yield did not finish the child" },
								),
							},
						},
					],
				}
			: { role: "assistant", content: canYield ? report : "Fixture task" };
		const chunk = { id: "fixture", object: "chat.completion.chunk", model: body.model, created: 1 };
		return new Response(
			`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
				`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: submit ? "tool_calls" : "stop" }] })}\n\n` +
				"data: [DONE]\n\n",
			{ headers: { "content-type": "text/event-stream" } },
		);
	},
});

try {
	await Promise.all([cwd, agentDir, path.join(work, "home")].map(dir => fs.mkdir(dir, { recursive: true })));
	await Bun.write(
		path.join(cwd, ".omp/agents/report.md"),
		"---\nname: report\ndescription: Installed yield report fixture\nmodel: fixture/report\nblocking: true\ntools: []\n---\nReturn the review report.\n",
	);
	await Bun.write(
		extensionPath,
		`const fixture = ${JSON.stringify({ cwd, agentDir, resultPath, report, baseUrl: server.url.href })};\n` +
			String.raw`
import assert from "node:assert/strict";

function registerFixtureProvider(api) {
	api.registerProvider("fixture", {
		baseUrl: fixture.baseUrl, apiKey: "offline-fixture-key", api: "openai-completions",
		models: [{
			id: "report", name: "report", reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000, maxTokens: 1024,
		}],
	});
}

export default function (api) {
	registerFixtureProvider(api);
	api.registerCommand("yield-report-smoke", {
		handler: async (_args, ctx) => {
			const { createAgentSession, Settings, AgentRegistry, SessionManager, ModelRegistry } = api.pi;
			const settings = await Settings.loadIsolated({
				cwd: fixture.cwd, agentDir: fixture.agentDir,
				overrides: {
					"async.enabled": false, "task.batch": false,
					"task.isolation.enabled": false, "task.enableLsp": false,
					"modelRoles": { default: "fixture/report", tiny: "fixture/report" },
				},
			});
			const { session } = await createAgentSession({
				cwd: fixture.cwd, agentDir: fixture.agentDir, settings,
				agentRegistry: new AgentRegistry(),
				modelRegistry: new ModelRegistry(ctx.modelRegistry.authStorage, fixture.agentDir + "/models.yml"),
				sessionManager: SessionManager.inMemory(fixture.cwd),
				preloadedExtensionPaths: [], preloadedCustomToolPaths: [],
				skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
				enableMCP: false, enableLsp: false, enableIrc: false,
				skipPythonPreflight: true, toolNames: ["task"], autoApprove: true,
				extensions: [registerFixtureProvider],
			});
			try {
				const task = session.getToolByName("task");
				assert(task, "Native task tool is unavailable");
				const result = await task.execute("report-child", { agent: "report", task: "Review the fixture" });
				const child = result.details?.results?.[0];
				await Bun.write(fixture.resultPath, JSON.stringify(result));
				assert.equal(child?.exitCode, 0, JSON.stringify(result));
				assert.equal(child.output, JSON.stringify(fixture.report));
			} finally {
				await session.dispose();
				ctx.shutdown();
			}
		},
	});
}
`,
	);
	const child = Bun.spawn(
		[
			...cli,
			"--no-extensions",
			"--extension",
			extensionPath,
			"--no-session",
			"--no-tools",
			"--no-lsp",
			"--no-skills",
			"--no-rules",
			"--no-title",
			"--model",
			"fixture/report",
			"--print",
			"/yield-report-smoke",
		],
		{
			cwd,
			env: {
				PATH: process.env.PATH,
				HOME: path.join(work, "home"),
				XDG_DATA_HOME: path.join(work, "xdg"),
				PI_CODING_AGENT_DIR: agentDir,
				TMPDIR: work,
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 120_000,
		},
	);
	const [exitCode, stdout, stderr] = await Promise.all([
		child.exited,
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
	]);
	assert.equal(exitCode, 0, `Yield report CLI failed (${exitCode})\n${stdout}\n${stderr}`);
	const result = await Bun.file(resultPath)
		.json()
		.catch(error => {
			throw new Error(`Yield report probe did not complete\n${stdout}\n${stderr}`, { cause: error });
		});
	assert(
		!JSON.stringify({ result, requests, stdout, stderr }).includes("thinking only"),
		"Native yield refused the preceding report as thinking only",
	);
	assert.equal(result.details?.results?.[0]?.exitCode, 0, JSON.stringify(result));
	assert.equal(result.details.results[0].output, JSON.stringify(report));
	assert.equal(requests.length, 2, "Expected prose turn and one data-less yield turn");
	const idleReminder = "Last turn had no tool call";
	assert(!JSON.stringify(requests[0]).includes(idleReminder), "Idle reminder preceded the report");
	assert(JSON.stringify(requests[1]).includes(idleReminder), "Missing native yield reminder");
	console.log("Installed CLI omitted-data yield report smoke passed");
} finally {
	server.stop(true);
	await fs.rm(work, { recursive: true, force: true });
}
