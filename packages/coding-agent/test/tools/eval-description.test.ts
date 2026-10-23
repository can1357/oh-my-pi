import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Tool as AiTool } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import { JsRuntime, type RuntimeHooks } from "@oh-my-pi/pi-coding-agent/eval/js/shared/runtime";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import { disposeAllKernelSessions, executePython } from "@oh-my-pi/pi-coding-agent/eval/py/executor";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool, getEvalDocTopics, getEvalToolDescription } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";
import { TempDir } from "@oh-my-pi/pi-utils";

import { cfgEvalPy } from "@oh-my-pi/pi-coding-agent/eval/settings";
import { cfgTaskMaxRecursionDepth } from "@oh-my-pi/pi-coding-agent/task/settings";

function makeSession(opts: {
	spawns?: string | null;
	backends?: Record<string, boolean>;
	preludes?: () => readonly EvalPreludeDefinition[];
	taskDepth?: number;
	maxRecursionDepth?: number;
	readActive?: boolean;
}): ToolSession {
	const settings = Settings.isolated(opts.backends);
	if (opts.maxRecursionDepth !== undefined) cfgTaskMaxRecursionDepth.set(settings, opts.maxRecursionDepth);
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => opts.spawns ?? "*",
		taskDepth: opts.taskDepth,
		isToolActive: (name: string) => name !== "read" || opts.readActive !== false,
		...(opts.preludes ? { getEvalPreludes: opts.preludes } : {}),
		settings,
	} as unknown as ToolSession;
}

/** Pull the model-facing cell-schema fields (sorted `language` enum + descriptions) from the flat wire schema. */
function wireCellFields(tool: EvalTool): {
	languages: string[];
	languageDescription?: string;
	codeDescription?: string;
} {
	const wire = toolWireSchema(tool as unknown as AiTool) as {
		properties?: {
			language?: { enum?: string[]; const?: string; description?: string };
			code?: { description?: string };
		};
	};
	const props = wire.properties;
	const language = props?.language;
	const languages = Array.isArray(language?.enum)
		? [...language.enum].sort()
		: typeof language?.const === "string"
			? [language.const]
			: [];
	return {
		languages,
		languageDescription: language?.description,
		codeDescription: props?.code?.description,
	};
}

describe("eval tool description", () => {
	it("drops the agents topic but keeps wait() when the session forbids spawning", () => {
		// Subagents with spawns: undefined (resolved to "") cannot launch tasks.
		// wait() remains usable with completion() handles.
		const options = { py: true, js: true, spawns: false };
		const text = getEvalToolDescription(options);
		expect(text).not.toContain("xd://eval/agents");
		expect(text).not.toContain("workpool(");
		expect(text).toContain("wait(handles");
		expect(getEvalDocTopics(options).agents).toBeUndefined();
	});

	it("EvalTool topics reflect spawn policy from the session", () => {
		expect(new EvalTool(makeSession({ spawns: "*" })).docTopics().agents).toContain("agent(prompt");
		expect(new EvalTool(makeSession({ spawns: "" })).docTopics().agents).toBeUndefined();
	});

	it("drops the agents topic but keeps wait() when recursion depth is exhausted", () => {
		const belowCap = new EvalTool(makeSession({ taskDepth: 1, maxRecursionDepth: 2 }));
		const atCap = new EvalTool(makeSession({ taskDepth: 2, maxRecursionDepth: 2 }));
		const spawningDisabled = new EvalTool(makeSession({ taskDepth: 0, maxRecursionDepth: 0 }));

		expect(belowCap.docTopics().agents).toContain("agent(prompt");
		for (const tool of [atCap, spawningDisabled]) {
			expect(tool.docTopics().agents).toBeUndefined();
			expect(tool.description).not.toContain("xd://eval/agents");
			expect(tool.description).toContain("wait(handles");
		}
	});

	it("gates only tool-definition guidance, not budget or completion", () => {
		const enabled = getEvalDocTopics({ evalTools: true });
		const disabled = getEvalDocTopics({ evalTools: false });
		expect(getEvalToolDescription({ evalTools: true })).toContain("@tool");
		expect(enabled.helpers).toContain("tool(fn");
		expect(enabled.agents).toContain("tools?=None");
		expect(getEvalToolDescription({ evalTools: false })).not.toContain("@tool");
		expect(disabled.helpers).not.toContain("tool(fn");
		expect(disabled.helpers).toContain("budget.total");
		expect(disabled.judge).toContain("completion(prompt");
		expect(disabled.agents).not.toContain("tools?=None");
	});

	it("renders helper syntax only for available runtimes", () => {
		const jsOnly = getEvalDocTopics({ py: false, js: true });
		expect(jsOnly.helpers).toContain("%bun add");
		expect(jsOnly.helpers).not.toContain("%pip install");
		expect(jsOnly.helpers).toContain("await budget.total()");
		expect(jsOnly.helpers).toContain("tool(fn, {");
		const pyOnly = getEvalDocTopics({ py: true, js: false });
		expect(pyOnly.helpers).toContain("%pip install");
		expect(pyOnly.helpers).not.toContain("%bun add");
		expect(pyOnly.helpers).toContain("@tool / tool(fn");
		expect(pyOnly.helpers).not.toContain("await budget.total()");
	});

	it("inlines every topic when the session cannot read xd:// URLs", () => {
		const linked = new EvalTool(makeSession({})).description;
		const inlined = new EvalTool(makeSession({ readActive: false })).description;
		for (const uri of ["xd://eval/judge", "xd://eval/helpers", "xd://eval/agents"]) {
			expect(linked).toContain(uri);
			expect(inlined).not.toContain(uri);
		}
		for (const api of [
			"completion(prompt",
			"judge(state, questions",
			"budget.total",
			"tool(fn, name=",
			"agent(prompt",
		]) {
			expect(linked).not.toContain(api);
			expect(inlined).toContain(api);
		}
	});

	it("read xd://eval topics returns the moved API documentation", async () => {
		const session = makeSession({});
		const evalTool = new EvalTool(session);
		session.getToolByName = name => (name === "eval" ? (evalTool as unknown as AgentTool) : undefined);
		const readTool = new ReadTool(session);
		for (const [topic, signature] of [
			["judge", "completion(prompt"],
			["helpers", "budget.total"],
			["helpers", "%load <path>"],
		]) {
			const result = await readTool.execute("read-eval-topic", { path: `xd://eval/${topic}` });
			expect(result.content.some(part => part.type === "text" && part.text.includes(signature))).toBe(true);
		}
	});

	it("links only current enabled prelude documentation", () => {
		let enabled = true;
		const prelude: EvalPreludeDefinition = {
			name: "fixture",
			documentation: "Fixture summary line.\n\nCURRENT PRELUDE DOCUMENTATION",
			javascript: "",
			python: "",
			exports: [],
			enabled: () => enabled,
			async invoke() {
				return { content: [] };
			},
		};
		const tool = new EvalTool(makeSession({ preludes: () => [prelude] }));
		expect(tool.description).toContain("`fixture`: Fixture summary line. → `xd://eval/fixture`");
		expect(tool.description).not.toContain("CURRENT PRELUDE DOCUMENTATION");
		expect(tool.docTopics().fixture).toContain("CURRENT PRELUDE DOCUMENTATION");
		enabled = false;
		expect(tool.description).not.toContain("xd://eval/fixture");
		expect(tool.docTopics().fixture).toBeUndefined();
	});
});

describe("eval tool dynamic schema", () => {
	// resolveEvalBackends lets PI_* env flags override settings; neutralize them per-test
	// so the schema is driven purely by the isolated settings (and restore to avoid leaks).
	const EVAL_ENV_FLAGS = ["PI_PY", "PI_JS"] as const;
	let savedEnv: Record<string, string | undefined>;
	beforeEach(() => {
		savedEnv = {};
		for (const flag of EVAL_ENV_FLAGS) {
			savedEnv[flag] = Bun.env[flag];
			delete Bun.env[flag];
		}
	});
	afterEach(() => {
		for (const flag of EVAL_ENV_FLAGS) {
			const prior = savedEnv[flag];
			if (prior === undefined) delete Bun.env[flag];
			else Bun.env[flag] = prior;
		}
	});

	it("follows eval.py changes made after construction on the next schema read", () => {
		const session = makeSession({});
		const tool = new EvalTool(session);
		expect(wireCellFields(tool).languages).toEqual(["js", "py"]);
		cfgEvalPy.set(session.settings, false);
		expect(wireCellFields(tool).languages).toEqual(["js"]);
		expect(tool.examples.some(example => "call" in example && example.call.language === "py")).toBe(false);
		cfgEvalPy.set(session.settings, true);
		expect(wireCellFields(tool).languages).toEqual(["js", "py"]);
	});
});

// The description tells the model which prelude helpers need `await` by prefixing their
// signatures. A wrong marker makes the model print a pending Promise (missing `await` in JS)
// or await a plain value, so every documented marker must match whether calling that helper
// returns an awaitable. Each helper is called with side-effect-free arguments inside a temp dir.
describe("eval tool description await markers", () => {
	let tempDir: TempDir;

	beforeAll(async () => {
		tempDir = TempDir.createSync("@eval-description-await-");
		await Bun.write(path.join(tempDir.path(), "in.txt"), "probe\n");
		await Bun.write(path.join(tempDir.path(), "probe.md"), "probe\n");
	});

	afterAll(() => {
		tempDir.removeSync();
	});

	/**
	 * Helper name → whether its documented `lang` signature is prefixed with `await`, read from the prelude's
	 * `lang` block and its untagged block. A line is `signatures — note`; with both runtimes enabled the untagged
	 * block writes `python signatures; JS: js signatures`, and a line without `; JS: ` applies to both.
	 */
	function documentedAwaits(description: string, lang: "py" | "js"): Map<string, boolean> {
		const prelude = description.slice(description.indexOf("<prelude>"), description.indexOf("</prelude>"));
		const awaits = new Map<string, boolean>();
		for (const [, tag, body] of prelude.matchAll(/```(\w*)\n([\s\S]*?)\n```/g)) {
			if (tag !== lang && tag !== "") continue;
			for (const line of body.split("\n")) {
				const [signatures] = line.split(" — ");
				const [pySignatures, jsSignatures = pySignatures] = signatures.split("; JS: ");
				const langSignatures = lang === "py" ? pySignatures : jsSignatures;
				for (const match of langSignatures.matchAll(/(await\s+)?(tool\.<name>|[A-Za-z_]\w*)\(/g)) {
					awaits.set(match[2], match[1] !== undefined);
				}
			}
		}
		if (awaits.size === 0) throw new Error(`no ${lang} helper signatures in eval description`);
		return awaits;
	}

	describe("JS", () => {
		const hooks: RuntimeHooks = { onText: () => {}, onDisplay: () => {}, callTool: async () => undefined };
		let runtime: JsRuntime;

		beforeAll(() => {
			runtime = new JsRuntime({ initialCwd: tempDir.path(), sessionId: "eval-description-await-js" });
		});

		afterAll(() => {
			runtime.dispose();
		});

		for (const [mode, options] of [
			["JS only", { py: false, js: true }],
			["Python and JS", { py: true, js: true }],
		] as const) {
			it(`marks exactly the JS helpers that return awaitables with await (${mode})`, async () => {
				const documented = documentedAwaits(getEvalToolDescription(options), "js");
				const cell = `
					const dir = ${JSON.stringify(tempDir.path())};
					const probes = {
						print: () => print(),
						log: () => log("probe"),
						phase: () => phase("probe"),
						env: () => env("HOME"),
						read: () => read(dir + "/in.txt"),
						write: () => write(dir + "/out.txt", "probe"),
						output: () => output("probe"),
						wait: () => wait([]),
						"tool.<name>": () => tool.read({ path: dir + "/in.txt" }),
					};
					const probe = name => {
						if (!(name in probes)) return "no probe for " + name;
						let value;
						try {
							value = probes[name]();
						} catch (error) {
							return "threw " + error;
						}
						const awaitable = (typeof value === "object" || typeof value === "function") && typeof value?.then === "function";
						if (awaitable) Promise.resolve(value).catch(() => {});
						return awaitable;
					};
					JSON.stringify(Object.fromEntries(${JSON.stringify([...documented.keys()])}.map(name => [name, probe(name)])));
				`;
				const actual = JSON.parse((await runtime.run(cell, undefined, hooks)) as string);
				expect(actual).toEqual(Object.fromEntries(documented));
			});
		}
	});

	describe("Python", () => {
		afterAll(async () => {
			await disposeAllKernelSessions();
		});

		for (const [mode, options] of [
			["Python only", { py: true, js: false }],
			["Python and JS", { py: true, js: true }],
		] as const) {
			it(`marks exactly the Python helpers that return awaitables with await (${mode})`, async () => {
				const documented = documentedAwaits(getEvalToolDescription(options), "py");
				const code = [
					"import inspect, json, os",
					`dir = ${JSON.stringify(tempDir.path())}`,
					"probes = {",
					'    "print": lambda: print(end=""),',
					'    "log": lambda: log("probe"),',
					'    "phase": lambda: phase("probe"),',
					'    "env": lambda: env("HOME"),',
					'    "read": lambda: read(os.path.join(dir, "in.txt")),',
					'    "write": lambda: write(os.path.join(dir, "out.txt"), "probe"),',
					'    "output": lambda: output("probe"),',
					'    "wait": lambda: wait([]),',
					'    "tool.<name>": lambda: tool.read({"path": os.path.join(dir, "in.txt")}),',
					"}",
					"def probe(name):",
					"    if name not in probes:",
					'        return f"no probe for {name}"',
					"    try:",
					"        value = probes[name]()",
					"    except Exception as error:",
					'        return f"raised {type(error).__name__}: {error}"',
					"    if inspect.iscoroutine(value):",
					"        value.close()",
					"        return True",
					"    return inspect.isawaitable(value)",
					'saved_artifacts_dir = os.environ.get("PI_ARTIFACTS_DIR")',
					'os.environ["PI_ARTIFACTS_DIR"] = dir',
					"try:",
					`    res = {name: probe(name) for name in ${JSON.stringify([...documented.keys()])}}`,
					"finally:",
					"    if saved_artifacts_dir is None:",
					'        os.environ.pop("PI_ARTIFACTS_DIR", None)',
					"    else:",
					'        os.environ["PI_ARTIFACTS_DIR"] = saved_artifacts_dir',
					"print(json.dumps(res))",
				].join("\n");
				const result = await executePython(code, {
					sessionId: "eval-description-await-py",
					toolSession: makeSession({}),
					cwd: tempDir.path(),
				});
				expect(result.exitCode).toBe(0);
				expect(JSON.parse(result.output.trim())).toEqual(Object.fromEntries(documented));
			});
		}
	});
});
