/**
 * `omp --tools <list>` is an allow-list for everything the model can invoke:
 * built-in tools, extension tools, `xd://` devices and MCP tools. Before, it
 * chose only the initial built-ins: extension, plugin and MCP tools were still
 * mounted as devices behind `write xd://<tool>`, so a replay that relied on
 * `--tools read,grep,glob` for a read-only session could still send messages.
 *
 * Each case runs the real CLI in print mode against a scripted model that
 * records the tools each request offers, with a stand-in user whose
 * `mcp.json` declares a stdio server that records every start, and an
 * extension that registers a messaging-like tool.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { isToolAllowListSelector, ToolAllowList } from "@oh-my-pi/pi-coding-agent/tools/tool-allowlist";
import { isRecord, ptree, readLines, removeWithRetries } from "@oh-my-pi/pi-utils";

const cli = path.join(import.meta.dir, "../src/cli.ts");
const fakeModel = path.join(import.meta.dir, "rpc-wire/fake-openai-server.ts");
const mcpServer = path.join(import.meta.dir, "fixtures/rpc-mcp-server.ts");
const MCP_TOOL = "mcp__stub_regression_announce";

interface Run {
	offered: string[][];
	output: string;
	mcpStarts: number;
}

let root: string;
let agentDir: string;
let project: string;
let extension: string;
let env: Record<string, string>;
let model: ptree.ChildProcess<"pipe"> | undefined;
let toolsLog: string;

async function auditedStarts(audit: string): Promise<number[]> {
	const entries: unknown[] = Bun.JSONL.parse(await Bun.file(audit).text());
	return entries.flatMap(entry =>
		isRecord(entry) && entry.event === "spawn" && typeof entry.pid === "number" ? [entry.pid] : [],
	);
}

async function run(args: string[], prompt: string): Promise<Run> {
	const runDir = await fs.mkdtemp(path.join(root, "run-"));
	const audit = path.join(runDir, "mcp-audit.jsonl");
	await Bun.write(audit, "");
	// Cases run one at a time; the scripted model appends to one log.
	await Bun.write(toolsLog, "");
	await Bun.write(
		path.join(agentDir, "mcp.json"),
		JSON.stringify({ mcpServers: { stub: { command: process.execPath, args: [mcpServer, audit] } } }),
	);
	const result = await ptree.exec(
		[
			process.execPath,
			cli,
			"-p",
			"--model",
			"fake/fake-model",
			"--no-skills",
			"--no-rules",
			"--no-lsp",
			"-e",
			extension,
			...args,
			prompt,
		],
		{ cwd: project, env, allowNonZero: true, timeout: 120_000 },
	);
	const starts = await auditedStarts(audit);
	for (const pid of starts) {
		try {
			process.kill(pid);
		} catch {}
	}
	const offered = (await Bun.file(toolsLog).text())
		.split("\n")
		.filter(Boolean)
		.map(line => JSON.parse(line) as string[]);
	return { offered, output: `${result.stdout}${result.stderr}`, mcpStarts: starts.length };
}

beforeAll(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-tools-allowlist-"));
	const home = path.join(root, "home");
	agentDir = path.join(home, ".omp/agent");
	project = path.join(root, "project");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(project);
	extension = path.join(root, "probe-extension.ts");
	await Bun.write(
		extension,
		`export default function (api) {
	api.registerTool({
		name: "probe_send",
		label: "Probe send",
		description: "Stands in for a messaging device.",
		parameters: api.arktype({}),
		execute: async () => ({ content: [{ type: "text", text: "probe sent" }] }),
	});
}
`,
	);
	env = {
		PATH: `${path.dirname(process.execPath)}${path.delimiter}${Bun.env.PATH ?? ""}`,
		HOME: home,
		USERPROFILE: home,
		XDG_CONFIG_HOME: path.join(home, ".config"),
		PI_CONFIG_DIR: ".omp",
		PI_CODING_AGENT_DIR: agentDir,
		PI_NO_TITLE: "1",
		PI_NO_MCP: "",
	};
	toolsLog = path.join(root, "offered-tools.jsonl");
	model = ptree.spawn([process.execPath, fakeModel, agentDir], {
		cwd: project,
		env: { ...env, FAKE_OPENAI_TOOLS_LOG: toolsLog },
		stdin: "pipe",
		detached: true,
		timeout: 600_000,
	});
	for await (const line of readLines(model.stdout, AbortSignal.timeout(30_000))) {
		expect(new TextDecoder().decode(line)).toMatch(/^READY \d+/);
		break;
	}
});

afterAll(async () => {
	model?.stdin.end();
	model?.kill();
	await model?.exited.catch(() => {});
	await removeWithRetries(root);
});

describe("--tools as an allow-list", () => {
	it("offers and mounts only the listed tools, and starts no MCP server", async () => {
		const { offered, output, mcpStarts } = await run(["--tools", "read,grep,glob"], "read_uri xd://");
		expect(offered[0]).toEqual(["read", "grep", "glob"]);
		expect(output).toContain("0 mounted tool devices");
		expect(output).not.toContain("probe_send");
		expect(mcpStarts).toBe(0);
	}, 180_000);

	it("cannot reach a tool it does not list through write xd://", async () => {
		const { output } = await run(["--tools", "read,mcp:stub"], "write_uri xd://probe_send {}");
		expect(output).toContain("No such tool: xd://probe_send");
		expect(output).not.toContain("probe sent");
	}, 180_000);

	it("mounts every tool of a server named with mcp:<server>, behind a device-only write", async () => {
		const listed = await run(["--tools", "read,mcp:stub"], "read_uri xd://");
		expect(listed.offered[0]).toEqual(["read", "write"]);
		expect(listed.output).toContain(`xd://${MCP_TOOL}`);
		expect(listed.output).not.toContain("probe_send");
		expect(listed.mcpStarts).toBe(1);

		const called = await run(["--tools", "read,mcp:stub"], `write_uri xd://${MCP_TOOL} {}`);
		expect(called.output).toContain("rpc-mcp-invoked");

		const file = path.join(root, "must-not-exist.txt");
		const wrote = await run(["--tools", "read,mcp:stub"], `write_uri ${file}`);
		expect(wrote.output).toContain("limited to the xd:// device transport");
		expect(await Bun.file(file).exists()).toBe(false);
	}, 360_000);

	it("mounts every extension and MCP tool with xd:*", async () => {
		const { output, mcpStarts } = await run(["--tools", "read,xd:*"], "read_uri xd://");
		expect(output).toContain("xd://probe_send");
		expect(output).toContain(`xd://${MCP_TOOL}`);
		expect(mcpStarts).toBe(1);
	}, 180_000);

	it("offers an extension tool it names", async () => {
		const { offered, mcpStarts } = await run(["--tools", "read,probe_send"], "hello");
		expect(offered[0]).toEqual(["read", "probe_send"]);
		expect(mcpStarts).toBe(0);
	}, 180_000);

	it("leaves a session without --tools as it was", async () => {
		const { output, mcpStarts } = await run([], "read_uri xd://");
		expect(output).toContain("xd://probe_send");
		expect(output).toContain(`xd://${MCP_TOOL}`);
		expect(mcpStarts).toBe(1);
	}, 180_000);
});

describe("ToolAllowList", () => {
	const mcpTool = { name: MCP_TOOL, mcpServerName: "stub", loadMode: "discoverable" as const };
	const device = { name: "probe_send", loadMode: "discoverable" as const };

	it("allows a named tool, a named server's tools, and devices with xd:*", () => {
		const list = ToolAllowList.parse(["read", "mcp:stub"]);
		expect(list.allows("read", undefined)).toBe(true);
		expect(list.allows(MCP_TOOL, mcpTool)).toBe(true);
		expect(list.allows("probe_send", device)).toBe(false);
		expect(ToolAllowList.parse(["xd:*"]).allows("probe_send", device)).toBe(true);
		expect(ToolAllowList.parse(["xd:*"]).allows("bash", { name: "bash" })).toBe(false);
	});

	it("allows MCP only when an entry can reach an MCP tool", () => {
		expect(ToolAllowList.parse(["read", "grep"]).allowsMCP).toBe(false);
		expect(ToolAllowList.parse(["mcp:stub"]).allowsMCP).toBe(true);
		expect(ToolAllowList.parse([MCP_TOOL]).allowsMCP).toBe(true);
		expect(ToolAllowList.parse(["xd:*"]).allowsMCP).toBe(true);
	});

	it("tells selectors from names", () => {
		expect(ToolAllowList.parse(["read", "mcp:stub", "xd:*"]).toolNames).toEqual(["read"]);
		expect(isToolAllowListSelector("mcp:stub")).toBe(true);
		expect(isToolAllowListSelector("xd:*")).toBe(true);
		expect(isToolAllowListSelector("read")).toBe(false);
	});
});
