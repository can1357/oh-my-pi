import { afterEach, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { MnemosyneOssWorkerClient } from "@oh-my-pi/pi-coding-agent/mnemosyne-oss/worker-client";
import {
	MNEMOSYNE_OSS_PROTOCOL_VERSION,
	MNEMOSYNE_OSS_REQUIRED_METHODS,
	type MnemosyneOssWorkerContext,
} from "@oh-my-pi/pi-coding-agent/mnemosyne-oss/worker-protocol";
import { TempDir } from "@oh-my-pi/pi-utils";

const temporaryDirectories: TempDir[] = [];

afterEach(async () => {
	for (const directory of temporaryDirectories.splice(0)) await directory.remove();
});

function workerContext(storeDataDir: string): MnemosyneOssWorkerContext {
	return {
		session_id: "worker-test-session",
		cwd: "/tmp",
		store_data_dir: storeDataDir,
		retain_bank: "project-bank",
		recall_banks: ["project-bank"],
		shared_banks: [],
		ownership: "omp",
		author_id: "omp",
		author_type: "agent",
		channel_id: "worker-test-session",
		embedding_mode: "lexical",
		consolidation_mode: "heuristic",
		auto_migrate: false,
	};
}

interface FakeWorkerOptions {
	pythonVersion?: string;
	sdkVersion?: string;
	missingMethods?: boolean;
	crashStatusOnce?: boolean;
	crashRemember?: boolean;
	malformedStatus?: boolean;
	statusDelayMs?: number;
	rememberDelayMs?: number;
}

interface FakeWorker {
	directory: TempDir;
	executable: string;
	callsFile: string;
	mutationFile: string;
	markerFile: string;
}

async function fakeWorker(options: FakeWorkerOptions = {}): Promise<FakeWorker> {
	const directory = TempDir.createSync("mnemosyne-oss-fake-worker-");
	temporaryDirectories.push(directory);
	const root = path.resolve(directory.path());
	const callsFile = path.join(root, "calls.log");
	const mutationFile = path.join(root, "mutations.log");
	const markerFile = path.join(root, "crashed.once");
	const executable = path.join(root, "fake-python");
	const operations = options.missingMethods ? ["initialize", "capabilities"] : MNEMOSYNE_OSS_REQUIRED_METHODS;
	const pythonOptions = JSON.stringify(options)
		.replace(/\btrue\b/g, "True")
		.replace(/\bfalse\b/g, "False");
	await Bun.write(
		executable,
		`#!/usr/bin/env python3
import json, os, pathlib, sys, time
ROOT = pathlib.Path(${JSON.stringify(root)})
CALLS = pathlib.Path(${JSON.stringify(callsFile)})
MUTATIONS = pathlib.Path(${JSON.stringify(mutationFile)})
MARKER = pathlib.Path(${JSON.stringify(markerFile)})
OPTIONS = ${pythonOptions}

def record(value):
    with CALLS.open("a") as stream:
        stream.write(value + "\\n")

def reply(request, result):
    print(json.dumps({"jsonrpc": "2.0", "id": request["id"], "result": result}), flush=True)

for line in sys.stdin:
    request = json.loads(line)
    method = request.get("method")
    if method == "$/cancelRequest":
        continue
    record(method)
    if method == "capabilities":
        result = {"protocol": ${MNEMOSYNE_OSS_PROTOCOL_VERSION}, "sdk_version": OPTIONS.get("sdkVersion", "4.0.0"), "python_version": OPTIONS.get("pythonVersion", "3.11.0"), "operations": ${JSON.stringify(operations)}, "embedding_mode": "lexical", "consolidation_mode": "heuristic", "clear_mode": "bank-manager"}
    elif method == "status":
        if OPTIONS.get("crashStatusOnce") and not MARKER.exists():
            MARKER.write_text("crashed")
            print("fake worker diagnostic", file=sys.stderr, flush=True)
            os._exit(17)
        if OPTIONS.get("malformedStatus"):
            print("not-json", flush=True)
            continue
        delay = OPTIONS.get("statusDelayMs", 0)
        if delay:
            time.sleep(delay / 1000)
        result = {
            "runtime_data_dir": os.environ.get("MNEMOSYNE_DATA_DIR"),
            "sentinel": os.environ.get("MNEMOSYNE_SENTINEL_PROVIDER"),
            "inherited": os.environ.get("MNEMOSYNE_INHERITED"),
            "name": request.get("params", {}).get("name"),
            "no_embeddings": os.environ.get("MNEMOSYNE_NO_EMBEDDINGS"),
            "skip_embeddings": os.environ.get("MNEMOSYNE_SKIP_EMBEDDINGS"),
            "embeddings_off": os.environ.get("MNEMOSYNE_EMBEDDINGS_OFF"),
            "llm_enabled": os.environ.get("MNEMOSYNE_LLM_ENABLED"),
            "embedding_mode": os.environ.get("MNEMOSYNE_EMBEDDING_MODE"),
            "embeddings_enabled": os.environ.get("MNEMOSYNE_EMBEDDINGS_ENABLED"),
            "llm_mode": os.environ.get("MNEMOSYNE_LLM_MODE"),
        }
    elif method == "remember":
        with MUTATIONS.open("a") as stream:
            stream.write("remember\\n")
        if OPTIONS.get("crashRemember"):
            os._exit(19)
        delay = OPTIONS.get("rememberDelayMs", 0)
        if delay:
            time.sleep(delay / 1000)
        result = {"id": "memory-1", "bank": "project-bank"}
    elif method == "recall":
        result = {"items": [{"id": "memory-1", "content": "remembered", "score": 1.0, "bank": "project-bank"}]}
    elif method == "shutdown":
        reply(request, {"shutdown": True})
        break
    else:
        result = {"protocol": ${MNEMOSYNE_OSS_PROTOCOL_VERSION}}
    reply(request, result)
`,
	);
	await fs.chmod(executable, 0o755);
	return { directory, executable, callsFile, mutationFile, markerFile };
}

function clientFor(
	fake: FakeWorker,
	timeoutMs = 500,
	context: MnemosyneOssWorkerContext = workerContext(path.join(path.resolve(fake.directory.path()), "shared-store")),
): MnemosyneOssWorkerClient {
	return new MnemosyneOssWorkerClient({
		context,
		cwd: path.resolve(fake.directory.path()),
		executable: fake.executable,
		requestTimeoutMs: timeoutMs,
		shutdownTimeoutMs: 250,
	});
}

async function lines(file: string): Promise<string[]> {
	try {
		return (await Bun.file(file).text()).trim().split("\n").filter(Boolean);
	} catch {
		return [];
	}
}

it("handshakes over newline JSON-RPC and keeps runtime config separate from the shared store", async () => {
	const fake = await fakeWorker();
	const client = clientFor(fake, 2_000);
	const capabilities = await client.capabilities();
	expect(capabilities.protocol).toBe(MNEMOSYNE_OSS_PROTOCOL_VERSION);
	expect(capabilities.operations).toEqual(MNEMOSYNE_OSS_REQUIRED_METHODS);
	const status = await client.request<{ runtime_data_dir: string }>("status");
	expect(status.runtime_data_dir).not.toBe(path.join(path.resolve(fake.directory.path()), "shared-store"));
	await client.shutdown();
	expect(await Bun.file(status.runtime_data_dir).exists()).toBe(false);
});

it("rejects unsupported Python, SDK, and method handshakes with actionable diagnostics", async () => {
	const oldPython = clientFor(await fakeWorker({ pythonVersion: "3.9.0" }));
	await expect(oldPython.capabilities()).rejects.toThrow("Python 3.10+");
	await oldPython.shutdown();

	const oldSdk = clientFor(await fakeWorker({ sdkVersion: "3.9.0" }));
	await expect(oldSdk.capabilities()).rejects.toThrow("SDK major 4");
	await oldSdk.shutdown();

	const incomplete = clientFor(await fakeWorker({ missingMethods: true }));
	await expect(incomplete.capabilities()).rejects.toThrow("missing required operations");
	await incomplete.shutdown();
});

it("passes one executable argv and an allowlisted local-only environment", async () => {
	const previousProvider = process.env.MNEMOSYNE_SENTINEL_PROVIDER;
	const previousInherited = process.env.MNEMOSYNE_INHERITED;
	process.env.MNEMOSYNE_SENTINEL_PROVIDER = "must-not-cross-process";
	process.env.MNEMOSYNE_INHERITED = "must-not-cross-process";
	try {
		const fake = await fakeWorker();
		const client = clientFor(fake);
		const status = await client.request<{
			runtime_data_dir: string;
			sentinel?: string;
			inherited?: string;
			no_embeddings?: string;
			skip_embeddings?: string;
			embeddings_off?: string;
			llm_enabled?: string;
			embedding_mode?: string;
			embeddings_enabled?: string;
			llm_mode?: string;
		}>("status");
		expect(status.sentinel).toBeNull();
		expect(status.inherited).toBeNull();
		expect(status.no_embeddings).toBe("1");
		expect(status.skip_embeddings).toBe("1");
		expect(status.embeddings_off).toBe("1");
		expect(status.llm_enabled).toBe("false");
		expect(status.embedding_mode).toBeNull();
		expect(status.embeddings_enabled).toBeNull();
		expect(status.llm_mode).toBeNull();
		expect(status.runtime_data_dir).toContain("omp-mnemosyne-oss-config-");
		expect((await lines(fake.callsFile)).filter(line => line === "initialize")).toHaveLength(1);
		await client.shutdown();
	} finally {
		if (previousProvider === undefined) delete process.env.MNEMOSYNE_SENTINEL_PROVIDER;
		else process.env.MNEMOSYNE_SENTINEL_PROVIDER = previousProvider;
		if (previousInherited === undefined) delete process.env.MNEMOSYNE_INHERITED;
		else process.env.MNEMOSYNE_INHERITED = previousInherited;
	}
});

it("serializes correlated responses and keeps queued aborts out of the child", async () => {
	const fake = await fakeWorker({ statusDelayMs: 100 });
	const client = clientFor(fake, 2_000);
	const first = client.request<{ name: string }>("status", { name: "first" });
	const controller = new AbortController();
	const second = client.request<{ name: string }>("status", { name: "second" }, { signal: controller.signal });
	controller.abort();
	expect(await first).toEqual(expect.objectContaining({ name: "first" }));
	await expect(second).rejects.toThrow();
	const statusCalls = (await lines(fake.callsFile)).filter(line => line === "status");
	expect(statusCalls).toHaveLength(1);
	await client.shutdown();
});

it("rejects malformed stdout and preserves stderr in crash diagnostics", async () => {
	const malformed = clientFor(await fakeWorker({ malformedStatus: true }), 2_000);
	await expect(malformed.request("status")).rejects.toThrow("malformed JSON-RPC");
	await malformed.shutdown();

	const crashed = clientFor(await fakeWorker({ crashStatusOnce: true }), 2_000);
	// The read-only status operation is retried once, so its final result is
	// successful while the next mutation would still never be replayed.
	expect(await crashed.request("status")).toEqual(expect.objectContaining({ runtime_data_dir: expect.any(String) }));
	await crashed.shutdown();
});

it("times out and aborts in-flight SDK calls by terminating the child", async () => {
	const timedOut = clientFor(await fakeWorker({ statusDelayMs: 1_000 }), 40);
	await expect(timedOut.request("status")).rejects.toThrow("timed out");
	await timedOut.shutdown();

	const aborted = clientFor(await fakeWorker({ statusDelayMs: 1_000 }), 2_000);
	const controller = new AbortController();
	const request = aborted.request("status", {}, { signal: controller.signal });
	setTimeout(() => controller.abort(), 20);
	await expect(request).rejects.toThrow();
	await aborted.shutdown();
});

it("enables local embeddings and LLM when the context requests local modes", async () => {
	const fake = await fakeWorker();
	const store = path.join(path.resolve(fake.directory.path()), "shared-store");
	const client = clientFor(fake, 2_000, {
		...workerContext(store),
		embedding_mode: "local",
		embedding_model: "local-model",
		consolidation_mode: "local",
		local_llm_repo: "org/model",
		local_llm_file: "model.gguf",
	});
	const status = await client.request<{
		no_embeddings?: string;
		skip_embeddings?: string;
		embeddings_off?: string;
		llm_enabled?: string;
	}>("status");
	expect(status.no_embeddings).toBeNull();
	expect(status.skip_embeddings).toBeNull();
	expect(status.embeddings_off).toBeNull();
	expect(status.llm_enabled).toBe("true");
	await client.shutdown();
});

it("reports unknown mutation outcome when a write completes during cancel grace", async () => {
	const fake = await fakeWorker({ rememberDelayMs: 100 });
	const client = clientFor(fake, 2_000);
	await expect(client.request("remember", { content: "once" }, { mutation: true, timeoutMs: 40 })).rejects.toThrow(
		"operation outcome unknown",
	);
	expect(await lines(fake.mutationFile)).toEqual(["remember"]);
	await client.shutdown();
});

it("never replays a mutation after an uncertain crash and lazily restarts for reads", async () => {
	const fake = await fakeWorker({ crashRemember: true });
	const client = clientFor(fake, 2_000);
	await expect(client.request("remember", { content: "once" }, { mutation: true })).rejects.toThrow("outcome unknown");
	expect(await lines(fake.mutationFile)).toEqual(["remember"]);

	// A new read starts a fresh child and performs a new handshake.
	await expect(client.request("status")).resolves.toEqual(
		expect.objectContaining({ runtime_data_dir: expect.any(String) }),
	);
	expect((await lines(fake.callsFile)).filter(line => line === "initialize").length).toBeGreaterThanOrEqual(2);
	await client.shutdown();
});

it("shutdown is idempotent and removes the temporary config after child exit", async () => {
	const fake = await fakeWorker();
	const client = clientFor(fake);
	const status = await client.request<{ runtime_data_dir: string }>("status");
	await Promise.all([client.shutdown(), client.shutdown(), client.shutdown()]);
	expect(await Bun.file(status.runtime_data_dir).exists()).toBe(false);
	await expect(client.shutdown()).resolves.toBeUndefined();
});
