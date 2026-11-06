import * as fs from "node:fs";
import { resolveEquivalentPath } from "@oh-my-pi/pi-utils";
import { approvalCacheKeyForPath } from "../tools/approval-cache";
import { toolApprovalScopeToken } from "../tools/approval-scope";

interface TaskFileIdentity {
	dev: bigint;
	ino: bigint;
	birthtimeNs: bigint;
}

interface TaskFileSnapshot {
	path: string;
	target?: string;
	identity?: TaskFileIdentity;
	error?: string;
}

interface TaskFileApprovalState {
	files: Map<string, TaskFileSnapshot>;
	targets: string[];
}

const approvalStates = new WeakMap<object, WeakMap<object, TaskFileApprovalState>>();

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

/** Bind task files once per owner in the wrapper's invocation scope, after extension preflight. */
export function bindTaskFileApproval(
	owner: object,
	taskFiles: string[],
	resolvePath: (taskFile: string) => string | undefined,
): void {
	const scope = toolApprovalScopeToken();
	if (!scope) return;
	let owners = approvalStates.get(scope);
	if (!owners) {
		owners = new WeakMap();
		approvalStates.set(scope, owners);
	}
	if (owners.has(owner)) return;
	const files = new Map<string, TaskFileSnapshot>(
		[...new Set(taskFiles)].map(taskFile => {
			const filePath = resolvePath(taskFile);
			const snapshot =
				filePath === undefined
					? { path: taskFile, error: "does not resolve to a local file" }
					: captureTaskFile(filePath);
			return [taskFile, snapshot];
		}),
	);
	const targets = [...files.values()].flatMap(file => (file.target === undefined ? [] : [file.target]));
	owners.set(owner, { files, targets });
}

/** Query bound restriction targets, or resolve paths before binding, without changing approval state. */
export function taskFileRestrictionPaths(
	owner: object,
	taskFiles: string[],
	resolvePath: (taskFile: string) => string | undefined,
): string[] | undefined {
	const scope = toolApprovalScopeToken();
	const state = scope ? approvalStates.get(scope)?.get(owner) : undefined;
	if (state) return state.targets.length > 0 ? state.targets : undefined;
	return taskFiles.flatMap(taskFile => {
		const filePath = resolvePath(taskFile);
		return filePath === undefined ? [] : [approvalCacheKeyForPath(filePath)];
	});
}

/** Read the captured target for approval display without resolving paths or surfacing capture errors. */
export function taskFileApprovalPath(owner: object, taskFile: string): string | undefined {
	const scope = toolApprovalScopeToken();
	const snapshot = scope ? approvalStates.get(scope)?.get(owner)?.files.get(taskFile) : undefined;
	return snapshot?.target === undefined ? undefined : snapshot.path;
}

/**
 * Read a captured task file without changing approval state. Return undefined for unwrapped execution;
 * within a scope, throw if the file was not bound or its capture failed.
 * Direct calls inside another tool's scope also require a binding; they are not unwrapped execution.
 */
export function approvedTaskFile(owner: object, taskFile: string): TaskFileSnapshot | undefined {
	const scope = toolApprovalScopeToken();
	if (!scope) return undefined;
	const snapshot = approvalStates.get(scope)?.get(owner)?.files.get(taskFile);
	if (!snapshot) throw new Error("was not included in this call's approval; retry the call");
	if (snapshot.error) throw new Error(snapshot.error);
	return snapshot;
}

/** Check the opened file's identity against its approval capture; contents may still change in place. */
export function taskFileMatchesApproval(stat: fs.BigIntStats, snapshot: TaskFileSnapshot): boolean {
	const identity = snapshot.identity;
	return (
		identity !== undefined &&
		stat.dev === identity.dev &&
		stat.ino === identity.ino &&
		stat.birthtimeNs === identity.birthtimeNs
	);
}
