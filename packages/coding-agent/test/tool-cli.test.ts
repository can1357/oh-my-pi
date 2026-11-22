import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	ToolCliUsageError,
	TOOL_CLI_INPUT_LIMIT_BYTES,
	parseToolArgs,
	renderToolHelp,
	runToolCli,
	type ToolCliDefinition,
	type ToolCliHost,
} from "../src/exec/tool-cli";

const schema = {
	type: "object",
	properties: {
		mode: { type: "string", enum: ["fast", "safe"], description: "Execution mode." },
		count: { type: "integer", description: "Number of passes." },
		settings: {
			type: "object",
			properties: {
				label: { type: "string", description: "Nested label." },
				enabled: { type: "boolean" },
			},
			required: ["label"],
		},
		tags: { type: "array", items: { type: "string", enum: ["one", "two"] } },
	},
	required: ["mode", "settings"],
};

const parse = (argv: string[], stdin = "") => parseToolArgs(schema, argv, { cwd: "/", stdin });

const intentSchema = {
	type: "object",
	properties: {
		i: { type: "string", description: "Short present-participle intent for this call." },
		text: { type: "string" },
	},
	required: ["i", "text"],
};

function createRunnerHost(): { host: ToolCliHost; calls: Record<string, unknown>[]; definition: ToolCliDefinition } {
	const calls: Record<string, unknown>[] = [];
	const definition: ToolCliDefinition = { name: "fixture", description: "Run fixture.", schema: intentSchema };
	const host: ToolCliHost = {
		async definition(name) {
			if (name !== definition.name) throw new Error("unknown command");
			return definition;
		},
		async call(_name, args) {
			calls.push(args);
			return { stdout: `${JSON.stringify(args)}\n`, stderr: "", exitCode: 0 };
		},
	};
	return { host, calls, definition };
}

describe("schema-derived tool command argument binding", () => {
	it("binds required scalar positionals, flags, booleans, arrays, and dotted keys", async () => {
		expect(
			await parse([
				"safe",
				"--count",
				"4",
				"--settings.label=fixture",
				"--settings.enabled",
				"--tags",
				"one",
				"--tags=two",
			]),
		).toEqual({
			mode: "safe",
			count: 4,
			settings: { label: "fixture", enabled: true },
			tags: ["one", "two"],
		});
		expect(await parse(["safe", "--settings.label", "fixture", "--no-settings.enabled"])).toEqual({
			mode: "safe",
			settings: { label: "fixture", enabled: false },
		});
	});

	it("rejects malformed scalars and enum members", async () => {
		await expect(parse(["bogus"])).rejects.toBeInstanceOf(ToolCliUsageError);
		await expect(parse(["--count", "1.5"])).rejects.toBeInstanceOf(ToolCliUsageError);
		await expect(parse(["--count=abc"])).rejects.toBeInstanceOf(ToolCliUsageError);
		await expect(parse(["safe", "--settings.enabled=maybe", "--settings.label", "ok"])).rejects.toBeInstanceOf(
			ToolCliUsageError,
		);
		const numberSchema = { type: "object", properties: { ratio: { type: "number" } } };
		await expect(parseToolArgs(numberSchema, ["--ratio", "x"], { cwd: "/", stdin: "" })).rejects.toBeInstanceOf(
			ToolCliUsageError,
		);
		expect(await parseToolArgs(numberSchema, ["--ratio", "0.5"], { cwd: "/", stdin: "" })).toEqual({ ratio: 0.5 });
	});

	it("resolves no-prefixed booleans and keeps negation collisions JSON-only", async () => {
		const collisionSchema = {
			type: "object",
			properties: {
				cache: { type: "boolean" },
				no_cache: { type: "boolean" },
			},
		};
		await expect(parseToolArgs(collisionSchema, ["--no-cache"], { cwd: "/", stdin: "" })).rejects.toBeInstanceOf(
			ToolCliUsageError,
		);
		expect(
			await parseToolArgs(collisionSchema, ["--json", '{"cache":false,"no_cache":true}'], {
				cwd: "/",
				stdin: "",
			}),
		).toEqual({ cache: false, no_cache: true });

		const noPrefixedSchema = { type: "object", properties: { no_cache: { type: "boolean" } } };
		expect(await parseToolArgs(noPrefixedSchema, ["--no-cache"], { cwd: "/", stdin: "" })).toEqual({
			no_cache: true,
		});
		expect(await parseToolArgs(noPrefixedSchema, ["--no-no-cache"], { cwd: "/", stdin: "" })).toEqual({
			no_cache: false,
		});
		const ordinarySchema = { type: "object", properties: { cache: { type: "boolean" } } };
		expect(await parseToolArgs(ordinarySchema, ["--no-cache"], { cwd: "/", stdin: "" })).toEqual({
			cache: false,
		});
		expect(await parseToolArgs(ordinarySchema, ["--cache=false"], { cwd: "/", stdin: "" })).toEqual({
			cache: false,
		});
	});

	it("reserves root help/json names for CLI metadata while nested names remain flags", async () => {
		const reservedSchema = {
			type: "object",
			properties: {
				help: { type: "boolean" },
				json: { type: "boolean" },
				nested: {
					type: "object",
					properties: { help: { type: "boolean" }, json: { type: "boolean" } },
				},
			},
			required: ["help", "json"],
		};
		expect(
			await parseToolArgs(
				reservedSchema,
				["--json", '{"help":true,"json":false}', "--nested.help", "--nested.json=false"],
				{ cwd: "/", stdin: "" },
			),
		).toEqual({ help: true, json: false, nested: { help: true, json: false } });
	});

	it("makes colliding schema-derived flag names JSON-only", async () => {
		const collisionSchema = {
			type: "object",
			properties: {
				foo_bar: { type: "string" },
				"foo-bar": { type: "string" },
				"a.b": { type: "string" },
				a: { type: "object", properties: { b: { type: "string" } }, required: ["b"] },
			},
			required: ["foo_bar", "foo-bar", "a.b", "a"],
		};
		await expect(
			parseToolArgs(collisionSchema, ["--foo-bar", "wrong"], { cwd: "/", stdin: "" }),
		).rejects.toBeInstanceOf(ToolCliUsageError);
		expect(
			await parseToolArgs(
				collisionSchema,
				["--json", '{"foo_bar":"one","foo-bar":"two","a.b":"root","a":{"b":"nested"}}'],
				{ cwd: "/", stdin: "" },
			),
		).toEqual({ foo_bar: "one", "foo-bar": "two", "a.b": "root", a: { b: "nested" } });
	});

	it("reserves positionals already populated by a flag and rejects surplus literals", async () => {
		expect(await parse(["--mode", "fast", "--settings.label", "ok"])).toEqual({
			mode: "fast",
			settings: { label: "ok" },
		});
		await expect(parse(["fast", "extra", "--settings.label", "ok"])).rejects.toBeInstanceOf(ToolCliUsageError);
		const textSchema = {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		};
		expect(await parseToolArgs(textSchema, ["--", "--not-a-flag"], { cwd: "/", stdin: "" })).toEqual({
			text: "--not-a-flag",
		});
	});

	it("deep-merges raw JSON while flags win regardless of ordering", async () => {
		expect(
			await parse([
				"--settings.enabled",
				"--json",
				'{"mode":"safe","count":2,"settings":{"label":"json","enabled":false}}',
				"--count=7",
			]),
		).toEqual({ mode: "safe", count: 7, settings: { label: "json", enabled: true } });
		await expect(parse(["--json", "[]"])).rejects.toBeInstanceOf(ToolCliUsageError);
	});

	it("preserves prototype-like JSON and dotted keys without mutating object prototypes", async () => {
		const jsonPollutionKey = "toolCliJsonPolluted";
		const rejectedPollutionKey = "toolCliRejectedPolluted";
		const dottedPollutionKey = "toolCliDottedPolluted";
		const constructorPollutionKey = "toolCliConstructorPolluted";
		const freeFormSchema = { type: "object", additionalProperties: true };
		const jsonArgs = await parseToolArgs(freeFormSchema, ["--json", `{"__proto__":{"${jsonPollutionKey}":true}}`], {
			cwd: "/",
			stdin: "",
		});
		expect(Object.getPrototypeOf(jsonArgs)).toBe(Object.prototype);
		expect(Object.hasOwn(jsonArgs, "__proto__")).toBe(true);
		expect(jsonArgs["__proto__"]).toEqual({ [jsonPollutionKey]: true });
		expect(Object.hasOwn(Object.prototype, jsonPollutionKey)).toBe(false);

		const requiredSchema = {
			type: "object",
			properties: { text: { type: "string" } },
			required: ["text"],
		};
		await expect(
			parseToolArgs(requiredSchema, ["--json", `{"__proto__":{"${rejectedPollutionKey}":true}}`], {
				cwd: "/",
				stdin: "",
			}),
		).rejects.toBeInstanceOf(ToolCliUsageError);
		expect(Object.hasOwn(Object.prototype, rejectedPollutionKey)).toBe(false);

		const dottedSchema: unknown = JSON.parse(`{
			"type":"object",
			"properties":{
				"__proto__":{"type":"object","properties":{"${dottedPollutionKey}":{"type":"boolean"}}},
				"constructor":{"type":"object","properties":{"prototype":{"type":"object","properties":{"${constructorPollutionKey}":{"type":"boolean"}}}}}
			}
		}`);
		const dottedArgs = await parseToolArgs(
			dottedSchema,
			[`----proto--.${dottedPollutionKey}`, `--constructor.prototype.${constructorPollutionKey}`],
			{ cwd: "/", stdin: "" },
		);
		expect(Object.getPrototypeOf(dottedArgs)).toBe(Object.prototype);
		expect(Object.hasOwn(dottedArgs, "__proto__")).toBe(true);
		expect(Object.hasOwn(dottedArgs, "constructor")).toBe(true);
		expect(Object.hasOwn(Object.prototype, dottedPollutionKey)).toBe(false);
		expect(Object.hasOwn(Object.prototype, constructorPollutionKey)).toBe(false);
	});

	it("uses stdin and @file as JSON or literal sources", async () => {
		const root = await fs.mkdtemp(path.join(os.tmpdir(), "tool-cli-"));
		try {
			await fs.writeFile(path.join(root, "args.json"), '{"mode":"fast","settings":{"label":"file"}}');
			await fs.writeFile(path.join(root, "mode.txt"), "safe\r\n");
			await fs.writeFile(path.join(root, "huge.txt"), Buffer.alloc(TOOL_CLI_INPUT_LIMIT_BYTES + 1, 0x61));
			expect(await parseToolArgs(schema, ["@args.json", "--count", "3"], { cwd: root, stdin: "" })).toEqual({
				mode: "fast",
				count: 3,
				settings: { label: "file" },
			});
			expect(
				await parseToolArgs(schema, ["@mode.txt", "--settings.label", "text"], { cwd: root, stdin: "" }),
			).toEqual({ mode: "safe", settings: { label: "text" } });
			expect(await parse(["-", "--settings.label", "stdin"], "fast\n")).toEqual({
				mode: "fast",
				settings: { label: "stdin" },
			});
			await expect(parseToolArgs(schema, ["@huge.txt"], { cwd: root, stdin: "" })).rejects.toBeInstanceOf(
				ToolCliUsageError,
			);
		} finally {
			await fs.rm(root, { recursive: true, force: true });
		}
	});

	it("cancels an in-flight argument reader without invoking a tool", async () => {
		const started = Promise.withResolvers<void>();
		const controller = new AbortController();
		const pending = parseToolArgs(
			{ type: "object", properties: { text: { type: "string" } }, required: ["text"] },
			["@endless"],
			{
				cwd: "/",
				stdin: "",
				signal: controller.signal,
				readSource: async (_absolutePath, signal) => {
					started.resolve();
					const blocked = Promise.withResolvers<string>();
					signal?.addEventListener("abort", () => blocked.reject(signal.reason), { once: true });
					return blocked.promise;
				},
			},
		);
		await started.promise;
		controller.abort(new DOMException("tool argument read aborted", "AbortError"));
		await expect(pending).rejects.toMatchObject({
			name: "AbortError",
			message: "tool argument read aborted",
		});
	});

	it("binds a JSON source to the sole required free-form object", async () => {
		const objectSchema = {
			type: "object",
			properties: { query: { type: "object" }, limit: { type: "integer" } },
			required: ["query"],
		};
		expect(
			await parseToolArgs(objectSchema, ["-", "--limit", "5"], {
				cwd: "/",
				stdin: '{"where":{"id":1}}',
			}),
		).toEqual({ query: { where: { id: 1 } }, limit: 5 });
		expect(await parseToolArgs(objectSchema, ["-"], { cwd: "/", stdin: '{"query":{"id":1}}' })).toEqual({
			query: { id: 1 },
		});
	});

	it("normalizes local refs, nullable combinators, and allOf objects", async () => {
		const composed = {
			type: "object",
			properties: {
				action: { $ref: "#/$defs/Action" },
				app: { anyOf: [{ $ref: "#/$defs/App" }, { type: "null" }] },
				enabled: { oneOf: [{ type: "boolean" }, { type: "null" }] },
			},
			required: ["action"],
			$defs: {
				Action: {
					oneOf: [
						{ const: "open", type: "string" },
						{ const: "run", type: "string" },
					],
				},
				App: {
					type: "object",
					allOf: [{ properties: { cdp_url: { type: "string" } } }, { properties: { relay: { type: "boolean" } } }],
				},
			},
		};
		expect(
			await parseToolArgs(composed, ["run", "--app.cdp-url", "http://localhost", "--app.relay", "--enabled"], {
				cwd: "/",
				stdin: "",
			}),
		).toEqual({ action: "run", app: { cdp_url: "http://localhost", relay: true }, enabled: true });
	});

	it("treats only the exact harness intent description as harness-owned", async () => {
		const nearMiss = {
			type: "object",
			properties: {
				i: { type: "string", description: "Short present-participating intent for this call." },
				text: { type: "string" },
			},
			required: ["i", "text"],
		};
		expect(await parseToolArgs(nearMiss, ["one", "two"], { cwd: "/", stdin: "" })).toEqual({
			i: "one",
			text: "two",
		});
		const exact = {
			type: "object",
			properties: {
				i: { type: "string", description: "Short present-participle intent for this call." },
				text: { type: "string" },
			},
			required: ["i", "text"],
		};
		expect(await parseToolArgs(exact, ["hello"], { cwd: "/", stdin: "" })).toEqual({ text: "hello" });
	});
});

describe("tool command help and runner", () => {
	it("renders the usage line, positional, boolean, and repeatable array from the schema", () => {
		const help = renderToolHelp({
			name: "fixture",
			schema: {
				type: "object",
				properties: {
					text: { type: "string", description: "Text to handle." },
					force: { type: "boolean" },
					tags: { type: "array", items: { type: "string", enum: ["one", "two"] } },
				},
				required: ["text"],
			},
		});
		expect(help).toContain("Usage:\n  fixture <text> [OPTIONS] [@FILE] [-]");
		expect(help).toContain("  <text> <STRING>  Text to handle.");
		expect(help).toContain("--force / --no-force");
		expect(help).toContain("--tags {one|two}...");
	});

	it("renders help from the live definition without invoking the command", async () => {
		const { host, calls, definition } = createRunnerHost();
		expect(await runToolCli({ name: "fixture", argv: ["--help"], cwd: "/", stdin: "" }, host)).toEqual({
			stdout: renderToolHelp(definition),
			stderr: "",
			exitCode: 0,
		});
		expect(await runToolCli({ name: "fixture", argv: ["-h"], cwd: "/", stdin: "" }, host)).toEqual({
			stdout: renderToolHelp(definition),
			stderr: "",
			exitCode: 0,
		});
		expect(calls).toEqual([]);
	});

	it("executes with parsed arguments and the injected protocol intent", async () => {
		const { host, calls } = createRunnerHost();
		const result = await runToolCli({ name: "fixture", argv: ["hello"], cwd: "/", stdin: "" }, host);
		expect(result).toMatchObject({ exitCode: 0, stderr: "" });
		expect(calls).toEqual([{ text: "hello", i: "Invoking fixture" }]);
	});

	it("reports missing required arguments with the command help hint", async () => {
		const { host, calls } = createRunnerHost();
		expect(await runToolCli({ name: "fixture", argv: [], cwd: "/", stdin: "" }, host)).toEqual({
			stdout: "",
			stderr: "fixture: missing required argument `text`\nfixture: run `fixture --help`\n",
			exitCode: 2,
		});
		expect(calls).toEqual([]);
	});

	it("maps unknown flags to usage errors naming the command", async () => {
		const { host, calls } = createRunnerHost();
		expect(await runToolCli({ name: "fixture", argv: ["--bogus"], cwd: "/", stdin: "" }, host)).toEqual({
			stdout: "",
			stderr: "fixture: unknown flag `--bogus`\nfixture: run `fixture --help`\n",
			exitCode: 2,
		});
		expect(calls).toEqual([]);
	});

	it("rejects help combined with invocation arguments", async () => {
		const { host, calls } = createRunnerHost();
		expect(await runToolCli({ name: "fixture", argv: ["hello", "--help"], cwd: "/", stdin: "" }, host)).toEqual({
			stdout: "",
			stderr: "fixture: --help cannot be combined with invocation arguments\n",
			exitCode: 2,
		});
		expect(calls).toEqual([]);
	});

	it("maps lookup and execution failures to exit code 1", async () => {
		const unknownHost: ToolCliHost = {
			async definition() {
				throw new Error("unknown command");
			},
			async call() {
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		};
		expect(await runToolCli({ name: "fixture", argv: [], cwd: "/", stdin: "" }, unknownHost)).toEqual({
			stdout: "",
			stderr: "fixture: unknown command\n",
			exitCode: 1,
		});
		const failingHost: ToolCliHost = {
			async definition(name) {
				return { name, schema: { type: "object", properties: {} } };
			},
			async call() {
				throw new Error("tool exploded");
			},
		};
		expect(await runToolCli({ name: "fixture", argv: [], cwd: "/", stdin: "" }, failingHost)).toEqual({
			stdout: "",
			stderr: "fixture: tool exploded\n",
			exitCode: 1,
		});
	});

	it("rethrows abort errors instead of reporting them", async () => {
		const aborted = new DOMException("stopped", "AbortError");
		const abortedHost: ToolCliHost = {
			async definition() {
				throw aborted;
			},
			async call() {
				return { stdout: "", stderr: "", exitCode: 0 };
			},
		};
		await expect(runToolCli({ name: "fixture", argv: [], cwd: "/", stdin: "" }, abortedHost)).rejects.toBe(aborted);

		const toolAbort = new Error("interrupted");
		toolAbort.name = "ToolAbortError";
		const runningHost: ToolCliHost = {
			async definition(name) {
				return { name, schema: { type: "object", properties: {} } };
			},
			async call() {
				throw toolAbort;
			},
		};
		await expect(runToolCli({ name: "fixture", argv: [], cwd: "/", stdin: "" }, runningHost)).rejects.toBe(toolAbort);
	});
});
