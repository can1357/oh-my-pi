/**
 * Contract: `omp -p --output-schema <file>` prints exactly one schema-valid JSON value and exits 0, or prints
 * nothing on stdout and exits nonzero with a stderr diagnostic. Runs the real CLI against a scripted
 * OpenAI-compatible server, so every exit path of print mode is exercised end to end.
 */
import { afterEach, beforeEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { removeWithRetries } from "@oh-my-pi/pi-utils";

const cli = path.join(import.meta.dir, "../src/cli.ts");

// Every case boots the real CLI in a child process (and one boots it six times).
setDefaultTimeout(120_000);

type ScriptedReply =
	| { text: string; finish?: "stop" | "length" | "content_filter" }
	| { tool: string; args: Record<string, unknown> };

interface RecordedRequest {
	toolNames: string[];
	lastRole: string | undefined;
}

let root: string;
let server: Bun.Server<undefined>;
let script: ScriptedReply[];
let requests: RecordedRequest[];

function chunks(reply: ScriptedReply): object[] {
	const base = { id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "fake-model" };
	const usage = { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 };
	if ("tool" in reply) {
		const delta = {
			role: "assistant",
			tool_calls: [
				{
					index: 0,
					id: `call_${reply.tool}`,
					type: "function",
					function: { name: reply.tool, arguments: JSON.stringify(reply.args) },
				},
			],
		};
		return [
			{ ...base, choices: [{ index: 0, delta, finish_reason: null }] },
			{ ...base, choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
			{ ...base, choices: [], usage },
		];
	}
	return [
		{ ...base, choices: [{ index: 0, delta: { role: "assistant", content: reply.text }, finish_reason: null }] },
		{ ...base, choices: [{ index: 0, delta: {}, finish_reason: reply.finish ?? "stop" }] },
		{ ...base, choices: [], usage },
	];
}

beforeEach(async () => {
	root = await fs.mkdtemp(path.join(os.tmpdir(), "omp-output-schema-"));
	script = [];
	requests = [];
	server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const url = new URL(request.url);
			if (url.pathname.endsWith("/models")) {
				return Response.json({ object: "list", data: [{ id: "fake-model", object: "model", owned_by: "fake" }] });
			}
			if (!url.pathname.endsWith("/chat/completions")) return new Response("not found", { status: 404 });
			const body = (await request.json()) as {
				messages?: Array<{ role: string }>;
				tools?: Array<{ function?: { name?: string } }>;
			};
			requests.push({
				toolNames: (body.tools ?? []).map(tool => tool.function?.name ?? ""),
				lastRole: body.messages?.at(-1)?.role,
			});
			const reply = script.shift() ?? { text: "script exhausted" };
			const events = chunks(reply).map(chunk => `data: ${JSON.stringify(chunk)}\n\n`);
			return new Response(`${events.join("")}data: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
		},
	});
	const agentDir = path.join(root, "home/.omp/agent");
	await fs.mkdir(agentDir, { recursive: true });
	await fs.mkdir(path.join(root, "project"));
	await Bun.write(
		path.join(agentDir, "models.yml"),
		[
			"providers:",
			"  fake:",
			`    baseUrl: http://127.0.0.1:${server.port}/v1`,
			"    auth: none",
			"    api: openai-completions",
			"    models:",
			"      - id: fake-model",
			"        name: Fake Model",
			"        reasoning: false",
			"",
		].join("\n"),
	);
});

afterEach(async () => {
	server.stop(true);
	await removeWithRetries(root);
});

async function runOmp(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
	const home = path.join(root, "home");
	const proc = Bun.spawn(
		[
			process.execPath,
			cli,
			"-p",
			"--model",
			"fake/fake-model",
			"--no-extensions",
			"--no-skills",
			"--no-rules",
			"--no-lsp",
			"--no-prewalk",
			"--no-session",
			...args,
		],
		{
			cwd: path.join(root, "project"),
			env: {
				PATH: `${path.dirname(process.execPath)}${path.delimiter}${Bun.env.PATH ?? ""}`,
				HOME: home,
				USERPROFILE: home,
				XDG_CONFIG_HOME: path.join(home, ".config"),
				PI_CONFIG_DIR: ".omp",
				PI_CODING_AGENT_DIR: path.join(home, ".omp/agent"),
				PI_NO_TITLE: "1",
			},
			stdin: "ignore",
			stdout: "pipe",
			stderr: "pipe",
			timeout: 90_000,
		},
	);
	const [stdout, stderr, code] = await Promise.all([
		new Response(proc.stdout).text(),
		new Response(proc.stderr).text(),
		proc.exited,
	]);
	return { code, stdout, stderr };
}

async function writeSchema(schema: unknown, name = "schema.json"): Promise<string> {
	const file = path.join(root, name);
	await Bun.write(file, typeof schema === "string" ? schema : JSON.stringify(schema));
	return file;
}

const rewriteSchema = {
	type: "object",
	properties: { path: { type: "string" }, code: { type: "string", minLength: 1 } },
	required: ["path", "code"],
	additionalProperties: false,
};

const TS_SOURCE = [
	"export function clamp(value: number, min: number, max: number): number {",
	"\tif (value < min) {",
	"\t\treturn min;",
	"\t}",
	'\tconst note = "quoted \\"text\\" and a backslash \\\\";',
	"\treturn value > max ? max : value;",
	"}",
	"// final line without trailing newline",
].join("\n");

describe("omp -p --output-schema", () => {
	test("valid result: exit 0, stdout is exactly one JSON value, multiline code round-trips including its last line", async () => {
		const schema = await writeSchema(rewriteSchema);
		script = [{ text: JSON.stringify({ path: "src/clamp.ts", code: TS_SOURCE }) }];
		const result = await runOmp(["--output-schema", schema, "rewrite clamp.ts"]);
		expect(result.stderr).not.toContain("Error");
		expect(result.code).toBe(0);
		expect(result.stdout.endsWith("\n")).toBe(true);
		const lines = result.stdout.trimEnd().split("\n");
		expect(lines).toHaveLength(1);
		const parsed = JSON.parse(lines[0]!) as { path: string; code: string };
		expect(parsed.code).toBe(TS_SOURCE);
		expect(parsed.code.endsWith("// final line without trailing newline")).toBe(true);
		expect(requests).toHaveLength(1);
	});

	test("a malformed, unreadable or unsupported schema fails before any model call", async () => {
		const cases: Array<[string, string, RegExp]> = [
			[await writeSchema("{ not json", "bad.json"), "not valid JSON", /not valid JSON/],
			[path.join(root, "missing.json"), "missing", /cannot read the schema file/],
			[await writeSchema([1, 2], "array.json"), "array", /must be a JSON object/],
			[await writeSchema({ type: "nonsense" }, "type.json"), "bad type", /not a valid JSON Schema/],
			[
				await writeSchema({
					allOf: [{ properties: { a: { type: "string" } } }],
					unevaluatedProperties: false,
				}),
				"unevaluated",
				/unevaluatedProperties: unsupported/,
			],
			[
				await writeSchema({ type: "object", properties: { a: { $ref: "https://example.com/x.json" } } }, "ref.json"),
				"remote ref",
				/only local/,
			],
		];
		for (const [file, label, diagnostic] of cases) {
			const result = await runOmp(["--output-schema", file, "anything"]);
			expect(result.code, label).not.toBe(0);
			expect(result.stdout, label).toBe("");
			expect(result.stderr, label).toMatch(diagnostic);
		}
		expect(requests).toHaveLength(0);
	});

	test("a fenced or prose-wrapped answer is corrected in-session, then accepted", async () => {
		const schema = await writeSchema(rewriteSchema);
		script = [
			{ text: `Here you go:\n\`\`\`json\n${JSON.stringify({ path: "a.ts", code: "x" })}\n\`\`\`` },
			{ text: JSON.stringify({ path: "a.ts", code: "x" }) },
		];
		const result = await runOmp(["--output-schema", schema, "emit"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ path: "a.ts", code: "x" });
		expect(requests).toHaveLength(2);
		expect(result.stderr).toContain("correction 1/2");
	});

	test("exhausted correction exits 1 with empty stdout, and an earlier side-effecting tool is not replayed", async () => {
		const schema = await writeSchema(rewriteSchema);
		const marker = path.join(root, "project", "side-effect.txt");
		script = [
			{ tool: "write", args: { path: marker, content: "once" } },
			{ text: JSON.stringify({ path: "a.ts" }) },
			{ text: JSON.stringify({ path: "a.ts" }) },
			{ text: JSON.stringify({ code: "y" }) },
		];
		const result = await runOmp(["--output-schema", schema, "write the marker then answer"]);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("--output-schema: no valid result");
		expect(result.stderr).toContain("does not match the schema");
		expect(await Bun.file(marker).text()).toBe("once");
		// 1 tool turn + the answer + exactly 2 corrections; the model is never asked a fourth time.
		expect(requests).toHaveLength(4);
		// Tool turn offers tools; the answer follows the tool result; corrections run with every tool disabled.
		expect(requests[0]!.toolNames).toContain("write");
		expect(requests[1]!.lastRole).toBe("tool");
		for (const correction of requests.slice(2)) expect(correction.toolNames).toEqual([]);
		expect(script).toHaveLength(0);
	});

	test("an empty final response never succeeds", async () => {
		const schema = await writeSchema(rewriteSchema);
		script = [{ text: "" }, { text: "" }, { text: "" }];
		const result = await runOmp(["--output-schema", schema, "emit"]);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toContain("--output-schema: no valid result");
	});

	test("truncation (finish_reason length) exits nonzero without output and is not retried", async () => {
		const schema = await writeSchema(rewriteSchema);
		script = [{ text: '{"path":"a.ts","code":"par', finish: "length" }, { text: "unused" }];
		const result = await runOmp(["--output-schema", schema, "emit"]);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(/truncated|length/i);
		expect(requests).toHaveLength(1);
	});

	test("a provider refusal (content_filter) exits nonzero without output", async () => {
		const schema = await writeSchema(rewriteSchema);
		script = [{ text: "", finish: "content_filter" }];
		const result = await runOmp(["--output-schema", schema, "emit"]);
		expect(result.code).toBe(1);
		expect(result.stdout).toBe("");
		expect(result.stderr).toMatch(/content_filter|refus/i);
	});

	test("format is an annotation: a shape-valid, format-invalid value is accepted", async () => {
		const schema = await writeSchema({
			type: "object",
			properties: { email: { type: "string", format: "email" } },
			required: ["email"],
		});
		script = [{ text: JSON.stringify({ email: "not-an-email" }) }];
		const result = await runOmp(["--output-schema", schema, "emit"]);
		expect(result.code).toBe(0);
		expect(JSON.parse(result.stdout)).toEqual({ email: "not-an-email" });
	});

	test("it cannot combine with --mode json", async () => {
		const schema = await writeSchema(rewriteSchema);
		const result = await runOmp(["--mode", "json", "--output-schema", schema, "emit"]);
		expect(result.code).not.toBe(0);
		expect(result.stderr).toContain("--output-schema applies to plain print mode");
		expect(requests).toHaveLength(0);
	});

	test("without the flag, print mode output is unchanged", async () => {
		script = [{ text: "plain answer, not JSON" }];
		const result = await runOmp(["say something"]);
		expect(result.code).toBe(0);
		expect(result.stdout).toBe("plain answer, not JSON\n");
	});
});
