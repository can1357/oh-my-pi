import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vcs from "@oh-my-pi/pi-natives/vcs";
import { hashPath, isEnoent, logger, resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import { callOvnfs, checkoutStem, type NewReply, removeCheckout } from "../ovnfs/checkouts";
import { callSocket, OvnfsError, socketFeatures } from "../ovnfs/client";
import { runningDaemon, startDaemon } from "../ovnfs/daemon";
import type { OvnfsCheckout, SessionWorktree, WorktreeBackend } from "./backend";
import { type OvnfsRecord, readOvnfsRecords, writeOvnfsRecord } from "./ovnfs-records";

interface Checkout {
	name: string;
	path: string;
	source: string;
	created: string;
}

interface InventoryEntry {
	record: OvnfsRecord;
	state: "live" | "offline" | "removed";
}

function checkoutName(branch: string, primary: string): string {
	return `${checkoutStem(branch, 56) || "wt"}-${hashPath(primary)}`;
}

async function checkoutRepo(root: string) {
	try {
		await fs.stat(path.join(root, ".git"));
	} catch (err) {
		if (isEnoent(err)) return null;
		throw err;
	}
	return vcs.requireGit(root);
}

async function getCheckouts(socket: string): Promise<Checkout[]> {
	const reply = await callSocket<{ checkouts: Checkout[] | null }>(socket, "ls", {}, AbortSignal.timeout(3000));
	return reply.checkouts ?? [];
}

async function inventory(command: string | undefined): Promise<InventoryEntry[]> {
	const records = await readOvnfsRecords();
	const commands = new Set(records.filter(record => !record.removed).map(record => record.command));
	if (command) commands.add(command);
	const running = new Map<string, Checkout[]>();
	await Promise.all(
		[...commands].map(async executable => {
			try {
				const daemon = await runningDaemon(executable);
				if (daemon) running.set(executable, await getCheckouts(daemon.socket));
			} catch (error) {
				logger.debug("ovnfs worktree discovery unavailable", { executable, error });
			}
		}),
	);
	const occupied = new Set<string>();
	const available = new Map<string, OvnfsRecord>();
	const entries: InventoryEntry[] = records.map(record => {
		const checkouts = running.get(record.command);
		const live =
			!record.removed && checkouts?.find(item => item.name === record.checkout && item.created === record.created);
		if (live) available.set(resolveEquivalentPath(live.path), record);
		return { record, state: live ? "live" : record.removed || checkouts ? "removed" : "offline" };
	});
	// Before provenance records, /wt used this exact name for the checked-out branch.
	// Do not classify unrelated checkouts or task isolation by a hash suffix alone.
	for (const [executable, checkouts] of running) {
		for (const item of checkouts) {
			const root = resolveEquivalentPath(item.path);
			occupied.add(root);
			if (available.has(root) || !item.created || !/-[a-f0-9]{7}$/.test(item.name)) continue;
			const source = resolveEquivalentPath(item.source);
			const primary = vcs.git(source)?.primaryRoot() ?? source;
			if (!item.name.endsWith(`-${hashPath(primary)}`)) continue;
			const branch = await (await checkoutRepo(root))?.currentBranch();
			if (!branch || item.name !== checkoutName(branch, primary)) continue;
			const record = { command: executable, checkout: item.name, created: item.created, root, source };
			available.set(root, record);
			entries.push({ record, state: "live" });
		}
	}
	return entries.filter(({ record, state }) => state === "live" || !occupied.has(record.root));
}

function identity(wt: SessionWorktree): OvnfsCheckout {
	if (!wt.ovnfs) throw new Error(`Not an ovnfs worktree: ${wt.path}`);
	return wt.ovnfs;
}

async function checkoutExists(socket: string, record: OvnfsCheckout): Promise<boolean> {
	const found = (await getCheckouts(socket)).find(item => item.name === record.checkout);
	return found !== undefined && found.created === record.created;
}

async function removeRecorded(record: OvnfsRecord, options: { keepCommits?: boolean } = {}): Promise<void> {
	const { socket } = await startDaemon(record.command);
	if (await checkoutExists(socket, record)) {
		if (options.keepCommits && !(await socketFeatures(socket)).has("rm.keep_commits")) {
			throw new Error("Update ovnfs before clearing worktrees: the daemon cannot protect unpublished commits.");
		}
		await removeCheckout(record.command, record.checkout, options);
	}
	await writeOvnfsRecord({ ...record, removed: true });
}

/** Private Git checkout implementation; discovery also uses previously recorded executables. */
export function ovnfsWorktree(command?: string): WorktreeBackend {
	return {
		async create({ repository, branch, sourceCwd, baseCommit, keptChanges }) {
			if (!command) throw new Error("ovnfs is not available");
			const source = repository.info().repoRoot;
			const name = checkoutName(branch, repository.primaryRoot());
			let reply: NewReply;
			try {
				reply = await callOvnfs<NewReply>(command, "new", {
					dir: source,
					name,
					rev: keptChanges ? undefined : baseCommit,
				});
			} catch (err) {
				if (err instanceof OvnfsError && err.code === "exists") {
					throw new Error(
						`ovnfs checkout ${name} already exists; pick another branch name or remove it with \`ovnfs rm ${name}\`.`,
					);
				}
				throw err;
			}
			try {
				if (!reply.checkout.created) throw new Error("ovnfs did not return a checkout identity");
				const root = await fs.realpath(reply.checkout.path);
				await vcs.requireGit(root).checkoutNewBranch(branch);
				const record = {
					command,
					checkout: name,
					created: reply.checkout.created,
					root,
					source: resolveEquivalentPath(source),
				};
				await writeOvnfsRecord(record);
				return { path: root, branch, sourceCwd, baseCommit, keptChanges, ovnfs: record };
			} catch (err) {
				await removeCheckout(command, name).catch(error =>
					logger.warn("failed to remove incomplete ovnfs worktree", { name, error }),
				);
				throw err;
			}
		},
		async inspect(wt) {
			const record = identity(wt);
			const { socket } = await startDaemon(record.command);
			const repo = (await checkoutExists(socket, record)) ? await checkoutRepo(wt.path) : null;
			return { checkout: repo, branchRepo: repo, missingBranchRepoMeansMoved: false };
		},
		async remove(wt, moved) {
			const { command, checkout, created } = identity(wt);
			const record = (await readOvnfsRecords()).find(
				record => record.command === command && record.checkout === checkout && record.created === created,
			);
			if (!record) throw new Error(`No ovnfs worktree record for ${wt.path}`);
			if (moved) {
				const { socket } = await startDaemon(command);
				if (!(await checkoutExists(socket, record)))
					throw new Error(`Worktree ${wt.path} is no longer the original checkout.`);
				const ref = `refs/heads/${wt.branch}`;
				const source = vcs.requireGit(record.source);
				// A normal push refuses to overwrite a divergent branch created in the source since /wt.
				await vcs.requireGit(wt.path).push({ remote: source.info().repoRoot, refspec: `${ref}:${ref}` });
			}
			await removeRecorded(record);
		},
		async managed() {
			const entries = (await inventory(command)).filter(entry => entry.state !== "removed");
			return Promise.all(
				entries.map(async ({ record, state }) => ({
					path: record.root,
					kind: "ovnfs" as const,
					parentRepo: record.source,
					branch:
						state === "live"
							? ((await (await checkoutRepo(record.root))?.currentBranch()) ?? undefined)
							: undefined,
					orphanReason: state === "live" && !vcs.git(record.source) ? "source repository missing" : undefined,
					remove: () => removeRecorded(record, { keepCommits: true }),
				})),
			);
		},
		async locations() {
			return (await inventory(command)).map(({ record, state }) => ({
				root: record.root,
				source: record.source,
				offline: state === "offline",
				removed: state === "removed",
			}));
		},
	};
}
