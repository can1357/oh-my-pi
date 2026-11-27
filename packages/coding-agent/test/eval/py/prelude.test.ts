import { describe, expect, it } from "bun:test";
import { TempDir } from "@oh-my-pi/pi-utils";
import { runPrelude } from "./run-prelude";

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

		const lines = result.trim().split("\n");
		expect(lines).toHaveLength(2);
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

	it("infers tool schemas on Pythons without types.UnionType", async () => {
		// Python 3.9 has no types.UnionType. Hide it from the prelude's own `types`
		// name (typing itself still needs it on 3.10+), so any interpreter runs this case.
		const result = await runPrelude(
			[
				"from types import SimpleNamespace",
				"types = SimpleNamespace(**{k: v for k, v in vars(types).items() if k != 'UnionType'})",
				"from typing import Optional",
				"@tool",
				"def lookup(name: str, limit: Optional[int] = None) -> dict:",
				"    return {}",
				"print(json.dumps(__omp_tools__['lookup'].describe()['parameters'], sort_keys=True))",
			].join("\n"),
			{},
		);

		expect(JSON.parse(result)).toEqual({
			type: "object",
			properties: {
				name: { type: "string" },
				limit: { anyOf: [{ type: "integer" }, { type: "null" }], default: null },
			},
			required: ["name"],
			additionalProperties: false,
		});
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
			const result = await runPrelude(`print(await read("mcp://server/resource", 10, 5))`, {
				PI_TOOL_BRIDGE_URL: server.url.toString(),
				PI_TOOL_BRIDGE_TOKEN: "test-token",
				PI_TOOL_BRIDGE_SESSION: "test-session",
			});

			expect(result).toBe("resource contents\n");
			expect(requests).toEqual([
				{
					session: "test-session",
					run: "run",
					name: "read",
					args: { path: "mcp://server/resource:raw:10-14" },
				},
			]);
		} finally {
			server.stop(true);
		}
	});

	async function runWithReadBridge(
		code: string,
		env: Record<string, string>,
		readTool: (args: { path: string }) => Promise<unknown>,
	): Promise<{ output: string; requests: unknown[] }> {
		const requests: unknown[] = [];
		const server = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: async request => {
				const body = (await request.json()) as { args: { path: string } };
				requests.push(body);
				return Response.json({ ok: true, value: await readTool(body.args) });
			},
		});
		try {
			// No inherited local:// root (an Eval cell running these tests has one); tests that want one pass it.
			const result = await runPrelude(code, {
				PI_EVAL_LOCAL_ROOTS: "{}",
				...env,
				PI_TOOL_BRIDGE_URL: server.url.toString(),
				PI_TOOL_BRIDGE_TOKEN: "test-token",
				PI_TOOL_BRIDGE_SESSION: "test-session",
			});
			return { output: result, requests };
		} finally {
			server.stop(true);
		}
	}

	// Over the 50 KB a bare `:raw` read inlines, with a line wider than any column cap and a trailing newline.
	const largeArtifact = ["head", "w".repeat(60_000), ...Array.from({ length: 3000 }, (_, i) => `row ${i}`), ""].join(
		"\n",
	);

	it("reads a large spill local://<N>.log from the injected root without the read tool", async () => {
		using tmp = TempDir.createSync("@omp-py-prelude-spill-");
		await Bun.write(tmp.join("local", "7.log"), largeArtifact);
		const out = tmp.join("out.txt");
		const { output, requests } = await runWithReadBridge(
			[
				`open(${JSON.stringify(out)}, "w", newline="").write(read("local://7.log"))`,
				`print(repr(read("local://7.log", offset=3, limit=2)))`,
			].join("\n"),
			{ PI_EVAL_LOCAL_ROOTS: JSON.stringify({ local: tmp.join("local") }) },
			async () => ({ text: "from the read tool" }),
		);

		expect(await Bun.file(out).text()).toBe(largeArtifact);
		expect(output).toBe("'row 0\\nrow 1\\n'\n");
		expect(requests).toEqual([]);
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
					"await main()",
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

			expect(result).toBe("['one.ts', 'two.ts', 'three.ts']\n");
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
			const result = await runPrelude('_ = workpool("scout", model="p/chosen:high")\n_ = workpool("scout")', {
				PI_TOOL_BRIDGE_URL: server.url.toString(),
				PI_TOOL_BRIDGE_TOKEN: "test-token",
				PI_TOOL_BRIDGE_SESSION: "test-session",
			});
			expect(result).toBe("");
			expect(requests).toEqual([
				{
					session: "test-session",
					run: "run",
					name: "__workpool__",
					args: { op: "create", agent: "scout", model: "p/chosen:high" },
				},
				{ session: "test-session", run: "run", name: "__workpool__", args: { op: "create", agent: "scout" } },
			]);
		} finally {
			server.stop(true);
		}
	});
});
