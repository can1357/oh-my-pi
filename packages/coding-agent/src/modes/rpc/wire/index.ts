/**
 * RPC wire schema: the single source the client libraries are generated from.
 *
 * Definitions are omptype schemas grouped by domain (`content`, `state`,
 * `events`, `frames`) plus the command table (`commands`). `buildRpcWireBundle`
 * resolves them in one scope and emits a JSON Schema 2020-12 bundle with an
 * `x-rpc` section (commands and notification union) that language generators
 * consume; `bun run gen:rpc` writes it and every generated client. Object
 * definitions marked `"x-open": true` are open records: decoders check only the
 * discriminator and keep every key. Property markers carry the remaining
 * decoder leniency (see `PROPERTY_MARKERS`).
 *
 * `rpc-types.ts` stays the server's hand-written view; the conformance test in
 * `test/rpc-wire` keeps the generated TypeScript types and it in agreement.
 */
import { type } from "@oh-my-pi/omptype";
import { type RpcCommandSpec, rpcCommands } from "./commands";
import { messageDefs, modelDefs } from "./content";
import { doc, type WireDefs } from "./dsl";
import { eventDefs } from "./events";
import { frameDefs } from "./frames";
import { stateDefs } from "./state";

export type { RpcCommandSpec } from "./commands";

/** Generator-facing description of one command; definitions are referenced by name. */
export interface RpcWireCommand {
	name: string;
	doc: string;
	params: string | null;
	result: string | null;
	nullable: boolean;
	unwrap: string | null;
	timeoutMs: number | null;
	completion: "prompt_result" | null;
	clientOmit: string[];
}

/** JSON Schema bundle consumed by language generators. */
export interface RpcWireBundle {
	$schema: string;
	$id: string;
	title: string;
	description: string;
	"x-rpc": {
		/** Definition of every unsolicited outbound frame, dispatched by `type`. */
		notification: string;
		/** Definition of the session event union (the frames `set_event_filter` applies to). */
		sessionEvent: string;
		/**
		 * Definition of every stdout frame, dispatched by `type`: responses, host requests, and
		 * notifications. An unrecognized `type` is an unknown notification, not an error.
		 */
		serverFrame: string;
		/** Definition of every non-command frame the host writes to stdin, dispatched by `type`. */
		inbound: string;
		commands: RpcWireCommand[];
	};
	$defs: Record<string, Record<string, unknown>>;
}

const notificationDefs = {
	RpcNotification: doc(
		[
			"ReadyEvent",
			"PromptResultEvent",
			"SessionSettledEvent",
			"ExtensionError",
			"ExtensionUiRequest",
			"AvailableCommandsUpdateEvent",
			"SkillDiagnosticsUpdateEvent",
			"SubagentLifecycleEvent",
			"SubagentProgressEvent",
			"SubagentEvent",
			"LivePhaseEvent",
			"LiveLevelsEvent",
			"LiveTranscriptEvent",
			"LiveEndEvent",
			"BtwDeltaEvent",
			"BtwRecordEvent",
			"CommandOutputEvent",
			"SessionInfoUpdateEvent",
			"ConfigUpdateEvent",
			"RpcFrameErrorEvent",
			"RpcAgentEvent",
		].join(" | "),
		"Unsolicited outbound frame (everything except responses and host tool/URI requests), discriminated by `type`.",
	),
	RpcServerFrame: doc(
		"RpcResponse | RpcHostRequest | RpcNotification",
		"Any frame the server writes to stdout (after reassembling `rpc_chunk` sequences), discriminated by `type`.",
	),
} satisfies WireDefs;

/**
 * Decoder leniency attached to individual properties as bundle keywords:
 * - `x-unknown-fallback`: a value that fails to decode becomes an unknown
 *   notification instead of failing the enclosing frame (a subagent may run a
 *   newer event set than its parent client knows).
 * - `x-scalar-or-array`: an array field that servers before ordered system
 *   prompts (May 2026) sent as a bare scalar; decoders wrap the scalar.
 */
const PROPERTY_MARKERS: Record<string, Record<string, readonly string[]>> = {
	"x-unknown-fallback": { SubagentEventPayload: ["event"] },
	"x-scalar-or-array": { SessionState: ["systemPrompt"] },
};

function markProperties(name: string, schema: Record<string, unknown>): Record<string, unknown> {
	const properties = schema.properties as Record<string, Record<string, unknown>> | undefined;
	if (!properties) return schema;
	let marked: Record<string, Record<string, unknown>> | undefined;
	for (const marker in PROPERTY_MARKERS) {
		for (const key of PROPERTY_MARKERS[marker][name] ?? []) {
			if (!(key in properties)) throw new Error(`${marker} names unknown property ${name}.${key}`);
			marked ??= { ...properties };
			marked[key] = { ...marked[key], [marker]: true };
		}
	}
	return marked ? { ...schema, properties: marked } : schema;
}

function pascalCase(snake: string): string {
	return snake.replace(/(^|_)([a-z])/g, (_, __, letter: string) => letter.toUpperCase());
}

/** Registers inline command params/results as named definitions and describes each command by name. */
function collectCommands(defs: WireDefs): RpcWireCommand[] {
	const definitionName = (
		value: RpcCommandSpec["params"] | RpcCommandSpec["result"],
		inlineName: string,
	): string | null => {
		if (value === undefined) return null;
		if (typeof value === "string") return value;
		if (inlineName in defs)
			throw new Error(`Inline command definition ${inlineName} collides with a shared definition`);
		defs[inlineName] = value;
		return inlineName;
	};
	return rpcCommands.map(spec => {
		const base = pascalCase(spec.name);
		return {
			name: spec.name,
			doc: spec.doc,
			params: definitionName(spec.params, `${base}Params`),
			result: definitionName(spec.result, `${base}Result`),
			nullable: spec.nullable ?? false,
			unwrap: spec.unwrap ?? null,
			timeoutMs: spec.timeoutMs ?? null,
			completion: spec.completion ?? null,
			clientOmit: spec.clientOmit ?? [],
		};
	});
}

/**
 * Resolves every wire definition in one scope and emits the generator bundle.
 *
 * @throws when two definitions emit conflicting JSON Schema for one name, or an
 * inline command definition collides with a shared one.
 */
export function buildRpcWireBundle(): RpcWireBundle {
	const defs: WireDefs = {
		...messageDefs,
		...modelDefs,
		...stateDefs,
		...eventDefs,
		...frameDefs,
		...notificationDefs,
	};
	const open = new Set([...Object.keys(messageDefs), "SelectOptionDetail"]);
	const commands = collectCommands(defs);
	const exported = type.scope(defs).export() as Record<string, { toJsonSchema(): Record<string, unknown> }>;

	const $defs: Record<string, Record<string, unknown>> = {};
	const record = (name: string, schema: Record<string, unknown>): void => {
		const known = $defs[name];
		if (known && JSON.stringify(known) !== JSON.stringify(schema)) {
			throw new Error(`Conflicting JSON Schema emitted for ${name}`);
		}
		$defs[name] = schema;
	};
	for (const name in defs) {
		const { $defs: nested, ...root } = exported[name].toJsonSchema();
		record(name, root);
		const nestedDefs = (nested ?? {}) as Record<string, Record<string, unknown>>;
		for (const nestedName in nestedDefs) record(nestedName, nestedDefs[nestedName]);
	}
	// Emit definitions in authoring order so generated output reads like the source.
	const ordered = Object.fromEntries(
		Object.keys(defs).map(name => {
			const schema = markProperties(name, $defs[name]);
			return [name, open.has(name) && schema.type === "object" ? { ...schema, "x-open": true } : schema];
		}),
	);

	return {
		$schema: "https://json-schema.org/draft/2020-12/schema",
		$id: "https://omp.sh/schemas/rpc-wire.json",
		title: "omp RPC wire protocol",
		description:
			"Generated by `bun run gen:rpc` from packages/coding-agent/src/modes/rpc/wire. Commands are JSON lines on stdin; responses and frames are JSON lines on stdout.",
		"x-rpc": {
			notification: "RpcNotification",
			sessionEvent: "RpcAgentEvent",
			serverFrame: "RpcServerFrame",
			inbound: "RpcInbound",
			commands,
		},
		$defs: ordered,
	};
}
