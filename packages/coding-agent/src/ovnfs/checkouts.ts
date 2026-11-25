/**
 * Checkout operations on the daemon an ovnfs command manages, shared by
 * isolated subagent workspaces (`task/ovnfs.ts`) and `/wt` session checkouts
 * (`session/session-worktree.ts`).
 *
 * @example
 * const reply = await newCheckout("ovnfs", { dir: repoRoot, name: "wt-fix-1a2b3c4", session: sessionId });
 * await removeCheckout("ovnfs", reply.checkout.name);
 */
import { callSocket, OvnfsError, socketFeatures } from "./client";
import { forgetDaemon, startDaemon } from "./daemon";

/** The fields of ovnfs's `new` (`api.NewArgs`) omp sends. */
export interface NewArgs {
	/** Folder to capture; exactly one of `dir` and `base`. */
	dir?: string;
	/** Capture id, or a checkout standing for its capture, to open on as it was taken. */
	base?: string;
	name: string;
	/** Commit or local branch to start at; folder only. */
	rev?: string;
	/** Agent session opening the checkout, which `ovnfs ls` shows as SESSION. */
	session?: string;
}

/** The parts of ovnfs's `new` reply omp reads. */
export interface NewReply {
	checkout: { name: string; path: string; base: string; created: string };
	/** How the folder was captured; absent for a checkout from a snapshot. */
	capture?: { root: string; repos: string[] | null };
}

/**
 * Open a checkout (`new`) on the daemon `command` manages. A daemon refuses
 * fields it does not know, so one without the `new.session` feature gets
 * `args` without `session`.
 */
export async function newCheckout(command: string, args: NewArgs): Promise<NewReply> {
	const { session, ...rest } = args;
	const recorded = session && (await socketFeatures((await startDaemon(command)).socket)).has("new.session");
	return callOvnfs<NewReply>(command, "new", recorded ? args : rest);
}

/** One operation on the daemon `command` manages, starting it again once if it went away. */
export async function callOvnfs<T>(command: string, op: string, args: object): Promise<T> {
	const { socket } = await startDaemon(command);
	try {
		return await callSocket<T>(socket, op, args);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		if (code !== "ECONNREFUSED" && code !== "ENOENT") throw err;
		forgetDaemon(command);
		return callSocket<T>((await startDaemon(command)).socket, op, args);
	}
}

/** Remove a checkout; one already gone counts as removed. */
export async function removeCheckout(
	command: string,
	checkout: string,
	options: { keepCommits?: boolean } = {},
): Promise<void> {
	try {
		await callOvnfs(command, "rm", { checkout, keep_commits: options.keepCommits });
	} catch (err) {
		if (!(err instanceof OvnfsError && err.code === "not_found")) throw err;
	}
}

/**
 * `text` lowercased and cut to `max` characters as the start of a checkout name
 * ovnfs accepts (`[a-z0-9][a-z0-9._-]{0,63}`); empty when `text` holds no
 * letter or digit.
 */
export function checkoutStem(text: string, max: number): string {
	return text
		.toLowerCase()
		.replace(/[^a-z0-9._-]+/g, "-")
		.replace(/^[^a-z0-9]+/, "")
		.slice(0, max);
}
