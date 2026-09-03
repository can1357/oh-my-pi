import { afterEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { closeDaemonClients, daemonClientForProject } from "../src/launch/client";
import {
	getOrCreateClient,
	sendRequest,
	setSharedLspEnabled,
	setSharedLspRequired,
	shutdownAll,
} from "../src/lsp/client";
import { LSP_MUX_DAEMON_NAME } from "../src/lsp/mux/protocol";
import { connectSharedLspTransport } from "../src/lsp/mux/daemon";
import type { ServerConfig } from "../src/lsp/types";

const testRoot = path.resolve(import.meta.dir, "../../../build/task108-lsp-integration");
const fixturePath = path.join(import.meta.dir, "fixtures", "fake-lsp-server.ts");
const originalCompiled = process.env.PI_COMPILED;
const projects = new Set<string>();

function fakeServerConfig(): ServerConfig {
	return {
		command: process.execPath,
		args: ["run", fixturePath],
		fileTypes: [".fake"],
		languageId: "fake",
		rootMarkers: [".git"],
	};
}

async function makeProject(): Promise<string> {
	await fs.mkdir(testRoot, { recursive: true });
	const projectDir = await fs.mkdtemp(path.join(testRoot, "project-"));
	await fs.writeFile(path.join(projectDir, ".git"), "test project\n");
	projects.add(projectDir);
	return projectDir;
}

async function stopProjectMux(projectDir: string): Promise<void> {
	try {
		const broker = await daemonClientForProject(projectDir);
		await broker.request({ op: "stop", name: LSP_MUX_DAEMON_NAME, timeoutMs: 5_000 });
	} catch {
		// The strict failure test intentionally leaves no ready mux to stop.
	}
}

async function describeProjectMux(projectDir: string): Promise<{ state: string; pid?: number }> {
	const broker = await daemonClientForProject(projectDir);
	const result = await broker.request({ op: "describe", name: LSP_MUX_DAEMON_NAME });
	if (result.op !== "describe") throw new Error(`unexpected broker response: ${result.op}`);
	return { state: result.daemon.state, pid: result.daemon.pid };
}

afterEach(async () => {
	setSharedLspEnabled(false);
	setSharedLspRequired(false);
	if (originalCompiled === undefined) delete process.env.PI_COMPILED;
	else process.env.PI_COMPILED = originalCompiled;
	await shutdownAll();
	for (const projectDir of projects) await stopProjectMux(projectDir);
	await closeDaemonClients();
	projects.clear();
	await fs.rm(testRoot, { recursive: true, force: true });
});

describe("broker-shared LSP client", () => {
	it("starts one broker mux and reuses its serial client", async () => {
		const projectDir = await makeProject();
		setSharedLspEnabled(true);
		setSharedLspRequired(false);

		const client = await getOrCreateClient(fakeServerConfig(), projectDir, 20_000);
		expect(client.proc.sharedMux).toBe(true);
		expect(await sendRequest(client, "test/echo", { value: 1 })).toEqual({ value: 1 });
		expect(await getOrCreateClient(fakeServerConfig(), projectDir)).toBe(client);

		const mux = await describeProjectMux(projectDir);
		expect(mux.state).toBe("ready");
		expect(mux.pid).toBeTypeOf("number");
	});

	it("converges concurrent connector calls on one project mux", async () => {
		const projectDir = await makeProject();
		setSharedLspEnabled(true);
		setSharedLspRequired(false);
		const config = fakeServerConfig();
		const transports = await Promise.all(
			Array.from({ length: 5 }, () =>
				connectSharedLspTransport({
					command: config.command,
					args: config.args ?? [],
					cwd: projectDir,
				}),
			),
		);

		expect(transports).toHaveLength(5);
		expect(transports.every(transport => transport?.sharedMux === true)).toBe(true);
		const mux = await describeProjectMux(projectDir);
		expect(mux.state).toBe("ready");
		expect(mux.pid).toBeTypeOf("number");
		for (const transport of transports) transport?.kill();
	});

	it("fails closed with the mux cause and cleans the client lock", async () => {
		const projectDir = await makeProject();
		setSharedLspEnabled(true);
		setSharedLspRequired(true);
		// Keep the broker valid, then make only the mux worker command invalid.
		const broker = await daemonClientForProject(projectDir);
		await broker.request({ op: "ping" });
		process.env.PI_COMPILED = "1";

		await expect(getOrCreateClient(fakeServerConfig(), projectDir, 20_000)).rejects.toThrow(/LSP mux unavailable/);

		// The same client key must be retryable after strict mode is disabled;
		// this also proves the strict rejection did not spawn the fake server.
		setSharedLspRequired(false);
		const privateClient = await getOrCreateClient(fakeServerConfig(), projectDir, 20_000);
		expect(privateClient.proc.sharedMux).not.toBe(true);
		expect(await sendRequest(privateClient, "test/echo", { value: 2 })).toEqual({ value: 2 });
	});
});
