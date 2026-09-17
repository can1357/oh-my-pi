import { it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import path from "node:path";
import { createMockModel } from "@pk-nerdsaver-ai/pi-ai/providers/mock";
import { type } from "arktype";
import { ModelRegistry } from "../../../src/config/model-registry";
import { Settings } from "../../../src/config/settings";
import { createNativeTaskExecutor } from "../../../src/operational/native-task-executor";
import { DurableRunner } from "../../../src/operational/runner";
import { OperationalStore } from "../../../src/operational/store";
import * as sdk from "../../../src/sdk";
import { AuthStorage } from "../../../src/session/auth-storage";

// Invoked explicitly in its own Bun test process by native-task-executor.test.ts.
// Only provider transport is scripted. The parent kills this process after the
// real restricted worker has written an isolated target, before generation settles.
const configPath = Bun.env.NATIVE_TASK_CRASH_CONFIG;
if (configPath)
	it("holds a real native worker at an executing crash boundary", async () => {
		const config = type({
			dbPath: "string",
			authPath: "string",
			modelsPath: "string",
			artifactsDir: "string",
			markerPath: "string",
			jobId: "string",
			model: "string",
		}).assert(JSON.parse(await fs.readFile(configPath, "utf8")));
		const store = OperationalStore.open({ dbPath: config.dbPath });
		const auth = await AuthStorage.create(config.authPath);
		const registry = new ModelRegistry(auth, config.modelsPath);
		const model = registry.getAll().find(candidate => `${candidate.provider}/${candidate.id}` === config.model);
		if (!model) throw new Error("Crash fixture pinned model is unavailable");
		auth.setRuntimeApiKey(model.provider, "test-native-key");
		const create = sdk.createAgentSession;
		const spy = vi.spyOn(sdk, "createAgentSession").mockImplementation(async (options = {}) => {
			const settings = options.settings ?? Settings.isolated();
			settings.override("task.prefetch.enabled", false);
			settings.override("compaction.enabled", false);
			settings.override("retry.enabled", false);
			settings.override("tools.approvalMode", "yolo");
			settings.override("tools.discoveryMode", "off");
			const created = await create({
				...options,
				settings,
				authStorage: auth,
				modelRegistry: registry,
				model,
				disableExtensionDiscovery: true,
				enableMCP: false,
				enableIrc: false,
				enableLsp: false,
				skipPythonPreflight: true,
			});
			if (options.nativeTaskExecution)
				created.session.agent.streamFn = () => {
					throw new Error("Internal native execution must not prompt a model");
				};
			else {
				const workspace = created.session.sessionManager.getCwd();
				created.session.agent.streamFn = createMockModel({
					responses: [
						{ content: [{ type: "toolCall", name: "read", arguments: { path: "reference.ts" } }] },
						{
							content: [
								{
									type: "toolCall",
									name: "write",
									arguments: { path: "generated.ts", content: "export const INTERRUPTED_ATTEMPT = true;\n" },
								},
							],
						},
						async (_context, options) => {
							if (!(await fs.stat(path.join(workspace, "generated.ts"))).isFile())
								throw new Error("Crash boundary lacks observed isolated output");
							await fs.writeFile(config.markerPath, JSON.stringify({ workspace }));
							await new Promise<void>((_resolve, reject) =>
								options?.signal?.addEventListener("abort", () => reject(options.signal?.reason), {
									once: true,
								}),
							);
							throw new Error("Crash fixture must be terminated by its parent");
						},
					],
				}).stream;
			}
			return created;
		});
		const runner = new DurableRunner({
			store,
			leaseMs: 2000,
			executor: createNativeTaskExecutor({ store, artifactsDir: config.artifactsDir, heartbeatIntervalMs: 20 }),
		});
		try {
			await runner.runJobById(config.jobId);
		} finally {
			runner.dispose();
			spy.mockRestore();
			store.close();
			auth.close();
		}
	}, 30_000);
