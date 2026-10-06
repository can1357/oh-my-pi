import { expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteAuthCredentialStore } from "@oh-my-pi/pi-ai/auth/sqlite-credential-store";
import { readJsonl } from "@oh-my-pi/pi-utils";

type RpcResponse = {
	type: string;
	id: string;
	success: boolean;
	error?: string;
	data?: { models: { provider: string; id: string }[] };
};

test("running RPC session sees credentials stored and removed by another process", async () => {
	const home = await fs.mkdtemp(path.join(os.tmpdir(), "omp-rpc-auth-"));
	const agentDir = path.join(home, ".omp", "agent");
	await fs.mkdir(agentDir, { recursive: true });
	await Bun.write(
		path.join(agentDir, "models.yml"),
		"providers:\n  local:\n    baseUrl: http://127.0.0.1:9/v1\n    apiKey: dummy\n    api: openai-completions\n    models:\n      - id: m1\n",
	);
	const child = Bun.spawn(
		[
			process.execPath,
			path.join(import.meta.dir, "../src/cli.ts"),
			"--mode",
			"rpc",
			"--no-session",
			"--model",
			"local/m1",
		],
		{
			cwd: home,
			env: { HOME: home, PATH: process.env.PATH ?? "" },
			stdin: "pipe",
			stdout: "pipe",
			stderr: "pipe",
		},
	);
	const pending = new Map<string, (response: RpcResponse) => void>();
	const output = (async () => {
		for await (const frame of readJsonl<RpcResponse>(child.stdout)) {
			if (frame?.type !== "response" || typeof frame.id !== "string") continue;
			pending.get(frame.id)?.(frame);
		}
	})();
	let nextId = 0;
	const send = (command: object) => {
		const id = String(++nextId);
		const { promise, resolve } = Promise.withResolvers<RpcResponse>();
		pending.set(id, resolve);
		child.stdin.write(`${JSON.stringify({ ...command, id })}\n`);
		child.stdin.flush();
		return promise;
	};
	const models = async () => (await send({ type: "get_available_models" })).data?.models ?? [];
	try {
		expect((await models()).some(model => model.provider === "deepseek")).toBe(false);
		const store = await SqliteAuthCredentialStore.open(path.join(agentDir, "agent.db"));
		try {
			await store.upsertAuthCredential("deepseek", { type: "api_key", key: "sk-dummy", source: "login" });
			const model = (await models()).find(candidate => candidate.provider === "deepseek");
			expect(model).toBeDefined();
			await store.deleteAuthCredentials("deepseek", "user");
			const removed = await send({ type: "set_model", provider: "deepseek", modelId: model?.id });
			expect(removed).toMatchObject({ success: false, error: `Model not found: deepseek/${model?.id}` });
			await store.upsertAuthCredential("deepseek", { type: "api_key", key: "sk-dummy", source: "login" });
			const selected = await send({ type: "set_model", provider: "deepseek", modelId: model?.id });
			expect(selected.success).toBe(true);
			await store.deleteAuthCredentials("deepseek", "user");
			expect((await models()).some(candidate => candidate.provider === "deepseek")).toBe(false);
		} finally {
			store.close();
		}
	} finally {
		child.stdin.end();
		await child.exited;
		await output;
		await fs.rm(home, { recursive: true, force: true });
	}
}, 30_000);
