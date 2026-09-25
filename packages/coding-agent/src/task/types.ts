import type { AgentSource } from "@oh-my-pi/pi-tui/tools/task";
export {
	TASK_SUBAGENT_PROGRESS_CHANNEL,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
} from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
export type {
	SubagentProgressPayload,
	SubagentLifecyclePayload,
} from "@oh-my-pi/pi-tui/overlays/session-observer-registry";
import { type BaseType, type } from "@oh-my-pi/omptype";
import { $env } from "@oh-my-pi/pi-utils";

import type { AgentSessionEvent } from "../session/agent-session";
import type { ConfiguredThinkingLevel } from "@oh-my-pi/pi-tui/thinking";

const parseNumber = (value: string | undefined, defaultValue: number): number => {
	if (value) {
		try {
			const number = Number.parseInt(value, 10);
			if (!Number.isNaN(number) && number > 0) {
				return number;
			}
		} catch {}
	}
	return defaultValue;
};

/** Maximum output bytes per agent */
export const MAX_OUTPUT_BYTES = parseNumber($env.PI_TASK_MAX_OUTPUT_BYTES, 500_000);

/** Maximum output lines per agent */
export const MAX_OUTPUT_LINES = parseNumber($env.PI_TASK_MAX_OUTPUT_LINES, 5000);

/** EventBus channel for raw subagent events */
export const TASK_SUBAGENT_EVENT_CHANNEL = "task:subagent:event";

/** Payload emitted on TASK_SUBAGENT_EVENT_CHANNEL */
export interface SubagentEventPayload {
	id: string;
	event: AgentSessionEvent;
}

// Keep this explicit: ArkType serializes `unknown` as a boolean subschema, which llama.cpp grammars reject.
const outputSchemaInputSchema = type("object | boolean | string | null");
// Coarse per-spawn thinking effort; must stay in sync with TASK_EFFORTS in ../thinking.
const effortRule = '"lo" | "med" | "hi"' as const;

export const taskItemSchema = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	// Explicit `isolated` must fail validation (not be silently stripped by
	// `"+": "delete"`): the lenient fallthrough then feeds the raw args to
	// execute(), where the nested-isolation preflight rejects with a clear
	// error instead of quietly running the child non-isolated. A literal
	// `false` keeps the wire schema provider-safe (`const: false`) — `never`
	// would leak `{"not": true}`, which OpenAI/Google-class schemas reject.
	// Caveat: the Google `parametersJsonSchema` normalizer degrades
	// `{const: false}` to a bare `{type: "boolean"}`, so Gemini/Vertex
	// advertise an undescribed optional `isolated` (validation still rejects
	// any explicit value via the preflight; see packages/ai normalization).
	"isolated?": "false",
	"tools?": "string[]",
	"+": "delete",
});
const taskItemSchemaIsolated = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	"tools?": "string[]",
	"isolated?": "boolean",
	"+": "delete",
});

export const taskSchema = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	"tools?": "string[]",
	"isolated?": "boolean",
	"+": "delete",
});
const taskSchemaNoIsolation = type({
	"name?": "string",
	agent: "string = 'task'",
	task: "string",
	"outputSchema?": outputSchemaInputSchema,
	"schemaMode?": '"permissive" | "strict"',
	// See taskItemSchema: an explicit `isolated` must reject, not strip.
	"isolated?": "false",
	"tools?": "string[]",
	"+": "delete",
});
const taskSchemaBatch = type({
	context: "string",
	tasks: taskItemSchemaIsolated.array(),
	// A top-level `isolated` is not part of the batch shape; a flat-form call
	// with `isolated` must reject (lenient raw-args fallthrough → preflight)
	// rather than strip and silently run the batch non-isolated.
	"isolated?": "false",
	"+": "delete",
});
const taskSchemaBatchNoIsolation = type({
	context: "string",
	tasks: taskItemSchema.array(),
	// A top-level `isolated` (flat-form key) must also reject, not strip: the
	// batch wrapper otherwise accepts `{ context, tasks[], isolated: true }`
	// with the key deleted, and the child spawns quietly run non-isolated.
	// Rejection forces the lenient raw-args fallthrough so execute() surfaces
	// the nested-isolation preflight (see taskItemSchema).
	"isolated?": "false",
	"+": "delete",
});
const ALL_TASK_SCHEMAS = [taskSchema, taskSchemaNoIsolation, taskSchemaBatch, taskSchemaBatchNoIsolation] as const;

type DynamicTaskSchema = (typeof ALL_TASK_SCHEMAS)[number];
export type TaskSchema = typeof taskSchema;
/** Active task tool parameter schema for the current isolation / batch flags */
export type TaskToolSchemaInstance = DynamicTaskSchema | BaseType;

const TASK_AGENT_NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
const taskSchemaCache = new Map<string, BaseType>();

function taskAgentSchemaRule(defaultAgent: string): string {
	const trimmed = defaultAgent.trim();
	if (TASK_AGENT_NAME_PATTERN.test(trimmed)) {
		return `string = '${trimmed}'`;
	}
	return "string";
}

function createTaskSchema(options: {
	isolationEnabled: boolean;
	batchEnabled: boolean;
	defaultAgent: string;
	effortEnabled: boolean;
	evalToolsEnabled: boolean;
}): BaseType {
	const agent = taskAgentSchemaRule(options.defaultAgent);
	const effortField = options.effortEnabled ? { "effort?": effortRule } : {};
	const toolsField = options.evalToolsEnabled ? { "tools?": "string[]" } : {};
	if (options.batchEnabled) {
		if (options.isolationEnabled) {
			const item = type.raw({
				"name?": "string",
				agent,
				task: "string",
				...effortField,
				"outputSchema?": outputSchemaInputSchema,
				"schemaMode?": '"permissive" | "strict"',
				...toolsField,
				"isolated?": "boolean",
				"+": "delete",
			});
			return type.raw({
				context: "string",
				tasks: item.array(),
				// A top-level `isolated` is not part of the batch shape; a flat-form
				// call with `isolated` must reject (lenient raw-args fallthrough →
				// preflight) rather than strip and silently run the batch
				// non-isolated.
				"isolated?": "false",
				"+": "delete",
			});
		}
		const item = type.raw({
			"name?": "string",
			agent,
			task: "string",
			...effortField,
			"outputSchema?": outputSchemaInputSchema,
			"schemaMode?": '"permissive" | "strict"',
			// Explicit `isolated` must reject, not strip (see taskItemSchema).
			"isolated?": "false",
			...toolsField,
			"+": "delete",
		});
		return type.raw({
			context: "string",
			tasks: item.array(),
			// Top-level `isolated` must reject, not strip (see taskItemSchema).
			"isolated?": "false",
			"+": "delete",
		});
	}
	if (options.isolationEnabled) {
		return type.raw({
			"name?": "string",
			agent,
			task: "string",
			...effortField,
			"outputSchema?": outputSchemaInputSchema,
			"schemaMode?": '"permissive" | "strict"',
			...toolsField,
			"isolated?": "boolean",
			"+": "delete",
		});
	}
	return type.raw({
		"name?": "string",
		agent,
		task: "string",
		...effortField,
		"outputSchema?": outputSchemaInputSchema,
		"schemaMode?": '"permissive" | "strict"',
		// Explicit `isolated` must reject, not strip (see taskItemSchema).
		"isolated?": "false",
		...toolsField,
		"+": "delete",
	});
}

/** Build the task wire schema for the current settings and spawn policy. */
export function getTaskSchema(options: {
	isolationEnabled: boolean;
	batchEnabled: boolean;
	effortEnabled?: boolean;
	/** Advertise the `tools` field for eval-defined tools (`eval.tools.enabled`, default on). */
	evalToolsEnabled?: boolean;
	defaultAgent?: string;
}): TaskToolSchemaInstance {
	const defaultAgent = options.defaultAgent ?? "task";
	const effortEnabled = options.effortEnabled ?? false;
	const evalToolsEnabled = options.evalToolsEnabled ?? true;
	if (defaultAgent === "task" && !effortEnabled && evalToolsEnabled) {
		if (options.batchEnabled) return options.isolationEnabled ? taskSchemaBatch : taskSchemaBatchNoIsolation;
		return options.isolationEnabled ? taskSchema : taskSchemaNoIsolation;
	}
	const key = `${options.isolationEnabled ? "iso" : "flat"}:${options.batchEnabled ? "batch" : "single"}:${effortEnabled ? "effort" : "default"}:${evalToolsEnabled ? "tools" : "notools"}:${defaultAgent}`;
	const cached = taskSchemaCache.get(key);
	if (cached) return cached;
	const schema = createTaskSchema({ ...options, effortEnabled, evalToolsEnabled, defaultAgent });
	taskSchemaCache.set(key, schema);
	return schema;
}

/**
 * Whether an agent at `taskDepth` may still spawn children — i.e. it currently
 * holds the `task` tool. Mirrors the task-tool availability gate;
 * `maxRecursionDepth < 0` disables the cap entirely.
 */
export function canSpawnAtDepth(maxRecursionDepth: number, taskDepth: number): boolean {
	return maxRecursionDepth < 0 || taskDepth < maxRecursionDepth;
}

/** Agent definition (bundled or discovered) */
export interface AgentDefinition {
	name: string;
	description: string;
	systemPrompt: string;
	tools?: string[];
	spawns?: string[] | "*";
	model?: string[];
	thinkingLevel?: ConfiguredThinkingLevel;
	output?: unknown;
	blocking?: boolean;
	autoloadSkills?: string[];
	/** When `false`, the agent's `read` tool returns verbatim file content instead of structural summaries. */
	readSummarize?: boolean;
	/** Prewalk hand-off for the spawned session: `true` = switch to the default prewalk target at the first edit/write, string = custom target model pattern. */
	prewalk?: boolean | string;
	/** Advisor for spawned sessions of this agent: `true` = advise with the default advisor-role model, string = advise with that model pattern (optional `:level` suffix). Absent/`false` = no advisor. */
	advisor?: boolean | string;
	source: AgentSource;
	filePath?: string;
}
