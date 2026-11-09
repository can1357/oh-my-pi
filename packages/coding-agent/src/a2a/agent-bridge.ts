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
	/** True for peers discovered from the local bridge registry (A4 rescan may drop them). */
	autoRegistered?: boolean;
}

/** Bridge surface the task tool, discovery and reply correlation need; implemented by {@link A2aAgentBridge}. */
export interface A2aBridgeApi {
	list(): readonly A2aRuntimeAgent[];
	get(name: string): A2aRuntimeAgent | undefined;
	definitions(): readonly AgentDefinition[];
	/** Register/replace one remote agent (discovery refresh, `/a2a add`). */
	add(agent: A2aRuntimeAgent): A2aRuntimeAgent;
	/** Forget one agent by name. */
	remove(name: string): boolean;
	/** Drop every entry served by one endpoint before re-registering it (A5). */
	removeByUrl(url: string): void;
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
		for (const existing of this.#agents.values()) {
			if (existing.url === agent.url && existing.skillId === agent.skillId) {
				agent = { ...agent, name: existing.name };
				break;
			}
		}
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

	/** Drop every entry served by one endpoint (A5): a refresh must not leave -2/-3 duplicates behind. */
	removeByUrl(url: string): void {
		for (const [name, agent] of this.#agents) {
			if (agent.url === url) this.#agents.delete(name);
		}
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

/** Default cap on skills registered from one peer card (roster flood guard). */
export const A2A_DEFAULT_MAX_PEER_SKILLS = 8;

export interface AddA2aAgentsOptions {
	/** Max skills to register from one peer card; default 8 (flood guard). */
	maxPeerSkills?: number;
	bridge: A2aBridgeApi;
	/** When set, the served card must report this instanceId (A3 stale-registry guard). */
	expectedInstanceId?: string;
	/** Mark registered agents as auto-discovered so a rescan can drop them (A4). */
	autoRegistered?: boolean;
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
	// A3: a stale bridge-registry entry may point at a port now owned by a
	// different bridge; the card's instanceId must match the recorded one.
	if (options.expectedInstanceId !== undefined && card.instanceId !== options.expectedInstanceId) {
		throw new Error(
			`Bridge card instanceId mismatch: expected ${options.expectedInstanceId}, got ${card.instanceId ?? "none"}`,
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
	// Registration cap: a peer advertising a swarm of one-shot workers
	// (finished subagents listed by an older bridge) would flood this
	// session's roster with dead a2a: names. Register at most
	// `a2a.maxPeerSkills` skills per peer — the main/identity skill first,
	// then the rest in card order.
	const maxSkills = options.maxPeerSkills ?? A2A_DEFAULT_MAX_PEER_SKILLS;
	const entries =
		skills.length > 0
			? skills.slice(0, Math.max(1, maxSkills)).map(skill => {
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
	// A5: a refresh of the SAME endpoint replaces its prior entries instead of
	// accumulating -2/-3 suffixed duplicates on every roster rescan.
	options.bridge.removeByUrl(endpoint);
	const added = entries.map(entry =>
		options.bridge.add({
			...entry,
			cardName: card.name,
			url: endpoint,
			...(token !== undefined ? { token } : {}),
			...(options.autoRegistered === true ? { autoRegistered: true } : {}),
		}),
	);
	return { card, endpoint, added };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export interface SpawnA2aAgentOptions {
	agent: A2aRuntimeAgent;
	prompt: string;
	/** Whole-run budget in milliseconds; `0`/undefined waits indefinitely (A2A is async-first). */
	timeoutMs?: number;
	/** Explicit spawn mode: ask the remote terminal to create a NEW agent instead of addressing its own. */
	spawn?: boolean;
	/** This terminal's public A2A identity (name + bridge url): stamps `from`/`fromUrl` so the remote can answer back. */
	fromIdentity?: { name?: string; url?: string };
	/** Shared batch context forwarded to the remote agent (A7). */
	context?: string;
	/** Explicit correlation id for a reply to a prior request (A2). */
	inReplyTo?: string;
	/** Caller-supplied wire id. Absent keeps the client's generated `omp-<uuid>`. */
	messageId?: string;
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
	/** Addressed delivery accepted; the peer's answer is still outstanding. */
	deliveryReceipt?: boolean;
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
		// Default addressing (spec 2026-11-06): the message goes to the terminal's
		// own agent (the skill the card advertised) — the task lands in that
		// terminal's main conversation, and that agent decides whether to answer
		// itself or spawn its own subagents. An addressed delivery to a running
		// agent returns a receipt; the answer appears in the remote terminal
		// (and over GetTask once its agent yields). `from` identifies this
		// terminal to the peer: the delivered envelope tells the remote agent to
		// send its answer back by spawning this terminal's a2a agent (the
		// symmetric auto-registered roster entry).
		const from = options.fromIdentity;
		const run = await client.sendAndWait(options.prompt, {
			...(options.messageId !== undefined ? { messageId: options.messageId } : {}),
			metadata: {
				...(options.spawn === true ? { spawn: true } : { to: agent.skillId }),
				...(from?.name !== undefined ? { from: from.name } : {}),
				...(from?.url !== undefined ? { fromUrl: from.url } : {}),
				...(options.context !== undefined ? { context: options.context } : {}),
				...(options.inReplyTo !== undefined ? { inReplyTo: options.inReplyTo } : {}),
			},
		});
		const text = run.text.trim();
		const remoteTaskId = run.task?.id;
		const delivery = asRecord(run.task?.metadata)?.delivery;
		if (delivery !== undefined) {
			const receipt = asRecord(delivery);
			const outcome = typeof receipt?.outcome === "string" ? receipt.outcome : "unknown";
			if (outcome === "failed") {
				const reason = typeof receipt?.error === "string" ? receipt.error : "delivery failed";
				return { exitCode: 1, output: reason, error: reason, state: run.state, remoteTaskId };
			}
			if (run.state !== TASK_STATE.COMPLETED && run.state !== TASK_STATE.FAILED) {
				const delivered = `Delivered to ${agent.name} (${agent.url}) - the task now runs in that terminal's own conversation.`;
				return { exitCode: 0, output: delivered, state: run.state, remoteTaskId, deliveryReceipt: true };
			}
		}
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
	bridge: A2aBridgeApi;
	agentDir: string;
	settings?: Settings;
	token?: string;
	maxPeerSkills?: number;
	signal?: AbortSignal;
	/** Pid to exclude from the live set (default this process). */
	excludePid?: number;
}): Promise<AutoRegisterResult> {
	// Lazy: the server module pulls the task executor and thread workers, which
	// import this bridge, so a static import closes an import cycle.
	const { readLiveBridges } = await import("./server");
	const live = await readLiveBridges(options.agentDir, { excludePid: options.excludePid });
	const registered = new Map<string, string[]>();
	const failed = new Map<string, string>();
	for (const entry of live.values()) {
		const url = `http://127.0.0.1:${entry.port}/`;
		try {
			if (!entry.instanceId) throw new Error("Bridge registry entry has no instanceId");
			const result = await addA2aAgentsFromUrl({
				bridge: options.bridge,
				url,
				token: options.token,
				agentDir: options.agentDir,
				settings: options.settings,
				maxPeerSkills: options.maxPeerSkills,
				signal: options.signal,
				autoRegistered: true,
				expectedInstanceId: entry.instanceId,
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

/** Minimum gap between on-demand rescans for each session bridge (A4). */
const RESCAN_DEBOUNCE_MS = 2_000;
const rescanState = new WeakMap<A2aBridgeApi, Map<string, number>>();

export interface RescanLocalBridgesOptions {
	bridge: A2aBridgeApi;
	agentDir: string;
	settings?: Settings;
	token?: string;
	maxPeerSkills?: number;
	signal?: AbortSignal;
	excludePid?: number;
}

/**
 * On-demand symmetric discovery (A4): re-read the live bridge registry, drop
 * auto-discovered peers whose bridge disappeared, and register newly started
 * terminals. Each session's scans are debounced by at least two seconds.
 */
export async function rescanLocalBridges(options: RescanLocalBridgesOptions): Promise<AutoRegisterResult> {
	const now = Date.now();
	let scans = rescanState.get(options.bridge);
	if (scans === undefined) {
		scans = new Map();
		rescanState.set(options.bridge, scans);
	}
	const previous = scans.get(options.agentDir);
	if (previous !== undefined && now - previous < RESCAN_DEBOUNCE_MS) {
		return { registered: new Map(), failed: new Map() };
	}
	scans.set(options.agentDir, now);
	const result = await autoRegisterLocalBridges(options);
	// Only a successfully verified card proves that an endpoint is still ours.
	for (const agent of options.bridge.list()) {
		if (agent.autoRegistered === true && !result.registered.has(agent.url)) options.bridge.remove(agent.name);
	}
	return result;
}
