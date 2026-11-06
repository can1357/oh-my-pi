/**
 * In-memory provider for remote A2A agents.
 *
 * `/a2a add <url>` reads a remote AgentCard and registers one runtime agent per
 * card skill as `a2a:<skill id>`. Registrations live in this bridge — a plain
 * in-memory map owned by the session — never on disk: they are not agent
 * definition files, nothing is discovered from them, and the task tool never
 * runs them locally.
 *
 * The task tool merges `definitions()` into its advertised roster and into
 * spawn preflight, then routes a spawn of a registered name to
 * {@link spawnA2aAgent} instead of launching a local subagent.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isRecord } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import type { ToolSession } from "../tools";
import { cfgA2aToken } from "../task/settings";
import type { AgentDefinition } from "../task/types";
import { type AgentCard, A2A_PROTOCOL_VERSION, type AgentCardSkill } from "./card";
import { A2A_CONNECT_TIMEOUT_MS, A2aClient, cardRequiresBearer, fetchAgentCard } from "./client";
import { TASK_STATE, type TaskState } from "./rpc";

export const A2A_AGENT_PREFIX = "a2a:";
/** The remote paused for input; omp v1 has no way to answer, so the spawn reports it. */
export const A2A_WAITING_FOR_INPUT_TEXT = "waiting for input; unavailable in omp v1";
export const A2A_AUTH_REQUIRED_TEXT = "authentication required; unavailable in omp v1";

/** One remote agent registered for the session. */
export interface A2aRuntimeAgent {
	/** `a2a:<skill id>`; the name the task tool accepts. */
	name: string;
	/** Card skill description (never a system prompt — the card carries none). */
	description: string;
	/** JSON-RPC endpoint from `supportedInterfaces[].url`. */
	url: string;
	/** Bearer token for the endpoint; omitted when the card declares no auth. */
	token?: string;
	/** Remote card name, for `/a2a list`. */
	cardName: string;
	/** Skill id as advertised by the card. */
	skillId: string;
}

/** Read-only surface the task tool needs; implemented by {@link A2aAgentBridge}. */
export interface A2aBridgeApi {
	list(): readonly A2aRuntimeAgent[];
	get(name: string): A2aRuntimeAgent | undefined;
	definitions(): readonly AgentDefinition[];
}

/** A card skill id becomes a spawnable agent name: `a2a:<skill id>`. */
export function runtimeAgentName(skillId: string): string {
	const safe = skillId
		.trim()
		.replace(/[^A-Za-z0-9_.-]+/g, "-")
		.replace(/^-+|-+$/g, "");
	return `${A2A_AGENT_PREFIX}${safe.length > 0 ? safe : "agent"}`;
}

/**
 * Session-local registry of remote agents. `Map` because registrations are
 * added, replaced, and removed at runtime.
 */
export class A2aAgentBridge implements A2aBridgeApi {
	readonly #agents = new Map<string, A2aRuntimeAgent>();

	/**
	 * Register one remote agent. Re-adding the SAME endpoint (refresh) replaces
	 * its skills under the same name; adding a DIFFERENT endpoint that already
	 * owns the name registers under a `-2`/`-3`… suffix so sibling terminals
	 * serving the same skill ids (e.g. two `Main` agents) both stay reachable.
	 */
	add(agent: A2aRuntimeAgent): A2aRuntimeAgent {
		const existing = this.#agents.get(agent.name);
		if (existing !== undefined && existing.url !== agent.url) {
			let suffix = 2;
			while (this.#agents.has(`${agent.name}-${suffix}`)) suffix += 1;
			agent = { ...agent, name: `${agent.name}-${suffix}` };
		}
		this.#agents.set(agent.name, agent);
		return agent;
	}

	get(name: string): A2aRuntimeAgent | undefined {
		return this.#agents.get(name);
	}

	list(): A2aRuntimeAgent[] {
		return [...this.#agents.values()];
	}

	remove(name: string): boolean {
		return this.#agents.delete(name);
	}

	clear(): void {
		this.#agents.clear();
	}

	/**
	 * Task-tool definitions. `blocking` keeps a remote spawn inline: the call
	 * already waits for the remote result, so a background job would only add a
	 * second indirection.
	 */
	definitions(): AgentDefinition[] {
		return this.list().map(agent => ({
			name: agent.name,
			description: agent.description,
			// Never executed locally: the task tool routes `a2a:` spawns to the endpoint.
			systemPrompt: `Remote A2A agent "${agent.name}" served by ${agent.url}.`,
			source: "user",
			blocking: true,
		}));
	}
}

/**
 * Reject a remote A2A agent name on a spawn path that cannot route to its
 * endpoint. Only the task tool routes `a2a:` names to the remote bridge; the
 * workflow VM and the `pi.spawnSubagent` seam would otherwise run the
 * placeholder definition locally — an agent whose system prompt is just the
 * endpoint URL, with the caller's prompt as its assignment.
 */
export function assertNotRemoteA2aAgent(session: Pick<ToolSession, "getA2aBridge">, agent: string | undefined): void {
	const remote = agent === undefined ? undefined : session.getA2aBridge?.()?.get(agent);
	if (remote) {
		throw new Error(`Agent "${remote.name}" is a remote A2A agent and can only be spawned by the task tool.`);
	}
}

/** Read `<agentDir>/a2a.token` without generating one: registration must not mint credentials. */
async function readAgentDirToken(agentDir: string | undefined): Promise<string | undefined> {
	if (!agentDir) return undefined;
	try {
		const token = (await fs.readFile(path.join(agentDir, "a2a.token"), "utf8")).trim();
		return token.length > 0 ? token : undefined;
	} catch {
		return undefined;
	}
}

export interface AddA2aAgentsOptions {
	bridge: A2aAgentBridge;
	/** Base URL of the remote bridge, or its direct `agent-card.json` URL. */
	url: string;
	/** Explicit bearer token (`/a2a add <url> --token <token>`). */
	token?: string;
	/** Agent directory holding `a2a.token`; read-only fallback when the card requires bearer auth. */
	agentDir?: string;
	/** Reads the `a2a.token` setting when no explicit token is given. */
	settings?: Settings;
	connectTimeoutMs?: number;
	fetch?: typeof fetch;
	signal?: AbortSignal;
}

export interface AddA2aAgentsResult {
	card: AgentCard;
	endpoint: string;
	added: A2aRuntimeAgent[];
}

/**
 * Fetch a remote card and register its skills. The card route is public
 * discovery metadata, so the fetch itself needs no credentials; the bearer for
 * the RPC endpoint is resolved from the explicit token, the `a2a.token`
 * setting, or the agent directory's token file, in that order.
 */
export async function addA2aAgentsFromUrl(options: AddA2aAgentsOptions): Promise<AddA2aAgentsResult> {
	const { card, endpoint } = await fetchAgentCard({
		url: options.url,
		token: options.token,
		connectTimeoutMs: options.connectTimeoutMs,
		fetch: options.fetch,
		signal: options.signal,
	});
	if (card.protocolVersion !== undefined && card.protocolVersion !== A2A_PROTOCOL_VERSION) {
		throw new Error(
			`Remote agent card speaks A2A ${card.protocolVersion}; this bridge speaks ${A2A_PROTOCOL_VERSION}`,
		);
	}
	let token = options.token?.trim() || undefined;
	if (token === undefined && cardRequiresBearer(card)) {
		token =
			(options.settings ? cfgA2aToken.get(options.settings).trim() : "") ||
			(await readAgentDirToken(options.agentDir));
		if (token === "") token = undefined;
	}
	// The card is remote data: a malformed entry is skipped, never a throw that
	// hides the rest of a valid roster.
	const skills = (Array.isArray(card.skills) ? card.skills : []).filter(
		(skill): skill is AgentCardSkill => isRecord(skill) && typeof skill.id === "string" && skill.id.trim().length > 0,
	);
	const entries =
		skills.length > 0
			? skills.map(skill => {
					const description = [skill.description, skill.name].find(
						(value): value is string => typeof value === "string" && value.trim().length > 0,
					);
					return {
						name: runtimeAgentName(skill.id),
						skillId: skill.id,
						description: description?.trim() ?? skill.id,
					};
				})
			: [
					{
						name: runtimeAgentName(card.name),
						skillId: card.name,
						description: card.description?.trim() || card.name,
					},
				];
	const added = entries.map(entry =>
		options.bridge.add({
			...entry,
			cardName: card.name,
			url: endpoint,
			...(token !== undefined ? { token } : {}),
		}),
	);
	return { card, endpoint, added };
}

export interface SpawnA2aAgentOptions {
	agent: A2aRuntimeAgent;
	prompt: string;
	/** Whole-run budget in milliseconds; `0`/undefined waits indefinitely (A2A is async-first). */
	timeoutMs?: number;
	connectTimeoutMs?: number;
	pollIntervalMs?: number;
	signal?: AbortSignal;
	fetch?: typeof fetch;
}

export interface SpawnA2aAgentResult {
	exitCode: number;
	output: string;
	error?: string;
	state: TaskState;
	remoteTaskId?: string;
}

/**
 * Run one prompt on a remote agent and flatten the outcome into the task
 * tool's result fields. Every failure is a value, not a throw: the task tool
 * renders it inside the standard `<task-result>` envelope.
 */
export async function spawnA2aAgent(options: SpawnA2aAgentOptions): Promise<SpawnA2aAgentResult> {
	const { agent } = options;
	try {
		const client = new A2aClient({
			url: agent.url,
			token: agent.token,
			totalTimeoutMs: options.timeoutMs ?? 0,
			connectTimeoutMs: options.connectTimeoutMs ?? A2A_CONNECT_TIMEOUT_MS,
			...(options.pollIntervalMs !== undefined ? { pollIntervalMs: options.pollIntervalMs } : {}),
			signal: options.signal,
			...(options.fetch ? { fetch: options.fetch } : {}),
		});
		const run = await client.sendAndWait(options.prompt);
		const text = run.text.trim();
		const remoteTaskId = run.task?.id;
		if (run.interrupted) {
			const reason = run.state === TASK_STATE.AUTH_REQUIRED ? A2A_AUTH_REQUIRED_TEXT : A2A_WAITING_FOR_INPUT_TEXT;
			return { exitCode: 1, output: reason, error: reason, state: run.state, remoteTaskId };
		}
		if (run.state === TASK_STATE.COMPLETED) {
			return { exitCode: 0, output: text || "(no output)", state: run.state, remoteTaskId };
		}
		const reason = text || `remote task ended in ${run.state}`;
		return { exitCode: 1, output: reason, error: reason, state: run.state, remoteTaskId };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { exitCode: 1, output: message, error: message, state: TASK_STATE.FAILED };
	}
}

export interface AutoRegisterResult {
	/** Successfully registered agent names per endpoint URL. */
	registered: Map<string, string[]>;
	/** Endpoint URLs that failed, with the reason. */
	failed: Map<string, string>;
}

/**
 * Register every live local bridge (excluding this process) from the
 * machine-local discovery registry. Shared by `/a2a auto` and session-start
 * auto-registration. Failures are per-endpoint: one dead card never blocks
 * the rest.
 */
export async function autoRegisterLocalBridges(options: {
	bridge: A2aAgentBridge;
	agentDir: string;
	settings?: Settings;
	token?: string;
	signal?: AbortSignal;
}): Promise<AutoRegisterResult> {
	const { readLiveBridges } = await import("./server");
	const live = await readLiveBridges(options.agentDir);
	const registered = new Map<string, string[]>();
	const failed = new Map<string, string>();
	for (const entry of live.values()) {
		const url = `http://127.0.0.1:${entry.port}/`;
		try {
			const result = await addA2aAgentsFromUrl({
				bridge: options.bridge,
				url,
				token: options.token,
				agentDir: options.agentDir,
				settings: options.settings,
				signal: options.signal,
			});
			registered.set(
				url,
				result.added.map(agent => agent.name),
			);
		} catch (error) {
			failed.set(url, error instanceof Error ? error.message : String(error));
		}
	}
	return { registered, failed };
}
