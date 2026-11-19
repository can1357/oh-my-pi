import * as path from "node:path";

export function safeExportPath(root: string, requestedName: string): string {
	const canonicalRoot = path.resolve(root);
	const candidate = path.resolve(canonicalRoot, requestedName);
	if (candidate !== canonicalRoot && !candidate.startsWith(`${canonicalRoot}${path.sep}`)) {
		throw new Error("requested path escapes export root");
	}
	return candidate;
}
