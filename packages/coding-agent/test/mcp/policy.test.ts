/**
 * `/restart` and `/fork` build another omp's argv from the launch argv, which
 * an environment-only `PI_NO_MCP=1` never appears in; the relaunch must still
 * start no MCP server.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { parseArgs } from "@oh-my-pi/pi-coding-agent/cli/args";
import { restartArgv } from "@oh-my-pi/pi-coding-agent/cli/flag-tables";
import { daemonRuntimeDir } from "@oh-my-pi/pi-coding-agent/launch/paths";
import { mcpPolicyArgs } from "@oh-my-pi/pi-coding-agent/mcp/policy";
import { setNoMcpEnvForTest } from "../helpers/no-mcp-env";

function relaunch(argv: string[]): string[] {
	const args = restartArgv(argv, "/sessions/current.jsonl");
	return [...mcpPolicyArgs(), ...args];
}

describe("mcpPolicyArgs on a relaunch argv", () => {
	it("leads with --no-mcp when PI_NO_MCP=1 came only from the environment", () => {
		setNoMcpEnvForTest("1");
		expect(relaunch(["--model", "provider/model", "prompt"])).toEqual([
			"--no-mcp",
			"--model",
			"provider/model",
			"--resume",
			"/sessions/current.jsonl",
		]);
	});

	// `--no-mcp` as another flag's value is not the flag (round-2 review: the
	// relaunched omp started the user's server).
	it("still turns MCP off when --no-mcp in the argv is another flag's value", () => {
		setNoMcpEnvForTest("1");
		const argv = relaunch(["--system-prompt", "--no-mcp", "--model", "provider/model"]);
		expect(parseArgs(argv).noMcp).toBe(true);
		expect(parseArgs(argv).systemPrompt).toBe("--no-mcp");
	});

	it("adds nothing while MCP is on", () => {
		setNoMcpEnvForTest("");
		expect(relaunch(["--model", "provider/model"])).toEqual([
			"--model",
			"provider/model",
			"--resume",
			"/sessions/current.jsonl",
		]);
	});

	// Round-3 review: a shared daemon (the launch broker and everything it starts,
	// the IDA host, the blob broker) runs with the environment of the session that
	// started it; a session with MCP off must never reuse one a session with MCP on started.
	it("gives a session with MCP off its own project daemon scope", () => {
		setNoMcpEnvForTest("");
		const on = daemonRuntimeDir("/projects/example");
		setNoMcpEnvForTest("1");
		const off = daemonRuntimeDir("/projects/example");
		expect(off).not.toBe(on);
		expect(path.basename(off)).toBe(`${path.basename(on)}-no-mcp`);
	});
});
