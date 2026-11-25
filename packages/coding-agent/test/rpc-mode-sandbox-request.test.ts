import { afterEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";
import { TempDir } from "@oh-my-pi/pi-utils";
import { SANDBOX_UNAVAILABLE as UNAVAILABLE } from "./helpers/sandbox-test-state";

describe("runRpcMode and sandbox_request", () => {
	let client: RpcClient | undefined;
	let temp: TempDir | undefined;

	afterEach(async () => {
		await client?.stop();
		client = undefined;
		await temp?.remove();
		temp = undefined;
	});

	test("a session an embedder built before declaring a prompt host offers sandbox_request once runRpcMode starts", async () => {
		temp = await TempDir.create("@omp-rpc-sandbox-request-");
		const sourceDir = path.resolve(import.meta.dir, "../src");
		const fixture = temp.join("runtime.ts");
		// No `setAccessPromptHost` before the session is built: the SDK default, as a programmatic embedder has it.
		await Bun.write(
			fixture,
			`
import { createAgentSession, Settings } from ${JSON.stringify(path.join(sourceDir, "sdk.ts"))};
import { runRpcMode } from ${JSON.stringify(path.join(sourceDir, "modes/rpc/rpc-mode.ts"))};
import { SandboxRuntime } from ${JSON.stringify(path.join(sourceDir, "sandbox/runtime.ts"))};
globalThis.fetch = async () => { throw new Error("Offline sandbox fixture refuses network"); };
SandboxRuntime.resetForTest(JSON.parse(Bun.env.SANDBOX_TEST_SUPPORT));
const { session } = await createAgentSession({
  cwd: process.cwd(),
  toolNames: ["read", "sandbox_request"],
  enableMCP: false,
  enableLsp: false,
  disableExtensionDiscovery: true,
  settings: Settings.isolated({ "compaction.enabled": false, "sandbox.enabled": true }),
});
if (session.hasBuiltInTool("sandbox_request")) throw new Error("fixture: tool present before runRpcMode");
await runRpcMode(session);
`,
		);
		const workspace = temp.join("workspace");
		fs.mkdirSync(workspace);
		client = new RpcClient({
			command: [process.execPath, fixture],
			cwd: workspace,
			env: {
				HOME: temp.join("home"),
				PI_CODING_AGENT_DIR: temp.join("agent"),
				XDG_CONFIG_HOME: temp.join("config"),
				XDG_DATA_HOME: temp.join("data"),
				XDG_CACHE_HOME: temp.join("cache"),
				PI_NO_TITLE: "1",
				SANDBOX_TEST_SUPPORT: JSON.stringify(UNAVAILABLE),
			},
		});
		await client.start();
		const state = await client.getState();
		expect(state.dumpTools?.map(tool => tool.name)).toContain("sandbox_request");
	}, 30_000);
});
