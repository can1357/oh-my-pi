/** Encode a canonical native path as one directory name. Only the readable prefix is lossy. */
export function encodeManagedSkillsProjectKey(projectRoot: string): string {
	const readable = projectRoot
		.replace(/[^a-zA-Z0-9._-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(-80);
	return `${readable || "project"}-${Bun.SHA256.hash(projectRoot, "hex").slice(0, 12)}`;
}
