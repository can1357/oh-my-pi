const INTERACTIVE_ROLES: Readonly<Record<string, true>> = {
	button: true,
	link: true,
	textbox: true,
	combobox: true,
	listbox: true,
	checkbox: true,
	radio: true,
	tab: true,
	menuitem: true,
	menuitemcheckbox: true,
	menuitemradio: true,
	slider: true,
	switch: true,
	option: true,
	spinbutton: true,
	searchbox: true,
};

const EMPTY_STRUCTURAL_ROLES: Readonly<Record<string, true>> = {
	generic: true,
	none: true,
	group: true,
};

/** Snapshot post-processing switches independent of Playwright's renderer. */
export interface SnapshotPostProcessOptions {
	/** Keep interactive nodes and the structural path leading to them. */
	interactive?: boolean;
	/** Remove unnamed structural wrappers that do not contain interactive controls. */
	compact?: boolean;
	/** Append resolved link destinations to link entries. */
	urls?: boolean;
}

/** A resolved link destination keyed by its ARIA snapshot ref. */
export type AriaHrefMap = Readonly<Record<string, string>>;

/** A revisioned ARIA snapshot result returned when diff mode is enabled. */
export type AriaSnapshotDiffResult =
	| { status: "full"; revision: number; snapshot: string }
	| { status: "unchanged"; revision: number }
	| { status: "delta"; revision: number; baseRevision: number; delta: string };

/** One retained baseline for a particular selector and option set. */
export interface AriaSnapshotBaseline {
	url: string;
	revision: number;
	snapshot: string;
}

interface SnapshotLine {
	text: string;
	indent: number;
	role?: string;
	name: string;
	children: SnapshotLine[];
	interactive: boolean;
	containsInteractive: boolean;
}

function lineIndent(line: string): number {
	let width = 0;
	for (const char of line) {
		if (char === " ") width++;
		else if (char === "\t") width += 2;
		else break;
	}
	return width;
}

function parseSnapshotLine(text: string): SnapshotLine {
	const body = text.trimStart().replace(/^-[ \t]*/, "");
	const role = /^([a-z][\w-]*)\b/i.exec(body)?.[1]?.toLowerCase();
	const rest = role ? body.slice(role.length) : body;
	const name = rest
		.replace(/\[[^\]]*\]/g, "")
		.replace(/:\s*$/, "")
		.trim()
		.replace(/^(?:""|'')$/, "");
	const interactive = role ? INTERACTIVE_ROLES[role] === true : false;
	return {
		text,
		indent: lineIndent(text),
		role,
		name,
		children: [],
		interactive,
		containsInteractive: interactive,
	};
}

function parseSnapshot(snapshot: string): SnapshotLine[] {
	const roots: SnapshotLine[] = [];
	const stack: SnapshotLine[] = [];
	for (const text of snapshot.split("\n")) {
		if (!text.trim()) continue;
		const node = parseSnapshotLine(text);
		while (stack.length > 0 && stack[stack.length - 1]!.indent >= node.indent) stack.pop();
		const parent = stack[stack.length - 1];
		if (parent) parent.children.push(node);
		else roots.push(node);
		stack.push(node);
	}
	const mark = (node: SnapshotLine): boolean => {
		for (const child of node.children) node.containsInteractive = mark(child) || node.containsInteractive;
		return node.containsInteractive;
	};
	for (const root of roots) mark(root);
	return roots;
}

function appendHref(text: string, role: string | undefined, hrefs: AriaHrefMap): string {
	if (role !== "link" || text.includes("[href=")) return text;
	const ref = /\[ref=(e\d+)\]/.exec(text)?.[1];
	const href = ref ? hrefs[ref] : undefined;
	if (!href) return text;
	const suffix = `[href=${JSON.stringify(href)}]`;
	return text.trimEnd().endsWith(":") ? `${text.trimEnd().slice(0, -1)} ${suffix}:` : `${text} ${suffix}`;
}

function renderSnapshot(
	nodes: readonly SnapshotLine[],
	options: SnapshotPostProcessOptions,
	hrefs: AriaHrefMap,
	indent: number,
): string[] {
	const output: string[] = [];
	for (const node of nodes) {
		if (options.interactive && !node.containsInteractive) continue;
		const promote =
			options.compact &&
			node.role !== undefined &&
			EMPTY_STRUCTURAL_ROLES[node.role] === true &&
			!node.name &&
			!node.containsInteractive;
		if (promote) {
			output.push(...renderSnapshot(node.children, options, hrefs, indent));
			continue;
		}
		const trimmed = node.text.trimStart();
		output.push(`${" ".repeat(indent)}${appendHref(trimmed, node.role, hrefs)}`);
		if (node.children.length > 0) {
			const originalStep = Math.max(2, node.children[0]!.indent - node.indent);
			output.push(...renderSnapshot(node.children, options, hrefs, indent + originalStep));
		}
	}
	return output;
}

/** Apply interactive, compact, and URL decorations to rendered ARIA YAML. */
export function postProcessAriaSnapshot(
	snapshot: string,
	options: SnapshotPostProcessOptions = {},
	hrefs: AriaHrefMap = {},
): string {
	if (!options.interactive && !options.compact && !options.urls) return snapshot;
	const roots = parseSnapshot(snapshot);
	if (roots.length === 0) return snapshot;
	const rendered = renderSnapshot(roots, options, options.urls ? hrefs : {}, roots[0]!.indent);
	return rendered.join("\n");
}

/** Extract the distinct eN refs present in rendered snapshot YAML. */
export function collectAriaSnapshotRefs(snapshot: string): string[] {
	const refs = new Set<string>();
	for (const match of snapshot.matchAll(/\[ref=(e\d+)\]/g)) refs.add(match[1]!);
	return [...refs];
}

/** Build a stable baseline key excluding the `diff` output-mode switch. */
export function ariaSnapshotBaselineKey(
	selector: string | undefined,
	options: SnapshotPostProcessOptions & {
		depth?: number;
		boxes?: boolean;
	},
): string {
	return JSON.stringify({
		selector: selector ?? null,
		depth: options.depth ?? null,
		boxes: options.boxes ?? false,
		interactive: options.interactive ?? false,
		compact: options.compact ?? false,
		urls: options.urls ?? false,
	});
}

function unifiedReplacement(oldText: string, newText: string, context = 3): string {
	const oldLines = oldText.split("\n");
	const newLines = newText.split("\n");
	let prefix = 0;
	while (prefix < oldLines.length && prefix < newLines.length && oldLines[prefix] === newLines[prefix]) prefix++;
	let suffix = 0;
	while (
		suffix < oldLines.length - prefix &&
		suffix < newLines.length - prefix &&
		oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
	)
		suffix++;
	const contextStart = Math.max(0, prefix - context);
	const oldChangeEnd = oldLines.length - suffix;
	const newChangeEnd = newLines.length - suffix;
	const contextEndCount = Math.min(context, suffix);
	const oldEnd = oldChangeEnd + contextEndCount;
	const newEnd = newChangeEnd + contextEndCount;
	const lines = [`@@ -${contextStart + 1},${oldEnd - contextStart} +${contextStart + 1},${newEnd - contextStart} @@`];
	for (let i = contextStart; i < prefix; i++) lines.push(` ${oldLines[i]}`);
	for (let i = prefix; i < oldChangeEnd; i++) lines.push(`-${oldLines[i]}`);
	for (let i = prefix; i < newChangeEnd; i++) lines.push(`+${newLines[i]}`);
	for (let i = 0; i < contextEndCount; i++) lines.push(` ${oldLines[oldChangeEnd + i]}`);
	return lines.join("\n");
}

/** Update one keyed snapshot baseline and return its compact revision result. */
export function diffAriaSnapshot(
	baselines: Map<string, AriaSnapshotBaseline>,
	key: string,
	url: string,
	snapshot: string,
): AriaSnapshotDiffResult {
	const previous = baselines.get(key);
	if (!previous) {
		baselines.set(key, { url, revision: 1, snapshot });
		return { status: "full", revision: 1, snapshot };
	}
	if (previous.url === url && previous.snapshot === snapshot) {
		return { status: "unchanged", revision: previous.revision };
	}
	const revision = previous.revision + 1;
	baselines.set(key, { url, revision, snapshot });
	if (previous.url !== url) return { status: "full", revision, snapshot };
	const delta = unifiedReplacement(previous.snapshot, snapshot);
	if (delta.length >= snapshot.length) return { status: "full", revision, snapshot };
	return { status: "delta", revision, baseRevision: previous.revision, delta };
}
