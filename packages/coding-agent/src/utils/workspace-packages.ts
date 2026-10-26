import * as path from "node:path";

export type WorkspaceManifest = Record<string, unknown>;

function isManifest(value: unknown): value is WorkspaceManifest {
	return value !== null && typeof value === "object" && !Array.isArray(value);
}

/** Read a `package.json`-style file as an object, or `undefined` when missing or malformed. */
export async function readWorkspaceManifest(filePath: string): Promise<WorkspaceManifest | undefined> {
	try {
		const value: unknown = await Bun.file(filePath).json();
		return isManifest(value) ? value : undefined;
	} catch {
		return undefined;
	}
}

/**
 * Workspace glob patterns from a `workspaces` value: the array form or the
 * yarn-style `{ packages: [...] }` object. Negated (`!`) patterns are kept.
 */
export function workspacePatternsFromValue(value: unknown): string[] {
	const list = Array.isArray(value) ? value : isManifest(value) ? value.packages : undefined;
	return Array.isArray(list) ? list.filter((item): item is string => typeof item === "string") : [];
}

/**
 * Every workspace pattern declared at `root`: `package.json` `workspaces` plus
 * pnpm's `pnpm-workspace.yaml`. Pass an already-read root manifest to skip the
 * `package.json` read.
 */
export async function readWorkspacePatterns(root: string, rootManifest?: WorkspaceManifest): Promise<string[]> {
	const manifest = rootManifest ?? (await readWorkspaceManifest(path.join(root, "package.json")));
	const patterns = workspacePatternsFromValue(manifest?.workspaces);
	try {
		const pnpmWorkspace = Bun.YAML.parse(await Bun.file(path.join(root, "pnpm-workspace.yaml")).text()) as unknown;
		if (isManifest(pnpmWorkspace)) patterns.push(...workspacePatternsFromValue(pnpmWorkspace.packages));
	} catch {
		// package.json workspaces are sufficient when no readable pnpm manifest exists.
	}
	return [...new Set(patterns)];
}

export interface WorkspaceMember {
	root: string;
	manifest: WorkspaceManifest;
}

/**
 * Walk the members matched by `patterns` under `root`. A `!pattern` removes any
 * member whose directory (or `package.json`) it matches, whatever order the
 * patterns appear in. Members without a readable manifest are skipped.
 */
export async function* workspaceMembers(
	root: string,
	patterns: readonly string[],
	readManifest: (packageRoot: string) => Promise<WorkspaceManifest | null | undefined> = packageRoot =>
		readWorkspaceManifest(path.join(packageRoot, "package.json")),
): AsyncGenerator<WorkspaceMember> {
	const excluded = patterns
		.filter(pattern => pattern.startsWith("!"))
		.map(pattern => new Bun.Glob(pattern.slice(1).replace(/\/+$/u, "")));
	const seen = new Set<string>();
	for (const pattern of patterns) {
		if (pattern.startsWith("!")) continue;
		const glob = new Bun.Glob(path.join(pattern, "package.json"));
		for await (const match of glob.scan({ cwd: root, onlyFiles: true })) {
			const memberRoot = path.dirname(path.join(root, match));
			if (seen.has(memberRoot)) continue;
			const relativeDir = path.dirname(match).split(path.sep).join("/");
			if (relativeDir.split("/").includes("node_modules")) continue;
			if (excluded.some(glob => glob.match(relativeDir) || glob.match(`${relativeDir}/package.json`))) continue;
			seen.add(memberRoot);
			const manifest = await readManifest(memberRoot);
			if (manifest) yield { root: memberRoot, manifest };
		}
	}
}
