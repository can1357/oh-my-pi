import * as path from "node:path";
import { getWorktreeDir, hashPath, prompt } from "@pk-nerdsaver-ai/pi-utils";
import { $ } from "bun";
import { PREVIEW_LIMITS, replaceTabs, shortenPath, TRUNCATE_LENGTHS, truncateToWidth } from "../../tools/render-utils";
import * as git from "../../utils/git";
import { commandConsumed, parseSubcommand } from "../helpers/parse";
import type { SlashCommandResult, SlashCommandRuntime, TuiSlashCommandRuntime } from "../types";
import graphtreeRunTemplate from "./graphtree-run.md" with { type: "text" };

const NODE_PREFIX = "graphtree";
/** A short, filesystem-safe single path segment (no separators, no leading dot). */
const NODE_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const NEW_FORMAT_RE = /^graphtree-[0-9a-f]{7}-(.+)$/;
const LEGACY_FORMAT_RE = /^graphtree-(.+)$/;
const LOCAL_BRANCH_PREFIX = "refs/heads/";

export interface GraphTreeNode {
	id: string;
	name: string;
	branch?: string;
	worktreePath?: string;
	kind: "root" | "worktree-node" | "task-node";
	status: "active" | "idle" | "merged" | "stale";
}

function isValidNodeName(name: string): boolean {
	return NODE_NAME_RE.test(name);
}

function parseNodeName(dirName: string): string | undefined {
	const newFormat = NEW_FORMAT_RE.exec(dirName);
	if (newFormat) return newFormat[1];
	const legacy = LEGACY_FORMAT_RE.exec(dirName);
	return legacy?.[1];
}

function branchFromRef(ref: string | undefined): string | undefined {
	if (!ref) return undefined;
	return ref.startsWith(LOCAL_BRANCH_PREFIX) ? ref.slice(LOCAL_BRANCH_PREFIX.length) : ref;
}

/**
 * Discover this feature's worktree nodes for the current repository.
 *
 * `git.worktree.list` is inherently repository-scoped (it reads the current
 * repo's `.git/worktrees` registrations), so every entry it returns already
 * belongs to this repository — there is no cross-repository leakage to guard
 * against here. We only need to recognize which entries are GraphTree nodes
 * (by directory-name convention) and resolve their real branch from the
 * entry itself rather than reconstructing it.
 */
async function getGraphTreeNodes(cwd: string, signal?: AbortSignal): Promise<GraphTreeNode[]> {
	const nodes: GraphTreeNode[] = [];

	const currentBranch = await git.branch.current(cwd, signal);
	const rootBranch = currentBranch ?? `detached@${(await git.head.short(cwd, 7, signal)) ?? "unknown"}`;
	nodes.push({
		id: "root",
		name: "root",
		branch: rootBranch,
		worktreePath: cwd,
		kind: "root",
		status: "active",
	});

	const entries = await git.worktree.list(cwd, signal);
	for (const entry of entries) {
		if (!entry.path || path.resolve(entry.path) === path.resolve(cwd)) continue;
		const dirName = path.basename(entry.path);
		const name = parseNodeName(dirName);
		if (!name) continue;

		let dirty = false;
		try {
			const summary = await git.status.summary(entry.path, signal);
			dirty = (summary?.staged ?? 0) > 0 || (summary?.unstaged ?? 0) > 0 || (summary?.untracked ?? 0) > 0;
		} catch {
			// Worktree may be missing on disk (administrative entry only); leave dirty=false.
		}

		nodes.push({
			id: dirName,
			name,
			branch: branchFromRef(entry.branch),
			worktreePath: entry.path,
			kind: "worktree-node",
			status: dirty ? "active" : "idle",
		});
	}

	return nodes;
}

function truncateLine(text: string): string {
	return truncateToWidth(replaceTabs(text), TRUNCATE_LENGTHS.LINE);
}

function renderAsciiGraphTree(nodes: GraphTreeNode[]): string {
	const lines: string[] = ["\x1b[1m\x1b[36mFractal GraphTree Workflows\x1b[0m", ""];

	const root = nodes.find(n => n.kind === "root") ?? {
		id: "root",
		name: "root",
		branch: "main",
		kind: "root" as const,
		status: "active" as const,
	};

	lines.push(truncateLine(`\x1b[32m● ${root.name}\x1b[0m \x1b[2m(branch: ${root.branch ?? "main"})\x1b[0m [HEAD]`));

	const children = nodes.filter(n => n.kind !== "root");
	if (children.length === 0) {
		lines.push("  └── \x1b[2m(No child worktree nodes active. Initialize one with /graphtree init <name>)\x1b[0m");
	} else {
		const shown = children.slice(0, PREVIEW_LIMITS.COLLAPSED_ITEMS);
		shown.forEach((child, index) => {
			const isLast = index === shown.length - 1 && shown.length === children.length;
			const prefix = isLast ? "  └── " : "  ├── ";
			const statusColor = child.status === "active" ? "\x1b[33m" : "\x1b[90m";
			const branchInfo = child.branch ? ` \x1b[2m(${child.branch})\x1b[0m` : "";
			const shortPath = child.worktreePath ? shortenPath(child.worktreePath) : "N/A";
			lines.push(
				truncateLine(`${prefix}${statusColor}◆ ${child.name}\x1b[0m${branchInfo} \x1b[2m[${shortPath}]\x1b[0m`),
			);
		});
		if (children.length > shown.length) {
			lines.push(`  └── \x1b[2m(+${children.length - shown.length} more; use /graphtree list to see all)\x1b[0m`);
		}
	}

	lines.push("");
	lines.push(
		"\x1b[2mUse /graphtree run <plan> to launch a multi-agent tree wave, or /graphtree help for command usage.\x1b[0m",
	);
	return lines.join("\n");
}

async function runGraphtreeCommand(
	args: string,
	runtime: SlashCommandRuntime | TuiSlashCommandRuntime,
	output: (text: string) => Promise<void> | void,
): Promise<SlashCommandResult> {
	const sessionCwd =
		"sessionManager" in runtime ? runtime.sessionManager.getCwd() : runtime.ctx.sessionManager.getCwd();
	const { verb, rest } = parseSubcommand(args);
	const requiresRepository = new Set(["", "status", "tree", "list", "init", "run", "merge", "prune", "cleanup"]);
	const repoRoot = requiresRepository.has(verb) ? await git.repo.root(sessionCwd) : sessionCwd;
	if (!repoRoot) {
		await output("GraphTree requires a Git repository. Start a session inside a repository and try again.");
		return commandConsumed();
	}
	const cwd = repoRoot;

	switch (verb) {
		case "":
		case "status":
		case "tree": {
			const nodes = await getGraphTreeNodes(cwd);
			await output(renderAsciiGraphTree(nodes));
			return commandConsumed();
		}

		case "list": {
			const nodes = await getGraphTreeNodes(cwd);
			const lines = ["Active GraphTree Worktree Nodes:"];
			for (const node of nodes) {
				const shortPath = node.worktreePath ? shortenPath(node.worktreePath) : "N/A";
				lines.push(
					truncateLine(`- ${node.name} (${node.kind}): branch=${node.branch ?? "N/A"}, path=${shortPath}`),
				);
			}
			await output(lines.join("\n"));
			return commandConsumed();
		}

		case "init": {
			if (!rest) {
				await output("Usage: /graphtree init <node-name> [branch-name]");
				return commandConsumed();
			}
			const [name, customBranch] = rest.split(/\s+/);
			if (!name || !isValidNodeName(name)) {
				await output(
					`Invalid node name "${name ?? ""}". Node names must be a single filesystem-safe segment matching ${NODE_NAME_RE.source}.`,
				);
				return commandConsumed();
			}

			const repositoryIdentity = (await git.repo.primaryRoot(cwd)) ?? cwd;
			const segment = `${NODE_PREFIX}-${hashPath(repositoryIdentity)}-${name}`;
			const wtDir = getWorktreeDir(segment);
			const branchName = customBranch ?? `graphtree/${name}`;

			try {
				// Validate (and create) the branch through Git first — an invalid ref
				// name fails here, before any worktree directory is touched.
				await git.branch.create(cwd, branchName);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				await output(`Failed to create branch "${branchName}" for node "${name}": ${msg}`);
				return commandConsumed();
			}

			try {
				await git.worktree.add(cwd, wtDir, branchName);
				await output(
					`Created GraphTree worktree node "${name}" on branch "${branchName}".\nLocation: ${shortenPath(wtDir)}`,
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				await git.branch.tryDelete(cwd, branchName, { force: true });
				await output(`Failed to initialize GraphTree node "${name}": ${msg}`);
			}
			return commandConsumed();
		}

		case "run": {
			if (!rest) {
				await output(
					"Usage: /graphtree run <plan or task description>\nLaunches a Fractal multi-agent tree workflow over parallel worktree nodes.",
				);
				return commandConsumed();
			}

			return { prompt: prompt.render(graphtreeRunTemplate, { objective: rest }) };
		}

		case "merge": {
			if (!rest) {
				await output("Usage: /graphtree merge <node-name>");
				return commandConsumed();
			}
			const nodeName = rest.trim();
			const nodes = await getGraphTreeNodes(cwd);
			const node = nodes.find(n => n.kind === "worktree-node" && n.name === nodeName);
			if (!node?.branch) {
				await output(`No GraphTree node named "${nodeName}" was found. Use /graphtree list to see active nodes.`);
				return commandConsumed();
			}

			try {
				await $`git merge --squash ${node.branch}`.cwd(cwd).text();
				await output(
					`Squash-merged GraphTree node "${nodeName}" (branch "${node.branch}") into HEAD.\n` +
						"Changes are staged in the working tree for review — commit them to finalize the merge.",
				);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				await output(`Failed to merge GraphTree node "${nodeName}": ${msg}`);
			}
			return commandConsumed();
		}

		case "prune":
		case "cleanup": {
			const nodes = (await getGraphTreeNodes(cwd)).filter(n => n.kind === "worktree-node");
			const nodeName = rest.trim();

			if (!nodeName) {
				if (nodes.length === 0) {
					await output(
						"Usage: /graphtree prune <node-name>\nNo GraphTree worktree nodes are currently registered.",
					);
				} else {
					const candidates = nodes.map(n => `  - ${n.name}${n.status === "active" ? " (dirty)" : ""}`).join("\n");
					await output(`Usage: /graphtree prune <node-name>\nCandidates:\n${candidates}`);
				}
				return commandConsumed();
			}

			const node = nodes.find(n => n.name === nodeName);
			if (!node?.worktreePath) {
				await output(`No GraphTree node named "${nodeName}" was found. Use /graphtree list to see active nodes.`);
				return commandConsumed();
			}
			if (node.status === "active") {
				await output(
					`Refusing to prune GraphTree node "${nodeName}": it has uncommitted changes. Commit, stash, or discard them first.`,
				);
				return commandConsumed();
			}

			try {
				await git.worktree.remove(cwd, node.worktreePath, { force: false });
				await output(`Pruned GraphTree worktree node "${nodeName}".`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				await output(`Failed to prune GraphTree node "${nodeName}": ${msg}`);
			}
			return commandConsumed();
		}

		default: {
			const helpText = [
				"Fractal GraphTree Workflow Commands:",
				"  /graphtree                             View active GraphTree node hierarchy (ASCII tree)",
				"  /graphtree status                      View active GraphTree node hierarchy",
				"  /graphtree list                        List details of active GraphTree nodes",
				"  /graphtree init <name> [branch]        Initialize an isolated GraphTree worktree node",
				"  /graphtree run <objective>             Launch a Fractal multi-agent tree execution plan",
				"  /graphtree merge <name>                Squash-merge a completed GraphTree node into HEAD (stages, does not commit)",
				"  /graphtree prune [name]                Remove a clean, named GraphTree worktree node (no arg: list candidates)",
				"  /graphtree help                        Show this help guide",
			].join("\n");
			await output(helpText);
			return commandConsumed();
		}
	}
}

export async function handleGraphtreeCommand(
	commandArgs: string,
	runtime: SlashCommandRuntime,
): Promise<SlashCommandResult> {
	return runGraphtreeCommand(commandArgs, runtime, runtime.output);
}

export async function handleGraphtreeCommandTui(
	commandArgs: string,
	runtime: TuiSlashCommandRuntime,
): Promise<SlashCommandResult | undefined> {
	const result = await runGraphtreeCommand(commandArgs, runtime, text => runtime.ctx.showStatus(text));
	runtime.ctx.editor.setText("");
	if (result && "prompt" in result && result.prompt) {
		return result;
	}
}
