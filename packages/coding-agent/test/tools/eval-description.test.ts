import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { Tool as AiTool } from "@oh-my-pi/pi-ai";
import { toolWireSchema } from "@oh-my-pi/pi-ai/utils/schema";
import { Settings } from "@oh-my-pi/pi-coding-agent/config/settings";
import type { ToolSession } from "@oh-my-pi/pi-coding-agent/tools";
import { EvalTool, getEvalToolDescription } from "@oh-my-pi/pi-coding-agent/tools/eval";

function makeSession(opts: { spawns?: string | null; backends?: Record<string, boolean> }): ToolSession {
	const settings = Settings.isolated();
	for (const [key, value] of Object.entries(opts.backends ?? {})) settings.set(key as never, value);
	return {
		cwd: "/tmp/eval-test",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => opts.spawns ?? "*",
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
	it("advertises agent() when spawns are allowed", () => {
		const text = getEvalToolDescription({ py: true, js: true, spawns: true });
		expect(text).toContain("agent(prompt");
	});

	it("omits agent() when the session forbids spawning", () => {
		// Subagents with spawns: undefined (resolved to "") cannot launch tasks.
		// The prelude doc must not promise a helper that always throws.
		const text = getEvalToolDescription({ py: true, js: true, spawns: false });
		expect(text).not.toContain("agent(prompt");
	});

	it("EvalTool description reflects spawn policy from the session", () => {
		const wildcard = new EvalTool(makeSession({ spawns: "*" })).description;
		const denied = new EvalTool(makeSession({ spawns: "" })).description;
		expect(wildcard).toContain("agent(prompt");
		expect(denied).not.toContain("agent(prompt");
	});

	it("hides eval-defined tool guidance when eval.tools.enabled is off", () => {
		const enabled = getEvalToolDescription({ evalTools: true });
		const disabled = getEvalToolDescription({ evalTools: false });
		expect(enabled).toContain("@tool");
		expect(enabled).toContain("tools?=None");
		expect(disabled).not.toContain("@tool");
		expect(disabled).not.toContain("tools?=None");
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

	it("advertises exactly py and js in the wire schema", () => {
		const tool = new EvalTool(makeSession({}));
		const fields = wireCellFields(tool);
		expect(fields.languages).toEqual(["js", "py"]);
		expect(fields.languageDescription).toBe('runtime: "py" for the IPython kernel, "js" for the persistent JS VM');
		expect(fields.codeDescription).toBe("code to run in this eval call, verbatim. Use top-level await freely.");
		expect(tool.summary).toBe("Execute Python or JavaScript code in an in-process eval backend");
		expect(tool.description).not.toMatch(/ruby|julia/i);
		const exampleLangs = tool.examples.map(ex => ("call" in ex ? ex.call.language : null));
		expect(exampleLangs).toEqual(["py", "py", "py"]);
	});
});
