/**
 * Antigravity CLI provider: one stateful ACP conversation spans multiple omp
 * stream calls. An MCP request parks at each tool boundary until the next
 * stream call supplies its result. Authentication is staged into an isolated
 * agy credential directory; inference always runs through the official CLI.
 */
import * as path from "node:path";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Context, Model, ProviderSessionState, StreamFunction, StreamOptions } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { agyGeminiDir } from "./antigravity-cli/binary";
import { agyCredentialKey, agyCredentialVersion, stageAgyCredentials } from "./antigravity-cli/credentials";
import { AgyHost, type AgyHostOptions } from "./antigravity-cli/host";
import {
	type SessionRuntimeIdle,
	SessionRuntimePool,
	type SessionRuntimeRetirement,
	sessionRuntimeStore,
} from "./antigravity-cli/runtime-pool";
import { StepWriter } from "./antigravity-cli/step-writer";

/** Per-request settings supported by the ACP transport. */
export interface AntigravityCliOptions extends StreamOptions {
	/** Selected model's native `thought_level`. */
	reasoning?: Effort;
}

const IDLE_MS = 5 * 60_000;
/** Retained host key: `antigravity-acp:<sha256 account>:<session or request id>`. */
const KEY_PREFIX = "antigravity-acp:";

/** @internal Exported for tests. */
export const antigravityHostIdle: SessionRuntimeIdle<AgyHost> = {
	timeoutMs: IDLE_MS,
	canDispose: host => !host.hasPendingTurn,
};

/** Test-only overrides for retained host construction; production runs with neither field set. */
export interface AntigravityHostOverrides {
	/** Account-scoped directory holding staged credentials and conversations. */
	directory?: (account: string) => string;
	/** Options every retained host is constructed with. */
	options?: AgyHostOptions;
}

let hostOverrides: AntigravityHostOverrides = {};

/** @internal Exported for tests: drive retained hosts through a fake transport and a temporary directory. */
export function setAntigravityHostOverrides(overrides?: AntigravityHostOverrides): void {
	hostOverrides = overrides ?? {};
}

/** Account segment of a retained host key; a credential key is a hex digest, so no separator can hide inside it. */
function accountOf(key: string): string {
	const rest = key.slice(KEY_PREFIX.length);
	const end = rest.indexOf(":");
	return end < 0 ? rest : rest.slice(0, end);
}

function hostDirectory(account: string): string {
	return hostOverrides.directory?.(account) ?? path.join(agyGeminiDir(), account);
}

function createHost(key: string): AgyHost {
	return new AgyHost(hostDirectory(accountOf(key)), hostOverrides.options);
}

/** @internal Exported for tests. */
export async function retireAgyHost(host: AgyHost, _key: string, reason: SessionRuntimeRetirement): Promise<void> {
	// Idle retirement drops the transport only: the conversation on disk is what
	// the next step resumes.
	if (reason === "idle") {
		host.close();
		return;
	}
	await host.dispose();
}

/** Hosts retained for callers that own no provider session map. */
const implicitHosts = new Map<string, AgyHost>();
const implicitPool = new SessionRuntimePool(createHost, retireAgyHost, antigravityHostIdle, implicitHosts);
const callerPools = new WeakMap<Map<string, ProviderSessionState>, SessionRuntimePool<AgyHost>>();

/** One pool per caller-owned map, so a retained host stays reachable by that map's owner. */
function callerPool(states: Map<string, ProviderSessionState>): SessionRuntimePool<AgyHost> {
	let pool = callerPools.get(states);
	if (!pool) {
		pool = new SessionRuntimePool(
			createHost,
			retireAgyHost,
			antigravityHostIdle,
			sessionRuntimeStore(states, (value): value is AgyHost => value instanceof AgyHost),
		);
		callerPools.set(states, pool);
	}
	return pool;
}

/** @internal Exported for tests: drain retained hosts for one caller-owned map, or every implicit host. */
export async function closeAntigravityHosts(states?: Map<string, ProviderSessionState>): Promise<void> {
	await (states ? callerPool(states) : implicitPool).closeAll();
}

/** Streams one assistant step while retaining agy's unfinished turn across tool results. */
export const streamAntigravityCli: StreamFunction<"antigravity-acp"> = (
	model: Model<"antigravity-acp">,
	context: Context,
	options: AntigravityCliOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();
	const writer = new StepWriter(model, stream);
	void runStep(model, context, options, writer).catch(error => {
		writer.fail(
			options.signal?.aborted ? "aborted" : "error",
			error instanceof Error ? error.message : String(error),
		);
	});
	return stream;
};

async function runStep(
	model: Model<"antigravity-acp">,
	context: Context,
	options: AntigravityCliOptions,
	writer: StepWriter,
): Promise<void> {
	options.signal?.throwIfAborted();
	if (!options.apiKey) throw new Error("Antigravity CLI requires sign-in. Run /login antigravity-cli.");
	const account = agyCredentialKey(options.apiKey);
	await stageAgyCredentials(options.apiKey, hostDirectory(account));
	const stepOptions = {
		cwd: options.cwd,
		reasoning: options.reasoning,
		signal: options.signal,
		credentialVersion: agyCredentialVersion(options.apiKey),
	};
	const key = `${KEY_PREFIX}${account}:${options.sessionId ?? "default"}`;
	const sessions = options.providerSessionState;
	if (sessions) {
		const lease = callerPool(sessions).acquire(key);
		try {
			await lease.value.step(model, context, stepOptions, writer);
		} finally {
			lease.release();
		}
		return;
	}

	// SDK callers may omit a session-state map. A stable session id owns the
	// host; otherwise the native conversation recorded on the last assistant
	// step identifies the parked turn. This never requires a caller-visible key.
	const latest = context.messages.findLast(message => message.role === "assistant");
	const payload = latest?.role === "assistant" ? latest.providerPayload : undefined;
	let implicitKey = options.sessionId ? key : undefined;
	if (!implicitKey && payload?.type === "antigravityCli") {
		const scope = `${KEY_PREFIX}${account}:`;
		for (const [candidate, host] of implicitHosts) {
			if (candidate.startsWith(scope) && host.conversationId === payload.conversationId) {
				implicitKey = candidate;
				break;
			}
		}
	}
	implicitKey ??= `${KEY_PREFIX}${account}:request:${crypto.randomUUID()}`;
	const lease = implicitPool.acquire(implicitKey);
	try {
		await lease.value.step(model, context, stepOptions, writer);
	} finally {
		lease.release();
		// A keyless request whose turn ended without a parked tool call has no
		// continuation, so dispose it now instead of waiting for idle.
		if (!lease.value.hasPendingTurn && !options.sessionId) await implicitPool.close(implicitKey);
	}
}
