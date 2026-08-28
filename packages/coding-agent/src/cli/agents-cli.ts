/**
 * Agents CLI command handlers.
 *
 * Handles `omp agents unpack` for writing bundled agent definitions to disk.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { getAgentDir, getProjectDir, isEnoent } from "@oh-my-pi/pi-utils";
import chalk from "@oh-my-pi/pi-utils/chalk";
import { YAML } from "bun";
import { theme } from "../modes/theme/theme";
import { loadBundledAgents } from "../task/agents";
import type { AgentDefinition } from "../task/types";

export type AgentsAction = "unpack";

export interface AgentsCommandArgs {
	action: AgentsAction;
	flags: {
		force?: boolean;
		json?: boolean;
		dir?: string;
		user?: boolean;
		project?: boolean;
	};
}

interface UnpackResult {
	targetDir: string;
	total: number;
	written: string[];
	skipped: string[];
}

function writeStdout(line: string): void {
	process.stdout.write(`${line}\n`);
}

function resolveTargetDir(flags: AgentsCommandArgs["flags"]): string {
	if (flags.dir && flags.dir.trim().length > 0) {
		return path.resolve(getProjectDir(), flags.dir.trim());
	}

	if (flags.user && flags.project) {
		throw new Error("Choose either --user or --project, not both.");
	}

	if (flags.project) {
		return path.resolve(getProjectDir(), ".omp", "agents");
	}

	return path.join(getAgentDir(), "agents");
}

function toFrontmatter(agent: AgentDefinition): Record<string, unknown> {
	const frontmatter: Record<string, unknown> = {
		name: agent.name,
		description: agent.description,
	};

	if (agent.tools && agent.tools.length > 0) frontmatter.tools = agent.tools;
	if (agent.spawns !== undefined) frontmatter.spawns = agent.spawns;
	if (agent.model && agent.model.length > 0) frontmatter.model = agent.model;
	if (agent.thinkingLevel) frontmatter.thinkingLevel = agent.thinkingLevel;
	if (agent.output !== undefined) frontmatter.output = agent.output;
	if (agent.blocking) frontmatter.blocking = true;

	return frontmatter;
}

function serializeAgent(agent: AgentDefinition): string {
	const frontmatter = YAML.stringify(toFrontmatter(agent), null, 2).trimEnd();
	const body = agent.systemPrompt.trim();
	return `---\n${frontmatter}\n---\n\n${body}\n`;
}

async function unpackBundledAgents(flags: AgentsCommandArgs["flags"]): Promise<UnpackResult> {
	const targetDir = resolveTargetDir(flags);
	await fs.mkdir(targetDir, { recursive: true });

	const bundledAgents = [...loadBundledAgents()].sort((a, b) => a.name.localeCompare(b.name));
	const written: string[] = [];
	const skipped: string[] = [];

	for (const agent of bundledAgents) {
		const filePath = path.join(targetDir, `${agent.name}.md`);
		if (!flags.force) {
			try {
				await fs.stat(filePath);
				skipped.push(filePath);
				continue;
			} catch (error) {
				if (!isEnoent(error)) throw error;
			}
		}

		await Bun.write(filePath, serializeAgent(agent));
		written.push(filePath);
	}

	return {
		targetDir,
		total: bundledAgents.length,
		written,
		skipped,
	};
}

export async function runAgentsCommand(cmd: AgentsCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "unpack": {
			const result = await unpackBundledAgents(cmd.flags);
			if (cmd.flags.json) {
				writeStdout(JSON.stringify(result, null, 2));
				return;
			}

			writeStdout(chalk.bold(`Bundled agents: ${result.total}`));
			writeStdout(chalk.dim(`Target directory: ${result.targetDir}`));
			writeStdout(chalk.green(`${theme.status.success} Written: ${result.written.length}`));
			if (result.skipped.length > 0) {
				writeStdout(
					chalk.yellow(
						`${theme.status.warning} Skipped existing: ${result.skipped.length} (use --force to overwrite)`,
					),
				);
			}

			for (const filePath of result.written) {
				writeStdout(chalk.dim(`  + ${filePath}`));
			}
			for (const filePath of result.skipped) {
				writeStdout(chalk.dim(`  = ${filePath}`));
			}
			return;
		}
	}
}
