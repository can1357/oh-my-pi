import * as fs from "node:fs";
import { describe, expect, it } from "bun:test";
import { $which, TempDir } from "@oh-my-pi/pi-utils";
import { artifactRequestOf } from "../../../src/eval/artifact-wire";
import { PYTHON_PRELUDE } from "../../../src/eval/py/prelude";
import { artifactReadBridge } from "../../helpers/artifact-read-bridge";
const pythonPath = Bun.env.PYTHON ?? ($which("python3") ? "python3" : "python");

async function runPrelude(
	code: string,
	env: Record<string, string>,
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
	const prelude = PYTHON_PRELUDE.replace(
		"from __future__ import annotations",
		"from __future__ import annotations\n__omp_emit_status = __omp_emit_image = lambda *args, **kwargs: None",
	);
	const script = `${prelude}\n${code}`;
	// The full prelude exceeds Windows' ~32k `python -c` command-line limit
	// (ENAMETOOLONG); a script file behaves identically on every platform.
	const dir = await TempDir.create("@omp-py-prelude-");
	try {
		const scriptPath = dir.join("script.py");
		await Bun.write(scriptPath, script);
		const proc = Bun.spawn([pythonPath, scriptPath], {
			stdout: "pipe",
			stderr: "pipe",
			env: { ...process.env, ...env },
		});
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		// Python's text-mode stdout emits \r\n on Windows.
		return { stdout: stdout.replaceAll("\r\n", "\n"), stderr: stderr.replaceAll("\r\n", "\n"), exitCode };
	} finally {
		await dir.remove();
	}
}

describe("python prelude", () => {
	it("infers eval tool schemas and replaces definitions by name", async () => {
		const result = await runPrelude(
			[
				"from typing import Annotated, Literal, Optional",
				"@tool",
				"def word_count(text: Annotated[str, 'Text to split'], sep: Literal[' ', ','] = ' ', limit: Optional[int] = None) -> dict:",
				'    """Count words in text."""',
				"    return {'count': len(text.split(sep))}",
				"first = __omp_tools__['word_count'].describe()",
				"@tool(name='word_count', description='Replacement')",
				"def replacement(text: str) -> dict:",
				"    return {'count': 1}",
				"print(json.dumps({'first': first, 'current': __omp_tools__['word_count'].describe(), 'defined': tool.defined()}, sort_keys=True))",
				"print(tool.undefine('word_count'), tool.defined())",
			].join("\n"),
			{},
		);

		expect(result.exitCode).toBe(0);
		const lines = result.stdout.trim().split("\n");
		const value = JSON.parse(lines[0] ?? "{}");
		expect(value.first).toEqual({
			name: "word_count",
			description: "Count words in text.",
			parameters: {
				type: "object",
				properties: {
					text: { type: "string", description: "Text to split" },
					sep: { enum: [" ", ","], default: " " },
					limit: { anyOf: [{ type: "integer" }, { type: "null" }], default: null },
				},
				required: ["text"],
				additionalProperties: false,
			},
		});
		expect(value.current.description).toBe("Replacement");
		expect(value.defined).toEqual(["word_count"]);
		expect(lines[1]).toBe("True []");
	});

	it("appends line selectors to delegated URI paths", async () => {
		const requests: unknown[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				requests.push(await request.json());
				return Response.json({
					ok: true,
					value: { text: "resource contents", details: { resolvedPath: "/tmp/resource.txt" } },
				});
			},
		});

		try {
			const result = await runPrelude(`print(read("mcp://server/resource", 10, 5))`, {
				PI_TOOL_BRIDGE_URL: server.url.toString(),
				PI_TOOL_BRIDGE_TOKEN: "test-token",
				PI_TOOL_BRIDGE_SESSION: "test-session",
			});

			expect(result).toEqual({
				stdout: "resource contents\n",
				stderr: "",
				exitCode: 0,
			});
			expect(requests).toEqual([
				{
					session: "test-session",
					// No cell, so no run: the host refuses that for everything
					// but the questions that belong to the session.
					run: "",
					name: "read",
					args: { path: "mcp://server/resource:10-14" },
				},
			]);
		} finally {
			server.stop(true);
		}
	});

	async function runWithReadBridge(
		code: string,
		env: Record<string, string>,
		readTool: (args: { path: string }, name?: string) => Promise<unknown>,
	): Promise<{ stdout: string; stderr: string; requests: unknown[] }> {
		const requests: unknown[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				const body = (await request.json()) as { name?: string; args: { path: string } };
				requests.push(body);
				return Response.json({ ok: true, value: await readTool(body.args, body.name) });
			},
		});
		try {
			// No inherited artifacts root (an Eval cell running these tests has one); tests that want one pass it.
			const result = await runPrelude(code, {
				PI_EVAL_LOCAL_ROOTS: "{}",
				...env,
				PI_TOOL_BRIDGE_URL: server.url.toString(),
				PI_TOOL_BRIDGE_TOKEN: "test-token",
				PI_TOOL_BRIDGE_SESSION: "test-session",
			});
			return { stdout: result.stdout, stderr: result.stderr, requests };
		} finally {
			server.stop(true);
		}
	}

	// Over the 50 KB a bare `:raw` read inlines, with a line wider than any column cap and a trailing newline.
	const largeArtifact = ["head", "w".repeat(60_000), ...Array.from({ length: 3000 }, (_, i) => `row ${i}`), ""].join(
		"\n",
	);

	it("reads an artifact from this session's dir; empty for limit <= 0", async () => {
		using artifacts = TempDir.createSync("@omp-py-prelude-artifacts-");
		await Bun.write(artifacts.join("12.eval.log"), "first\nsecond\nthird\n");
		const { stdout, stderr, requests } = await runWithReadBridge(
			[
				`print(repr(read("artifact://12", offset=2, limit=1)))`,
				`print([read("artifact://12", limit=0), read("artifact://12", limit=-1), read("artifact://7", limit=0)])`,
			].join("\n"),
			{ PI_EVAL_LOCAL_ROOTS: JSON.stringify({ artifact: artifacts.path() }) },
			async (args, name) => {
				if (name !== "__artifacts_ready__") return { text: "from the read tool" };
				// The host resolves the id against the artifacts dir once its
				// copies have settled, and says what the file is; the kernel
				// never lists the directory and checks what it opens.
				const file = artifacts.join(`${(args as unknown as { id: string }).id}.eval.log`);
				const stat = fs.statSync(file, { bigint: true });
				return { text: file, details: { path: file, device: String(stat.dev), inode: String(stat.ino) } };
			},
		);

		expect(stderr).toBe("");
		expect(stdout).toBe("'second\\n'\n['', '', '']\n");
		// The only host call is the readiness question every artifact read
		// asks before it lists the directory: the kernel is a subprocess and
		// cannot see a copy still filling it. The bytes come from the dir.
		// One readiness question, from the one read that got as far as the
		// directory: a `limit <= 0` read answers before it looks at anything.
		expect(requests).toEqual([
			{
				name: "__artifacts_ready__",
				// `answer`: the kernel asks for the file, and only comes back
				// for the bytes if what it opens is not what it was told about.
				// The cell was given no hold, so `token` is left out: the host
				// refuses a token that is present and not a string. This answer
				// holds no pin, so there is nothing for the kernel to give back.
				args: { id: "12", op: "answer", root: artifacts.path() },
				run: "",
				session: "test-session",
			},
		]);
	});

	it("sends only artifact requests the host's wire parser accepts whole", async () => {
		// The kernel writes these requests by hand, where no compiler checks them
		// against the wire's types: this is what keeps the two in step.
		using artifacts = TempDir.createSync("@omp-py-prelude-wire-");
		await Bun.write(artifacts.join("12.eval.log"), "twelve\n");
		await Bun.write(artifacts.join("13.eval.log"), "thirteen\n");
		const { stdout, stderr, requests } = await runWithReadBridge(
			[
				// `answer`, then `release` after the read.
				`print(repr(read("artifact://12")))`,
				// `answer` about another object than the name reaches now, so `take`.
				`print(repr(read("artifact://13")))`,
				// `locate`: the path goes on to the read tool with its selector.
				`print(repr(read("artifact://12:1-1")))`,
			].join("\n"),
			{ PI_EVAL_LOCAL_ROOTS: JSON.stringify({ artifact: artifacts.path() }) },
			async (args, name) => {
				if (name === "read") return { text: `read tool: ${args.path}` };
				const asked = args as unknown as { op: string; id?: string };
				if (asked.op === "release") return null;
				const id = asked.op === "take" ? "13" : asked.id;
				const file = artifacts.join(`${id}.eval.log`);
				const stat = fs.statSync(file, { bigint: true });
				const inode = id === "13" ? "0" : String(stat.ino);
				const details = { path: file, device: String(stat.dev), inode };
				if (asked.op === "take") return { text: file, details: { ...details, text: "held thirteen\n" } };
				if (asked.op === "locate") return { text: file, details };
				return { text: file, details: { ...details, file: `pin-${id}` } };
			},
		);

		expect(stderr).toBe("");
		expect(stdout).toBe(`'twelve\\n'\n'held thirteen\\n'\n'read tool: ${artifacts.join("12.eval.log")}:1-1'\n`);
		const sent = requests
			.map(request => request as { name?: string; args: Record<string, unknown> })
			.filter(request => request.name === "__artifacts_ready__")
			.map(request => request.args);
		expect(sent.map(args => args.op)).toEqual(["answer", "release", "answer", "take", "locate"]);
		// Whole: nothing required missing, nothing the kernel sends dropped
		// except the `null` it sends for a token it does not have.
		for (const args of sent) {
			const present = Object.fromEntries(Object.entries(args).filter(([, value]) => value !== null));
			// Compared as a value: what arrived is the question, not what its type says.
			const parsed: unknown = artifactRequestOf(args);
			expect(parsed).toEqual(present);
		}
	});

	it("reads an artifact another session holds in full, however large, through the read tool", async () => {
		using tmp = TempDir.createSync("@omp-py-prelude-artifact-fallback-");
		await Bun.write(tmp.join("owner", "7.bash.log"), largeArtifact);
		await Bun.write(tmp.join("own", "12.eval.log"), "this session's");
		const out = tmp.join("out.txt");
		const { stdout, stderr, requests } = await runWithReadBridge(
			[
				`open(${JSON.stringify(out)}, "w", newline="").write(read("artifact://7"))`,
				`print(repr(read("artifact://7", offset=3, limit=2)))`,
				`print(read("artifact://7", offset=3) == "".join(f"row {i}\\n" for i in range(3000)))`,
			].join("\n"),
			{ PI_EVAL_LOCAL_ROOTS: JSON.stringify({ artifact: tmp.join("own") }) },
			artifactReadBridge(tmp.path(), tmp.join("owner")),
		);

		expect(stderr).toBe("");
		expect(await Bun.file(out).text()).toBe(largeArtifact);
		expect(stdout).toBe("'row 0\\nrow 1\\n'\nTrue\n");
		expect(requests.filter(request => (request as { name?: string }).name !== "__artifacts_ready__")).toMatchObject([
			{ name: "read", args: { path: "artifact://7:raw:1-1" } },
			{ name: "read", args: { path: "artifact://7:raw:1-1" } },
			{ name: "read", args: { path: "artifact://7:raw:1-1" } },
		]);
	});

	it("reads an artifact in full through the read tool when no artifacts dir was injected", async () => {
		using tmp = TempDir.createSync("@omp-py-prelude-artifact-no-root-");
		await Bun.write(tmp.join("12.eval.log"), largeArtifact);
		const out = tmp.join("out.txt");
		const { stderr, requests } = await runWithReadBridge(
			`open(${JSON.stringify(out)}, "w", newline="").write(read("artifact://12"))`,
			{},
			artifactReadBridge(tmp.path(), tmp.path()),
		);

		expect(stderr).toBe("");
		expect(await Bun.file(out).text()).toBe(largeArtifact);
		expect(requests).toMatchObject([{ name: "read", args: { path: "artifact://12:raw:1-1" } }]);
	});

	it("returns a replacement read tool's text when it names no artifact file", async () => {
		// An extension's same-name `read` replacement returns its own content without the built-in's `details`.
		const { stdout, stderr, requests } = await runWithReadBridge(
			[`print(read("artifact://12"))`, `print(read("artifact://12", offset=2, limit=2))`].join("\n"),
			{},
			async args => ({ text: `replaced ${args.path}` }),
		);

		expect(stderr).toBe("");
		expect(stdout).toBe("replaced artifact://12:raw\nreplaced artifact://12:raw:2-3\n");
		expect(requests).toMatchObject([
			{ name: "read", args: { path: "artifact://12:raw:1-1" } },
			{ name: "read", args: { path: "artifact://12:raw" } },
			{ name: "read", args: { path: "artifact://12:raw:1-1" } },
			{ name: "read", args: { path: "artifact://12:raw:2-3" } },
		]);
	});

	it("bypasses discovered proxies for loopback bridge calls", async () => {
		let proxyRequests = 0;
		const bridge = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				const body = (await request.json()) as { name?: string; args?: { path?: string } };
				return Response.json({
					ok: true,
					value: body.args?.path,
				});
			},
		});
		const proxy = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => {
				proxyRequests++;
				return new Response("proxy intercepted", { status: 502 });
			},
		});

		try {
			const proxyUrl = proxy.url.toString();
			// urllib also reads macOS SystemConfiguration; environment injection
			// is the hermetic equivalent for this subprocess test.
			const result = await runPrelude(
				[
					"async def main():",
					'    paths = ["one.ts", "two.ts", "three.ts"]',
					"    results = []",
					"    for path in paths:",
					'        results.append(await tool.read({"path": path}))',
					"    print(results)",
					"asyncio.run(main())",
				].join("\n"),
				{
					PI_TOOL_BRIDGE_URL: bridge.url.toString(),
					PI_TOOL_BRIDGE_TOKEN: "test-token",
					PI_TOOL_BRIDGE_SESSION: "test-session",
					HTTP_PROXY: proxyUrl,
					http_proxy: proxyUrl,
					ALL_PROXY: proxyUrl,
					all_proxy: proxyUrl,
					NO_PROXY: "",
					no_proxy: "",
				},
			);

			expect(result).toEqual({
				stdout: "['one.ts', 'two.ts', 'three.ts']\n",
				stderr: "",
				exitCode: 0,
			});
			expect(proxyRequests).toBe(0);
		} finally {
			bridge.stop(true);
			proxy.stop(true);
		}
	});
});

describe("python workpool model selection", () => {
	it("forwards an exact model selector and preserves omission through the real Python bridge", async () => {
		const requests: unknown[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				requests.push(await request.json());
				return Response.json({ ok: true, value: { name: "chosen", agent: "scout", limit: 2 } });
			},
		});
		try {
			const result = await runPrelude('workpool("scout", model="p/chosen:high")\nworkpool("scout")', {
				PI_TOOL_BRIDGE_URL: server.url.toString(),
				PI_TOOL_BRIDGE_TOKEN: "test-token",
				PI_TOOL_BRIDGE_SESSION: "test-session",
			});
			expect(result.stderr).toBe("");
			expect(result.exitCode).toBe(0);
			expect(requests).toEqual([
				{
					session: "test-session",
					// Outside a cell the kernel sends an empty run, which the host refuses
					// for everything but the questions that belong to the session.
					run: "",
					name: "__workpool__",
					args: { op: "create", agent: "scout", model: "p/chosen:high" },
				},
				{ session: "test-session", run: "", name: "__workpool__", args: { op: "create", agent: "scout" } },
			]);
		} finally {
			server.stop(true);
		}
	});
});
