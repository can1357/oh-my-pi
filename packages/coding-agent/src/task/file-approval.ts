import * as fs from "node:fs";
import { resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import { approvalCacheKeyForPath } from "../tools/approval-cache";
import { toolApprovalState } from "../tools/approval-scope";

interface TaskFileIdentity {
	dev: bigint;
	ino: bigint;
	birthtimeNs: bigint;
}

interface TaskFileSnapshot {
	path: string;
	target: string;
	identity?: TaskFileIdentity;
	error?: string;
}

interface TaskFileApprovalState {
	files: Map<string, TaskFileSnapshot>;
	targets: string[];
}

function captureTaskFile(taskFile: string): TaskFileSnapshot {
	let filePath = taskFile;
	let target = taskFile;
	try {
		filePath = resolveEquivalentPath(taskFile, { throughMissing: true });
		target = approvalCacheKeyForPath(filePath);
		const stat = fs.lstatSync(filePath, { bigint: true });
		if (!stat.isFile()) throw new Error("must resolve to a regular file");
		if (resolveEquivalentPath(filePath, { throughMissing: true }) !== filePath)
			throw new Error("changed while preparing approval; retry the call");
		return { path: filePath, target, identity: { dev: stat.dev, ino: stat.ino, birthtimeNs: stat.birthtimeNs } };
	} catch (error) {
		return { path: filePath, target, error: error instanceof Error ? error.message : String(error) };
	}
}

export function taskFileRestrictionPaths(
	owner: object,
	taskFiles: string[],
	resolvePath: (taskFile: string) => string | undefined,
): string[] | undefined {
	const state = toolApprovalState<TaskFileApprovalState>(owner, () => {
		const files = new Map(
			[...new Set(taskFiles)].map(taskFile => {
				const filePath = resolvePath(taskFile);
				const snapshot =
					filePath === undefined
						? { path: taskFile, target: taskFile, error: "does not resolve to a local file" }
						: captureTaskFile(filePath);
				return [taskFile, snapshot];
			}),
		);
		const targets = [...files.values()].map(file => file.target);
		return { files, targets };
	});
	if (state) return state.targets.length > 0 ? state.targets : undefined;
	return taskFiles.flatMap(taskFile => {
		const filePath = resolvePath(taskFile);
		return filePath === undefined ? [] : [approvalCacheKeyForPath(filePath)];
	});
}

export function approvedTaskFile(owner: object, taskFile: string): TaskFileSnapshot | undefined {
	const state = toolApprovalState<TaskFileApprovalState>(owner, () => ({ files: new Map(), targets: [] }));
	if (!state) return undefined;
	const snapshot = state.files.get(taskFile);
	if (!snapshot) throw new Error("was not included in this call's approval; retry the call");
	if (snapshot.error) throw new Error(snapshot.error);
	return snapshot;
}

export function taskFileMatchesApproval(stat: fs.BigIntStats, snapshot: TaskFileSnapshot): boolean {
	const identity = snapshot.identity;
	return (
		identity !== undefined &&
		stat.dev === identity.dev &&
		stat.ino === identity.ino &&
		stat.birthtimeNs === identity.birthtimeNs
	);
}
