import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as url from "node:url";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const CLI_ENTRY = path.join(import.meta.dir, "..", "src", "cli.ts");
const FIXTURE_PATH = path.join(import.meta.dir, "fixtures", "resources-no-templates-mcp.ts");

// The fixture stalls its `initialize` reply for this long — comfortably past
// `MCPManager`'s `STARTUP_TIMEOUT_MS` (250 ms) so the server is guaranteed to be
// still handshaking when `connectServers` returns and the read begins.
const HANDSHAKE_DELAY_MS = 700;

describe("omp read MCP resource with a slow-connecting server", () => {
	let root: string;
	let projectDir: string;
	let agentDir: string;
	let probePath: string;

	beforeEach(async () => {
		root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-read-mcp-slow-"));
		projectDir = path.join(root, "project");
		agentDir = path.join(root, "agent");
		await Promise.all([fs.mkdir(projectDir), fs.mkdir(agentDir)]);
		await Bun.write(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({
				mcpServers: {
					fixture: {
						type: "stdio",
						command: process.execPath,
						args: [FIXTURE_PATH],
						env: { FIXTURE_HANDSHAKE_DELAY_MS: String(HANDSHAKE_DELAY_MS) },
					},
				},
			}),
		);
		probePath = path.join(root, "probe.ts");
		await Bun.write(
			probePath,
			[
				`import { runCli } from ${JSON.stringify(url.pathToFileURL(CLI_ENTRY).href)};`,
				'await runCli(["read", "test://alpha"]);',
			].join("\n"),
		);
	});

	afterEach(async () => {
		await removeWithRetries(root);
	});

	async function runReadProbe(): Promise<{ exitCode: number; output: string; error: string }> {
		const proc = Bun.spawn([process.execPath, probePath], {
			cwd: projectDir,
			stdout: "pipe",
			stderr: "pipe",
			env: {
				...process.env,
				HOME: root,
				NO_COLOR: "1",
				PI_CODING_AGENT_DIR: agentDir,
			},
		});
		const stdout = new Response(proc.stdout).text();
		const stderr = new Response(proc.stderr).text();
		const [exitCode, output, error] = await Promise.all([proc.exited, stdout, stderr]);
		return { exitCode, output, error };
	}

	it("waits for the pending connect instead of racing the startup deadline", async () => {
		const { exitCode, output, error } = await runReadProbe();

		expect(error).toBe("");
		expect(exitCode).toBe(0);
		expect(output).toContain("fixture content for test://alpha");
	}, 30_000);
});
