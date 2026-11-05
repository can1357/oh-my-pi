/**
 * A2A v1.0 AgentCard for the omp bridge.
 *
 * Skills are omp agents: the id is the agent id (the A2A task id), the name is
 * the registry display name, and the description comes from agent discovery.
 * System prompts never reach the card — discovery definitions carry them, and
 * only `description` is copied here.
 */

export const A2A_PROTOCOL_VERSION = "1.0";
const CARD_NAME = "omp";
const CARD_DESCRIPTION = "oh-my-pi coding agent (A2A bridge)";

export interface AgentCardSkill {
	id: string;
	name: string;
	description: string;
	tags: string[];
}

export interface AgentCardInterface {
	url: string;
	protocolBinding: "JSONRPC";
	protocolVersion: string;
}

export interface AgentCardBearerScheme {
	httpAuthSecurityScheme: {
		scheme: string;
		bearerFormat: string;
	};
}

export interface AgentCard {
	name: string;
	description: string;
	/** Required by the v1.0 card contract the bridge advertises. */
	protocolVersion: string;
	version: string;
	supportedInterfaces: AgentCardInterface[];
	capabilities: { streaming: boolean };
	defaultInputModes: string[];
	defaultOutputModes: string[];
	skills: AgentCardSkill[];
	securitySchemes: Record<string, AgentCardBearerScheme>;
}

export interface AgentCardSkillInput {
	/** Agent id: the A2A task id. */
	id: string;
	/** Registry display name. */
	displayName: string;
	/** AgentDefinition discovery description. */
	description?: string;
}

export interface AgentCardInput {
	/** Absolute URL of the JSON-RPC endpoint. */
	url: string;
	/** Fork version, e.g. `18.16.0`. */
	version: string;
	skills: readonly AgentCardSkillInput[];
}

/** Build the served card; `skills` must already exclude advisor transcripts. */
export function buildAgentCard(input: AgentCardInput): AgentCard {
	return {
		name: CARD_NAME,
		description: CARD_DESCRIPTION,
		protocolVersion: A2A_PROTOCOL_VERSION,
		version: input.version,
		supportedInterfaces: [
			{
				url: input.url,
				protocolBinding: "JSONRPC",
				protocolVersion: A2A_PROTOCOL_VERSION,
			},
		],
		capabilities: { streaming: true },
		defaultInputModes: ["text/plain"],
		defaultOutputModes: ["text/plain"],
		skills: input.skills.map(skill => ({
			id: skill.id,
			name: skill.displayName,
			description: skill.description ?? skill.displayName,
			tags: ["omp", "subagent"],
		})),
		securitySchemes: {
			bearer: {
				httpAuthSecurityScheme: {
					scheme: "Bearer",
					bearerFormat: "opaque",
				},
			},
		},
	};
}
