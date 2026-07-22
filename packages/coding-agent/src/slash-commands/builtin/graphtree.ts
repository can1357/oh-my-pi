import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getWorktreesDir, isEnoent } from "@pk-nerdsaver-ai/pi-utils";
import { $ } from "bun";
import { commandConsumed, parseSubcommand } from "../helpers/parse";
import type { SlashCommandResult, SlashCommandRuntime, TuiSlashCommandRuntime } from "../types";

export interface GraphTreeNode {
	id: string;
	name: string;
	branch?: string;
	worktreePath?: string;
	kind: "root" | "worktree-node" | "task-node";
	status: "active" | "idle" | "merged" | "stale";
}

async function getGraphTreeNodes(cwd: string): Promise<GraphTreeNode[]> {
	const nodes: GraphTreeNode[] = [];

	// Add root node
	let rootBranch = "main";
	try {
		const currentBranch = await $`git branch --show-current`.cwd(cwd).text();
		if (currentBranch.trim()) rootBranch = currentBranch.trim();
	} catch {
		// Ignore git branch error
	}

	nodes.push({
		id: "root",
		name: "root",
		branch: rootBranch,
		worktreePath: cwd,
		kind: "root",
		status: "active",
	});

	// Scan worktree directory (~/.omp/wt)
	const wtBase = getWorktreesDir();
	try {
		const entries = await fs.readdir(wtBase, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			const dirPath = path.join(wtBase, entry.name);
			let branch: string | undefined;

			try {
				const headContent = await fs.readFile(path.join(dirPath, "HEAD"), "utf8");
				const match = headContent.match(/^ref: refs\/heads\/(.+)$/m);
				if (match) branch = match[1].trim();
			} catch {
				// Search .git file or folder
			}

			nodes.push({
				id: entry.name,
				name: entry.name.replace(/^graphtree-/, ""),
				branch,
				worktreePath: dirPath,
				kind: "worktree-node",
				status: "active",
			});
		}
	} catch (err) {
		if (!isEnoent(err)) {
			// ignore directory scanning error if missing
		}
	}

	return nodes;
}

function renderAsciiGraphTree(nodes: GraphTreeNode[]): string {
	const lines: string[] = ["\x1b[1m\x1b[36mFractal GraphTree Workflows\x1b[0m", ""];

	const root = nodes.find(n => n.kind === "root") ?? {
		id: "root",
		name: "root",
		branch: "main",
		kind: "root",
		status: "active",
	};

	lines.push(`\x1b[32m● ${root.name}\x1b[0m \x1b[2m(branch: ${root.branch ?? "main"})\x1b[0m [HEAD]`);

	const children = nodes.filter(n => n.kind !== "root");
	if (children.length === 0) {
		lines.push("  └── \x1b[2m(No child worktree nodes active. Initialize one with /graphtree init <name>)\x1b[0m");
	} else {
		children.forEach((child, index) => {
			const isLast = index === children.length - 1;
			const prefix = isLast ? "  └── " : "  ├── ";
			const statusColor = child.status === "active" ? "\x1b[33m" : "\x1b[90m";
			const branchInfo = child.branch ? ` \x1b[2m(${child.branch})\x1b[0m` : "";
			lines.push(`${prefix}${statusColor}◆ ${child.name}\x1b[0m${branchInfo} \x1b[2m[${child.worktreePath}]\x1b[0m`);
		});
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
	const cwd = "sessionManager" in runtime ? runtime.sessionManager.getCwd() : runtime.ctx.sessionManager.getCwd();
	const { verb, rest } = parseSubcommand(args);

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
				lines.push(
					`- ${node.name} (${node.kind}): branch=${node.branch ?? "N/A"}, path=${node.worktreePath ?? "N/A"}`,
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
			const branchName = customBranch ?? `graphtree/${name}`;
			const wtDir = path.join(getWorktreesDir(), `graphtree-${name}`);

			try {
				await fs.mkdir(getWorktreesDir(), { recursive: true });
				await $`git worktree add -b ${branchName} ${wtDir}`.cwd(cwd).text();
				await output(`Created GraphTree worktree node "${name}" on branch "${branchName}".\nLocation: ${wtDir}`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
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

			const prompt = [
				`[FRACTAL GRAPHTREE MULTI-AGENT WORKFLOW]`,
				`Objective: ${rest}`,
				``,
				`Execute a Fractal tree-structured workflow:`,
				`1. Plan: Decompose the objective into discrete, parallel task nodes (Plan -> Shard -> Map -> Reduce).`,
				`2. Worktrees: Create isolated worktree nodes for independent modules/subtasks if necessary.`,
				`3. Execute: Spawn parallel subagent tasks (using agentic-mapreduce or side-agent primitives).`,
				`4. Reduce: Validate outcomes, clean up sub-nodes, and integrate results into main.`,
			].join("\n");

			return { prompt };
		}

		case "merge": {
			if (!rest) {
				await output("Usage: /graphtree merge <node-name>");
				return commandConsumed();
			}
			const nodeName = rest.trim();
			const branchName = `graphtree/${nodeName}`;

			try {
				await $`git merge --squash ${branchName}`.cwd(cwd).text();
				await output(`Squash-merged GraphTree node branch "${branchName}" into HEAD.`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				await output(`Failed to merge GraphTree node "${nodeName}": ${msg}`);
			}
			return commandConsumed();
		}

		case "prune":
		case "cleanup": {
			const wtBase = getWorktreesDir();
			let pruned = 0;
			try {
				const entries = await fs.readdir(wtBase);
				for (const entry of entries) {
					if (!entry.startsWith("graphtree-")) continue;
					const targetPath = path.join(wtBase, entry);
					try {
						await $`git worktree remove --force ${targetPath}`.cwd(cwd).text();
					} catch {
						await fs.rm(targetPath, { recursive: true, force: true });
					}
					pruned++;
				}
				await output(`Pruned ${pruned} GraphTree worktree node(s).`);
			} catch (err) {
				const msg = err instanceof Error ? err.message : String(err);
				await output(`Failed to prune GraphTree nodes: ${msg}`);
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
				"  /graphtree merge <name>                Squash-merge a completed GraphTree node into HEAD",
				"  /graphtree prune                       Clean up finished GraphTree worktree nodes",
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
