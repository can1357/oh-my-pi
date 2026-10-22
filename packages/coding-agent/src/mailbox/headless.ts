/**
 * Headless delivery: resume a session nobody has open in an RPC host just long
 * enough for that host's own mailbox watcher to deliver one message and for
 * the turn it starts to settle. The live path and this one share the watcher,
 * so the turn lands in the session's own file exactly like a live delivery.
 *
 * The host announces presence and takes the session's write lease before
 * anything in it can write (`exitUnlessHeadlessRunMayWrite`); if another
 * process opened the session since the decision to resume, the host leaves
 * without writing and the mail stays for that process. What remains is the
 * reverse order: a process that opens the session while the headless turn
 * runs is told the session is open elsewhere and moves to a sibling file on
 * its first write, as for any two processes on one session.
 */
import { logger, ptree } from "@oh-my-pi/pi-utils";
import type { AgentMessage } from "@oh-my-pi/pi-agent-core";
import { RpcClient } from "../modes/rpc/rpc-client";
import type { SessionManager } from "../session/session-manager";
import { resolveCliEntryCmd } from "../subprocess/worker-client";
import { deliveryTarget, describeDeliveryTarget, isMailDone, listNewMail } from "./mailbox";
import { MAILBOX_HEADLESS_ENV } from "./paths";
import { listSessionPresence } from "./presence";

/** Exit code of a headless host that found its session open elsewhere and left without writing. */
export const HEADLESS_SESSION_TAKEN_EXIT = 75;

const POLL_MS = 500;
/** How long the host gets to claim the mail after it is ready. */
const CLAIM_TIMEOUT_MS = 90_000;
/** Cap on a whole headless run. */
const TIMEOUT_MS = 30 * 60_000;
/** How long the host gets to exit after its stdin closes before it is killed. */
const EXIT_GRACE_MS = 10_000;

/**
 * Run at startup of a host started with `OMP_MAILBOX_HEADLESS`, before
 * anything can write the session: continue only when no other process has the
 * session open and this one now holds its write lease; otherwise exit with
 * {@link HEADLESS_SESSION_TAKEN_EXIT} without writing.
 */
export function exitUnlessHeadlessRunMayWrite(sessionManager: SessionManager): void {
	const sessionId = sessionManager.getSessionId();
	const others = listSessionPresence(sessionId);
	if (others.length === 0 && sessionManager.claimOwnership()) return;
	logger.warn("headless delivery left: session is open in another process", {
		sessionId,
		holders: others.map(record => `${record.host}:${record.pid}`),
	});
	process.stderr.write(`session ${sessionId} is open in another omp process; leaving the mail to it\n`);
	process.exit(HEADLESS_SESSION_TAKEN_EXIT);
}

export interface HeadlessDeliveryRequest {
	sessionId: string;
	/** Session file (preferred) or id, passed to `--resume`. */
	sessionRef: string;
	cwd: string;
	/** The message whose turn the run waits for; it must already be in the session's mailbox. */
	mailId: string;
}

/**
 * - `delivered`: the host delivered the mail and its turn settled;
 * - `live`: a live process has the session now and delivers the mail itself;
 * - `held`: the session is open where mail is not delivered; it waits;
 * - `failed`: the host failed, the turn ended in a model error, or the run timed out.
 */
export interface HeadlessDeliveryResult {
	outcome: "delivered" | "live" | "held" | "failed";
	detail?: string;
}

function lastAssistantError(messages: AgentMessage[]): string | undefined {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (message.role !== "assistant") continue;
		return message.stopReason === "error" ? (message.errorMessage ?? "model error") : undefined;
	}
	return undefined;
}

/** The session is not delivered here (anymore): say where its mail goes instead. */
function notHere(sessionId: string): HeadlessDeliveryResult {
	const target = deliveryTarget(sessionId);
	if (target.kind === "live") return { outcome: "live", detail: describeDeliveryTarget(target) };
	return { outcome: "held", detail: describeDeliveryTarget(target) };
}

export async function deliverHeadless(request: HeadlessDeliveryRequest): Promise<HeadlessDeliveryResult> {
	const { sessionId, mailId } = request;
	if (deliveryTarget(sessionId).kind !== "free") return notHere(sessionId);
	let child: ptree.ChildProcess<"pipe"> | undefined;
	const client = new RpcClient({
		cwd: request.cwd,
		// No UI: nobody can answer an approval, so a call that needs one is denied instead of waiting.
		args: ["--resume", request.sessionRef, "--no-ui"],
		spawn: args => {
			child = ptree.spawn([...resolveCliEntryCmd(), ...args], {
				cwd: request.cwd,
				env: { ...Bun.env, [MAILBOX_HEADLESS_ENV]: mailId },
				stdin: "pipe",
			});
			return child;
		},
	});
	let turnError: string | undefined;
	client.onEvent(event => {
		if (event.type === "agent_end") turnError = lastAssistantError(event.messages);
	});
	const deadline = Date.now() + TIMEOUT_MS;
	try {
		try {
			await client.start();
		} catch (error) {
			const exitCode = child ? await child.exited.catch(() => undefined) : undefined;
			if (exitCode === HEADLESS_SESSION_TAKEN_EXIT) return notHere(sessionId);
			return { outcome: "failed", detail: String(error instanceof Error ? error.message : error).slice(0, 500) };
		}
		const claimDeadline = Date.now() + CLAIM_TIMEOUT_MS;
		const mailName = `${mailId}.json`;
		while (!isMailDone(sessionId, mailId)) {
			if (Date.now() > deadline) return { outcome: "failed", detail: "headless run timed out" };
			if (Date.now() > claimDeadline && listNewMail(sessionId).includes(mailName)) {
				return { outcome: "held", detail: "the headless host did not claim the mail" };
			}
			if (child?.exitCode !== null && child?.exitCode !== undefined) {
				return { outcome: "failed", detail: `headless host exited with code ${child.exitCode}` };
			}
			await Bun.sleep(POLL_MS);
		}
		await client.waitForSettled(Math.max(1, deadline - Date.now()));
		return turnError ? { outcome: "failed", detail: turnError } : { outcome: "delivered" };
	} catch (error) {
		return { outcome: "failed", detail: String(error instanceof Error ? error.message : error).slice(0, 500) };
	} finally {
		// Closing stdin is the host's normal shutdown: it disposes the session and exits.
		const running = child;
		if (running && running.exitCode === null) {
			try {
				running.stdin.end();
			} catch (error) {
				logger.debug("closing headless host stdin failed", { error: String(error) });
			}
			await Promise.race([running.exited.catch(() => undefined), Bun.sleep(EXIT_GRACE_MS)]);
		}
		await client.stop();
	}
}
