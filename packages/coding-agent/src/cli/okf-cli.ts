/**
 * OKF CLI command handlers.
 *
 * `omp okf list` — enumerate every concept discovered across the project's
 * `.wiki/` bundle and the user's `~/.ompk/okf/` bundle.
 * `omp okf show <id>` — print one concept's frontmatter summary and body.
 * `omp okf lint` — validate every discovered concept against OKF v0.1
 * conformance rules (spec §9) and exit non-zero on errors.
 *
 * Spec: https://github.com/GoogleCloudPlatform/knowledge-catalog/blob/main/okf/SPEC.md
 */
import chalk from "chalk";
import { type OkfConcept, okfCapability } from "../capability/okf";
import { loadCapability } from "../discovery";
import { lintOkfBundle, type OkfLintWarning } from "../okf/parser";

export type OkfAction = "list" | "show" | "lint";

export const OKF_ACTIONS: OkfAction[] = ["list", "show", "lint"];

export interface OkfCommandArgs {
	action: OkfAction;
	id?: string;
	flags: {
		json?: boolean;
		cwd?: string;
	};
}

function writeLine(text = ""): void {
	process.stdout.write(`${text}\n`);
}

function writeErrorLine(text: string): void {
	process.stderr.write(`${text}\n`);
}

async function loadConcepts(
	cwd: string | undefined,
): Promise<{ items: readonly OkfConcept[]; warnings: readonly string[] }> {
	const result = await loadCapability<OkfConcept>(okfCapability.id, { cwd });
	return { items: result.items, warnings: result.warnings };
}

function formatConceptSummary(concept: OkfConcept): string {
	const typeLabel = concept.type || "index/log";
	return `${chalk.bold(concept.id)}  ${chalk.dim(`[${typeLabel}]`)}  ${concept.title}`;
}

async function runList(flags: OkfCommandArgs["flags"]): Promise<void> {
	const { items, warnings } = await loadConcepts(flags.cwd);

	if (flags.json) {
		writeLine(JSON.stringify({ concepts: items, warnings }, null, 2));
		return;
	}

	if (items.length === 0) {
		writeLine(chalk.dim("No OKF concepts found. Create `.wiki/index.md` to start a knowledge bundle."));
		return;
	}

	for (const concept of items) {
		writeLine(formatConceptSummary(concept));
		if (concept.description) writeLine(`  ${chalk.dim(concept.description)}`);
	}
	writeLine();
	writeLine(chalk.dim(`${items.length} concept(s) discovered.`));
	if (warnings.length > 0) {
		writeLine(chalk.yellow(`${warnings.length} load warning(s) — run \`omp okf lint\` for details.`));
	}
}

async function runShow(id: string | undefined, flags: OkfCommandArgs["flags"]): Promise<void> {
	if (!id) {
		throw new Error("Usage: omp okf show <concept-id>");
	}
	const { items } = await loadConcepts(flags.cwd);
	const concept = items.find(item => item.id === id);
	if (!concept) {
		throw new Error(`No OKF concept found with id "${id}". Run \`omp okf list\` to see available ids.`);
	}

	if (flags.json) {
		writeLine(JSON.stringify(concept, null, 2));
		return;
	}

	writeLine(chalk.bold(concept.title));
	writeLine(chalk.dim(`id: ${concept.id}  type: ${concept.type || "(none)"}  bundle: ${concept.bundleRoot}`));
	if (concept.description) writeLine(concept.description);
	if (concept.tags.length > 0) writeLine(chalk.dim(`tags: ${concept.tags.join(", ")}`));
	writeLine();
	writeLine(concept.body);
	if (concept.links.length > 0) {
		writeLine();
		writeLine(chalk.dim("Links:"));
		for (const link of concept.links) {
			const target = link.conceptId ? `${link.target} (${link.conceptId})` : link.target;
			writeLine(`  - ${link.text || link.target} -> ${target}`);
		}
	}
}

function formatLintWarning(warning: OkfLintWarning): string {
	const color = warning.severity === "error" ? chalk.red : chalk.yellow;
	return color(`[${warning.severity}] ${warning.path}: ${warning.message}`);
}

async function runLint(flags: OkfCommandArgs["flags"]): Promise<void> {
	const { items, warnings: loadWarnings } = await loadConcepts(flags.cwd);
	const lintWarnings = lintOkfBundle(items);
	const hasErrors = lintWarnings.some(w => w.severity === "error") || loadWarnings.length > 0;

	if (flags.json) {
		writeLine(JSON.stringify({ loadWarnings, lintWarnings }, null, 2));
	} else {
		for (const warning of loadWarnings) {
			writeErrorLine(chalk.red(`[error] ${warning}`));
		}
		for (const warning of lintWarnings) {
			writeErrorLine(formatLintWarning(warning));
		}
		if (loadWarnings.length === 0 && lintWarnings.length === 0) {
			writeLine(chalk.green(`✓ ${items.length} concept(s) conform to OKF v0.1`));
		} else {
			const errorCount = lintWarnings.filter(w => w.severity === "error").length + loadWarnings.length;
			const warningCount = lintWarnings.filter(w => w.severity === "warning").length;
			writeLine();
			writeLine(chalk.dim(`${errorCount} error(s), ${warningCount} warning(s) across ${items.length} concept(s).`));
		}
	}

	if (hasErrors) process.exitCode = 1;
}

export async function runOkfCommand(cmd: OkfCommandArgs): Promise<void> {
	switch (cmd.action) {
		case "list":
			return runList(cmd.flags);
		case "show":
			return runShow(cmd.id, cmd.flags);
		case "lint":
			return runLint(cmd.flags);
		default: {
			const exhaustive: never = cmd.action;
			throw new Error(`Unknown okf action: ${String(exhaustive)}`);
		}
	}
}

export function printOkfHelp(): void {
	writeLine(`${chalk.bold("omp okf")} - Interact with the OKF (Open Knowledge Format) v0.1 knowledge bundle

${chalk.bold("Usage:")}
  omp okf <action> [id] [options]

${chalk.bold("Actions:")}
  list          List every concept discovered in .wiki/ and ~/.ompk/okf/
  show <id>     Print one concept's frontmatter summary and body
  lint          Validate concepts against OKF v0.1 conformance rules (exits 1 on error)

${chalk.bold("Options:")}
  --json        Output machine-readable JSON

${chalk.bold("Examples:")}
  omp okf list
  omp okf show concepts/agent-loop-patterns
  omp okf lint --json
`);
}
