import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

// Run the supplied CLI, never import the SDK into this driver. Extensions must
// cross the same package boundary as an installed user's extension.
const cli = process.argv.slice(2).map(arg => (arg.includes("/") ? path.resolve(arg) : arg));
assert(cli.length > 0, "Usage: bun scripts/install-tests/settings-session.ts <cli> [cli entrypoint]");
const work = await fs.mkdtemp(path.join(os.tmpdir(), "omp-settings-session-"));
const cwd = path.join(work, "project");
const agentDir = path.join(work, "agent");
const extensionPath = path.join(work, "probe.mjs");
const resultPath = path.join(work, "result.json");

// A local OpenAI-compatible fixture exercises the native task's resolved model
// without credentials or network services. Yield completes the real child turn.
const requestedModels: string[] = [];
const server = Bun.serve({
	hostname: "127.0.0.1",
	port: 0,
	async fetch(request) {
		const body = (await request.json()) as { model: string; tools?: { function: { name: string } }[] };
		const canYield = body.tools?.some(tool => tool.function.name === "yield");
		if (canYield) requestedModels.push(body.model);
		const delta = canYield
			? {
					role: "assistant",
					tool_calls: [
						{
							index: 0,
							id: `yield-${requestedModels.length}`,
							type: "function",
							function: { name: "yield", arguments: JSON.stringify({ data: { model: body.model } }) },
						},
					],
				}
			: { role: "assistant", content: "Fixture task" };
		const chunk = { id: "fixture", object: "chat.completion.chunk", model: body.model, created: 1 };
		return new Response(
			`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta, finish_reason: null }] })}\n\n` +
				`data: ${JSON.stringify({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: canYield ? "tool_calls" : "stop" }] })}\n\n` +
				"data: [DONE]\n\n",
			{ headers: { "content-type": "text/event-stream" } },
		);
	},
});

try {
	await Promise.all([cwd, agentDir, path.join(work, "home")].map(dir => fs.mkdir(dir, { recursive: true })));
	for (const name of ["a", "b"]) {
		const agents = path.join(work, `extension-${name}`, "agents");
		await Bun.write(
			path.join(agents, `only-${name}.md`),
			`---\nname: only-${name}\ndescription: Installed session fixture ${name}.\nmodel: fixture/fallback\nblocking: true\ntools: []\n---\nReturn the fixture result.\n`,
		);
	}
	await Bun.write(
		extensionPath,
		`const fixture = ${JSON.stringify({ work, cwd, agentDir, resultPath, baseUrl: server.url.href })};\n` +
			String.raw`
import assert from "node:assert/strict";
import { SettingsManager } from "@mariozechner/pi-coding-agent";
import { hasMatch } from "@oh-my-pi/pi-natives";

function registerFixtureProvider(api) {
	// Same registration shape as sdk-default-role-extension-provider.test.ts.
	api.registerProvider("fixture", {
		baseUrl: fixture.baseUrl,
		apiKey: "offline-fixture-key",
		api: "openai-completions",
		models: ["fallback", "model-a", "model-b"].map(id => ({
			id, name: id, reasoning: false, input: ["text"],
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 128000, maxTokens: 1024,
		})),
	});
}

export default function (api) {
	registerFixtureProvider(api);
	api.registerCommand("settings-session-smoke", {
		handler: async (_args, ctx) => {
			const { createAgentSession, Settings, AgentRegistry, SessionManager, ModelRegistry } = api.pi;
			const sessions = [];
			const entered = [Promise.withResolvers(), Promise.withResolvers()];
			const disposedA = Promise.withResolvers();
			const failures = [];
			const checked = [];
			try {
				assert.equal(hasMatch("installed native fixture", "native"), true);
				assert.equal(hasMatch("installed native fixture", "absent"), false);
				for (const [index, name] of ["a", "b"].entries()) {
					const settings = await Settings.loadIsolated({
						cwd: fixture.cwd, agentDir: fixture.agentDir,
						overrides: {
							"async.enabled": false, "task.batch": false,
							"task.isolation.enabled": false, "task.enableLsp": false,
							"modelRoles": { default: "fixture/fallback", tiny: "fixture/fallback" },
						},
					});
					const { session } = await createAgentSession({
						cwd: fixture.cwd, agentDir: fixture.agentDir, settings,
						agentRegistry: new AgentRegistry(),
						modelRegistry: new ModelRegistry(ctx.modelRegistry.authStorage, fixture.agentDir + "/models.yml"),
						sessionManager: SessionManager.inMemory(fixture.cwd),
						// Merge mode lets runtime settings supply roots. Empty preloaded
						// paths prevent this driver extension from loading recursively.
						preloadedExtensionPaths: [], preloadedCustomToolPaths: [],
						skills: [], rules: [], contextFiles: [], promptTemplates: [], slashCommands: [],
						enableMCP: false, enableLsp: false, enableIrc: false,
						skipPythonPreflight: true, toolNames: ["task"], autoApprove: true,
						extensions: [registerFixtureProvider, childApi => childApi.registerCommand("probe", {
							handler: async (_args, childCtx) => {
								try {
									SettingsManager.create(childCtx.cwd).override("extensions", [fixture.work + "/extension-" + name]);
									entered[index].resolve();
									await entered[1 - index].promise;
									if (name === "b") await disposedA.promise;
									// Re-enter after an overlapping callback (and, for B,
									// after A's disposal) before mutating a second setting.
									SettingsManager.create(childCtx.cwd).override("task.agentModelOverrides", {
										["only-" + name]: "fixture/model-" + name,
									});
									const task = session.getToolByName("task");
									assert(task, "Native task tool is unavailable");
									const sibling = name === "a" ? "only-b" : "only-a";
									const rejected = await task.execute("reject-" + name, { agent: sibling, task: "Fixture check" });
									const errorText = rejected.content.filter(part => part.type === "text").map(part => part.text).join("\n");
									assert(errorText.includes('Unknown agent "' + sibling + '"'), errorText);
									const available = errorText.split("Available: ")[1]?.split(", ") ?? [];
									assert(available.includes("only-" + name), errorText);
									assert(!available.includes(sibling), errorText);
									const result = await task.execute("own-" + name, { agent: "only-" + name, task: "Fixture check" });
									const child = result.details?.results?.[0];
									assert.equal(child?.exitCode, 0, JSON.stringify(result));
									assert.equal(child.resolvedModel, "fixture/model-" + name);
									assert(child.output.includes("model-" + name), child.output);
									checked.push(name);
								} catch (error) {
									failures.push(String(error.stack ?? error));
								} finally {
									entered[index].resolve();
								}
							},
						})],
					});
					sessions.push(session);
				}
				const a = sessions[0].prompt("/probe");
				const b = sessions[1].prompt("/probe");
				await a;
				await sessions[0].dispose();
				disposedA.resolve();
				await b;
				assert.deepEqual(failures, []);
				assert.deepEqual(checked, ["a", "b"]);
				await Bun.write(fixture.resultPath, JSON.stringify(checked));
			} finally {
				disposedA.resolve();
				for (const session of sessions) await session.dispose();
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
			"fixture/fallback",
			"--print",
			"/settings-session-smoke",
		],
		{
			cwd,
			// Whitelist the runtime environment: no ambient credentials, settings,
			// plugins or user configuration can make a broken fixture succeed.
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
	assert.equal(exitCode, 0, `Settings session CLI failed (${exitCode})\n${stdout}\n${stderr}`);
	const result = await Bun.file(resultPath)
		.json()
		.catch(error => {
			throw new Error(`Settings session probe did not complete\n${stdout}\n${stderr}`, { cause: error });
		});
	assert.deepEqual(result, ["a", "b"]);
	assert.deepEqual(requestedModels, ["model-a", "model-b"]);
	console.log("Installed CLI settings/session isolation smoke passed");
} finally {
	server.stop(true);
	await fs.rm(work, { recursive: true, force: true });
}
