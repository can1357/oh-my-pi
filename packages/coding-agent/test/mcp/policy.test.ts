/**
 * `/restart` and `/fork` build another omp's argv from the launch argv, which
 * an environment-only `PI_NO_MCP=1` never appears in; the relaunch must still
 * start no MCP server.
 */
import { describe, expect, it } from "bun:test";
import { restartArgv } from "@oh-my-pi/pi-coding-agent/cli/flag-tables";
import { mcpPolicyArgs } from "@oh-my-pi/pi-coding-agent/mcp/policy";
import { setNoMcpEnvForTest } from "../helpers/no-mcp-env";

function relaunch(argv: string[]): string[] {
	const args = restartArgv(argv, "/sessions/current.jsonl");
	return [...mcpPolicyArgs(args), ...args];
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

	it("keeps a launch --no-mcp once instead of adding a second", () => {
		setNoMcpEnvForTest("1");
		expect(relaunch(["--no-mcp", "--model", "provider/model"])).toEqual([
			"--no-mcp",
			"--model",
			"provider/model",
			"--resume",
			"/sessions/current.jsonl",
		]);
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
});
