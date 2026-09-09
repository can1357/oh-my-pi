import type { IsoBackendKind } from "@oh-my-pi/pi-natives";
import type { IsolationContext } from "../task/isolation-runner";
import { prepareIsolationContext } from "../task/isolation-runner";
import type { IsolationHandle, WorktreeBaseline } from "../task/worktree";
import { cleanupIsolation, ensureIsolation } from "../task/worktree";

export interface SecurityRemediationRequest {
	cwd: string;
	findingIds: string[];
	isolationId?: string;
	preferredBackend?: IsoBackendKind;
}

export interface SecurityRemediationWorkspace {
	id: string;
	repositoryRoot: string;
	worktreePath: string;
	findingIds: string[];
	backend: IsoBackendKind;
	fellBack: boolean;
	fallbackReason: string | null;
	cleanup(): Promise<void>;
}

export interface SecurityRemediationDependencies {
	prepareContext?: (cwd: string) => Promise<IsolationContext>;
	createIsolation?: (repositoryRoot: string, id: string, preferred?: IsoBackendKind) => Promise<IsolationHandle>;
	cleanupIsolation?: (handle: IsolationHandle) => Promise<void>;
	createId?: () => string;
}

function createRemediationId(): string {
	return `security-remediation-${Bun.randomUUIDv7().replaceAll("-", "")}`;
}

function repoBaselineDirty(baseline: WorktreeBaseline): string[] {
	const dirty: string[] = [];
	if (baseline.root.staged.trim()) dirty.push("staged changes");
	if (baseline.root.unstaged.trim()) dirty.push("unstaged changes");
	if (baseline.root.untracked.length > 0 || baseline.root.untrackedPatch.trim()) dirty.push("untracked files");
	for (const nested of baseline.nested) {
		if (
			nested.baseline.staged.trim() ||
			nested.baseline.unstaged.trim() ||
			nested.baseline.untracked.length > 0 ||
			nested.baseline.untrackedPatch.trim()
		) {
			dirty.push(`dirty nested repository ${nested.relativePath}`);
		}
	}
	return dirty;
}

export function assertSecurityRemediationBaselineClean(baseline: WorktreeBaseline): void {
	const dirty = repoBaselineDirty(baseline);
	if (dirty.length === 0) return;
	throw new Error(
		[
			`Security remediation refuses a dirty working tree (${dirty.join(", ")}).`,
			"Commit or stash the changes before creating an isolated remediation workspace.",
		].join(" "),
	);
}

export async function prepareSecurityRemediationWorkspace(
	request: SecurityRemediationRequest,
	dependencies: SecurityRemediationDependencies = {},
): Promise<SecurityRemediationWorkspace> {
	const findingIds = [...new Set(request.findingIds.map(id => id.trim()).filter(Boolean))];
	if (findingIds.length === 0) throw new Error("Security remediation requires at least one finding id");
	const prepareContext = dependencies.prepareContext ?? prepareIsolationContext;
	const createIsolation = dependencies.createIsolation ?? ensureIsolation;
	const disposeIsolation = dependencies.cleanupIsolation ?? cleanupIsolation;
	const context = await prepareContext(request.cwd);
	assertSecurityRemediationBaselineClean(context.baseline);
	const id = request.isolationId?.trim() || dependencies.createId?.() || createRemediationId();
	const handle = await createIsolation(context.repoRoot, id, request.preferredBackend);
	let cleaned = false;
	return {
		id,
		repositoryRoot: context.repoRoot,
		worktreePath: handle.mergedDir,
		findingIds,
		backend: handle.backend,
		fellBack: handle.fellBack,
		fallbackReason: handle.fallbackReason,
		async cleanup() {
			if (cleaned) return;
			cleaned = true;
			await disposeIsolation(handle);
		},
	};
}
