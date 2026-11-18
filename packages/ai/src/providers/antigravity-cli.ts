/**
 * Antigravity CLI provider: one stateful ACP conversation spans multiple omp
 * stream calls. An MCP request parks at each tool boundary until the next
 * stream call supplies its result. Authentication is staged into an isolated
 * agy credential directory; inference always runs through the official CLI.
 */
import * as path from "node:path";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import type { Context, Model, StreamFunction, StreamOptions } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { agyGeminiDir } from "./antigravity-cli/binary";
import { agyCredentialKey, agyCredentialVersion, stageAgyCredentials } from "./antigravity-cli/credentials";
import { AgyHost } from "./antigravity-cli/host";
import { StepWriter } from "./antigravity-cli/step-writer";

/** Per-request settings supported by the ACP transport. */
export interface AntigravityCliOptions extends StreamOptions {
	/** Selected model's native `thought_level`. */
	reasoning?: Effort;
}

interface RetainedHost {
	host: AgyHost;
	account: string;
	idle?: NodeJS.Timeout;
}

const implicitSessions = new Map<string, RetainedHost>();
const IDLE_MS = 5 * 60_000;

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
	const directory = path.join(agyGeminiDir(), account);
	await stageAgyCredentials(options.apiKey, directory);
	const stepOptions = {
		cwd: options.cwd,
		reasoning: options.reasoning,
		signal: options.signal,
		credentialVersion: agyCredentialVersion(options.apiKey),
	};
	const sessions = options.providerSessionState;
	const key = `antigravity-acp:${account}:${options.sessionId ?? "default"}`;
	if (sessions) {
		const existing = sessions.get(key);
		const host = existing instanceof AgyHost ? existing : new AgyHost(directory);
		if (host !== existing) sessions.set(key, host);
		await host.step(model, context, stepOptions, writer);
		return;
	}

	// SDK callers may omit a session-state map. A stable session id owns the
	// host; otherwise the native conversation recorded on the last assistant
	// step identifies the parked turn. This never requires a caller-visible key.
	const latest = context.messages.findLast(message => message.role === "assistant");
	const payload = latest?.role === "assistant" ? latest.providerPayload : undefined;
	let implicitKey = options.sessionId ? key : undefined;
	if (!implicitKey && payload?.type === "antigravityCli") {
		for (const [candidate, entry] of implicitSessions) {
			if (entry.account === account && entry.host.conversationId === payload.conversationId) {
				implicitKey = candidate;
				break;
			}
		}
	}
	implicitKey ??= `${account}:request:${crypto.randomUUID()}`;
	const retained = implicitSessions.get(implicitKey);
	clearTimeout(retained?.idle);
	const host = retained?.host ?? new AgyHost(directory);
	const entry = retained ?? { host, account };
	// Register before publishing any terminal event: callers can immediately
	// start the next stream when toolUse resolves, before our finally runs.
	implicitSessions.set(implicitKey, entry);
	try {
		await host.step(model, context, stepOptions, writer);
	} finally {
		if (host.hasPendingTurn || options.sessionId) {
			retireWhenIdle(implicitKey, entry);
		} else {
			implicitSessions.delete(implicitKey);
			await host.dispose();
		}
	}
}

function retireWhenIdle(key: string, entry: RetainedHost): void {
	entry.idle = setTimeout(() => {
		if (implicitSessions.get(key) !== entry) return;
		if (entry.host.hasPendingTurn) {
			retireWhenIdle(key, entry);
			return;
		}
		entry.host.close();
		implicitSessions.delete(key);
	}, IDLE_MS);
	entry.idle.unref();
}
