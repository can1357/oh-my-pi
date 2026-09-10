import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import type { Tool as AiTool } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { EvalPreludeDefinition } from "@oh-my-pi/pi-coding-agent/eval/preludes";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool, getEvalDocTopics, getEvalToolDescription } from "@oh-my-pi/pi-coding-agent/tools/eval";
import { ReadTool } from "@oh-my-pi/pi-coding-agent/tools/read";

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
	it("links the agents topic and documents agent() model selection there when spawns are allowed", () => {
		expect(getEvalToolDescription({ py: true, js: true, spawns: true })).toContain("xd://eval/agents");
		const agents = getEvalDocTopics({ py: true, js: true, spawns: true }).agents;
		expect(agents).toContain("agent(prompt");
		expect(agents).toContain("ordered list of candidates");
		expect(agents).toContain("no outside fallback");
	});

	it("routes model calls, setup, budget, and defined tools to discoverable topics", () => {
		const linked = getEvalToolDescription({ py: true, js: true, evalTools: true });
		const topics = getEvalDocTopics({ py: true, js: true, evalTools: true });
		expect(linked).toContain("`completion`");
		expect(linked).toContain("xd://eval/judge");
		expect(linked).toContain("`budget`");
		expect(linked).toContain("`@tool`");
		expect(linked).toContain("xd://eval/helpers");
		for (const moved of ["completion(prompt", "budget.total", "tool(fn, name=", "%pip install"]) {
			expect(linked).not.toContain(moved);
		}
		expect(topics.judge).toContain("completion(prompt");
		expect(topics.judge).toContain("judge(state, questions)");
		expect(topics.helpers).toContain("budget.total");
		expect(topics.helpers).toContain("tool(fn");
		expect(topics.helpers).toContain("%load <path>");
		expect(topics.helpers).toContain("%pip install");
		expect(topics.helpers).toContain("%bun add");
	});

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
			"judge(state, questions)",
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

	it("advertises enabled runtimes and excludes disabled runtime examples", () => {
		const both = new EvalTool(makeSession({}));
		expect(wireCellFields(both).languages).toEqual(["js", "py"]);
		const jsOnly = new EvalTool(makeSession({ backends: { "eval.py": false, "eval.js": true } }));
		expect(wireCellFields(jsOnly).languages).toEqual(["js"]);
		expect(jsOnly.examples.every(example => "call" in example && example.call.language === "js")).toBe(true);
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
