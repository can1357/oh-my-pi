/**
 * `omp poke <session> <message…>`: post a message into a session's mailbox.
 *
 * A live omp that has the session open starts a turn on it (after an Esc it
 * waits for the user's next prompt unless `--force`). A session open only in
 * a process that does not deliver mail, or not open at all, holds the message
 * until it is next opened; `--resume` instead resumes a closed session
 * headless for one turn.
 */
import * as os from "node:os";
import * as path from "node:path";
import { getProjectDir } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { readSessionInfo, resolveResumableSession, type SessionInfo } from "../session/session-listing";
import { deliveryTarget, describeDeliveryTarget, newMailId, postMail } from "../mailbox/mailbox";
import { deliverHeadless } from "../mailbox/headless";

export interface PokeCommandArgs {
	session: string;
	text: string;
	from?: string;
	/** Deliver even while an Esc holds the session. */
	force: boolean;
	/** Resume the session headless when nobody has it open. */
	resume: boolean;
}

function fail(message: string): never {
	process.stderr.write(`${chalk.red(`error: ${message}`)}\n`);
	process.exit(1);
}

function out(text: string): void {
	process.stdout.write(`${text}\n`);
}

/** A session file path, or an id / id prefix searched in this project and then everywhere. */
async function resolveSession(arg: string): Promise<SessionInfo | undefined> {
	if (arg.endsWith(".jsonl") || arg.includes(path.sep)) return readSessionInfo(path.resolve(arg));
	return (await resolveResumableSession(arg, getProjectDir(), undefined, { allowGlobalFallback: true }))?.session;
}

export async function runPokeCommand(args: PokeCommandArgs): Promise<void> {
	if (!args.session || !args.text.trim()) fail("usage: omp poke <session> <message>");
	const session = await resolveSession(args.session);
	if (!session) fail(`no session matches "${args.session}"`);
	const sessionId = session.id;
	const mailId = newMailId("poke");
	await postMail({
		v: 1,
		id: mailId,
		kind: "poke",
		sessionId,
		createdAt: new Date().toISOString(),
		poke: {
			text: args.text,
			from: args.from ?? `${os.userInfo().username}@${os.hostname()} (pid ${process.pid})`,
			force: args.force || undefined,
		},
	});
	const target = deliveryTarget(sessionId);
	if (target.kind === "live") {
		out(
			`poked session ${sessionId} (mail ${mailId}): ${describeDeliveryTarget(target)}${args.force || target.deferred ? "" : " (after an Esc: with the user's next message; --force delivers at once)"}`,
		);
		return;
	}
	const held = (why: string) =>
		out(`held for session ${sessionId} (mail ${mailId}): ${why}; delivered when the session is next opened`);
	if (target.kind === "held" || !args.resume) {
		held(describeDeliveryTarget(target));
		if (target.kind === "free") out("  pass --resume to resume it headless now");
		return;
	}
	out(`resuming session ${sessionId} headless to deliver ${mailId}…`);
	const result = await deliverHeadless({ sessionId, sessionRef: session.path, cwd: session.cwd, mailId });
	switch (result.outcome) {
		case "delivered":
			out(`delivered: the session ran one turn headless (${session.path})`);
			return;
		case "live":
			out(`delivered by a live omp that opened the session meanwhile: ${result.detail ?? ""}`);
			return;
		case "held":
			held(result.detail ?? "the session is open elsewhere");
			return;
		case "failed":
			fail(`headless resume failed: ${result.detail ?? "unknown error"} (the message stays in the mailbox)`);
	}
}
