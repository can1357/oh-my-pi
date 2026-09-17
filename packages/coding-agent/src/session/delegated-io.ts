import * as fs from "node:fs/promises";
import path from "node:path";

/** Internal runtime capability contract; never a provider-visible task argument. */
export type DelegatedIo =
	| { kind: "evidence-digest" }
	| { kind: "code-write"; reference: string; target: string; workspaceRoot: string };

const DIGEST_TOOLS = ["read", "grep", "glob", "ast_grep", "yield"] as const;
const CODE_WRITE_TOOLS = ["read", "write", "yield"] as const;

export function delegatedIoToolNames(contract: DelegatedIo): string[] {
	return contract.kind === "evidence-digest" ? [...DIGEST_TOOLS] : [...CODE_WRITE_TOOLS];
}

export function getDelegatedIoToolBlockReason(contract: DelegatedIo | undefined, name: string): string | undefined {
	if (!contract || delegatedIoToolNames(contract).includes(name)) return undefined;
	return `[Fusion I/O] ${contract.kind} worker cannot invoke this capability. Use only its assigned native tools.`;
}

/** Realpath-equivalent for a not-yet-created leaf, preserving its missing suffix. */
export async function canonicalNewPath(filePath: string): Promise<string> {
	let ancestor = path.resolve(filePath);
	const suffix: string[] = [];
	for (;;) {
		try {
			return path.join(await fs.realpath(ancestor), ...suffix);
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ENOENT") throw error;
			// A dangling symlink is not a missing ancestor: never follow it into a future target.
			const stat = await fs.lstat(ancestor).catch(() => undefined);
			if (stat?.isSymbolicLink()) throw new Error("codeWrite rejects dangling symlinks.");
			const parent = path.dirname(ancestor);
			if (parent === ancestor) throw new Error("codeWrite target has no existing ancestor.");
			suffix.unshift(path.basename(ancestor));
			ancestor = parent;
		}
	}
}

export function isPathWithinWorkspace(root: string, candidate: string): boolean {
	const relative = path.relative(
		process.platform === "win32" ? root.toLowerCase() : root,
		process.platform === "win32" ? candidate.toLowerCase() : candidate,
	);
	return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

/** Recheck immediately at native write and parent integration boundaries. Never overwrite. */
export async function assertCodeWriteTarget(
	contract: Extract<DelegatedIo, { kind: "code-write" }>,
	requestedPath = contract.target,
): Promise<void> {
	const root = await fs.realpath(contract.workspaceRoot);
	const requested = await canonicalNewPath(requestedPath);
	const expected = await canonicalNewPath(contract.target);
	const equal =
		process.platform === "win32" ? requested.toLowerCase() === expected.toLowerCase() : requested === expected;
	if (!equal || !isPathWithinWorkspace(root, requested))
		throw new Error("codeWrite may create only its assigned target within the workspace.");
	try {
		await fs.lstat(requested);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	throw new Error("codeWrite target already exists; integration or write conflicts must not overwrite it.");
}
