import * as fs from "node:fs/promises";
import * as path from "node:path";
import { YAML } from "bun";
import { normalizeLearnedText } from "../memories";
import { scoreEvolution } from "./evolution";
import type { EvolutionReport } from "./evolution-types";

export interface LearningVaultOptions {
	root: string;
	project?: string;
	cwd: string;
}

async function vaultDirectory(root: string, kind: "Lessons" | "Evolution"): Promise<string> {
	if (!path.isAbsolute(root)) throw new Error("Auto-Learn vault path must be absolute.");
	// Never create an absent vault or silently fall back to the agent's real storage.
	const realRoot = await fs.realpath(root);
	const markers = [path.join(realRoot, ".obsidian"), path.join(realRoot, "System", "Work Record Contract.md")];
	const marked = await Promise.all(
		markers.map(file =>
			fs.stat(file).then(
				() => true,
				() => false,
			),
		),
	);
	if (!marked.some(Boolean)) throw new Error("Configured learning destination is not a recognized Obsidian vault.");
	let dir = realRoot;
	for (const part of ["Skills", "Auto-Learn", kind]) {
		dir = path.join(dir, part);
		await fs.mkdir(dir).catch(error => {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		});
		const stat = await fs.lstat(dir);
		if (!stat.isDirectory() || stat.isSymbolicLink())
			throw new Error("Learning note destination contains an unsafe link.");
	}
	return dir;
}

async function writeRecord(
	options: LearningVaultOptions,
	kind: "Lessons" | "Evolution",
	title: string,
	body: string,
	extra: Record<string, string | number>,
): Promise<string> {
	const dir = await vaultDirectory(options.root, kind);
	const id = crypto.randomUUID();
	const date = new Date().toISOString().slice(0, 10);
	const metadata = {
		id,
		type: "reference",
		title,
		state: "active",
		created: date,
		updated: date,
		source: "agent",
		version: 1,
		projectIds: options.project ? [`[[${options.project.replace(/[[\]\r\n]/g, "")}]]`] : [],
		sourceRef: normalizeLearnedText(options.cwd, 1000),
		rollup: "engineering",
		workType: "analysis",
		tags: ["autolearn", kind.toLowerCase()],
		...extra,
	};
	const file = path.join(dir, `${id}.md`);
	await fs.writeFile(file, `---\n${YAML.stringify(metadata).trimEnd()}\n---\n\n# ${title}\n\n${body}\n`, {
		flag: "wx",
		mode: 0o600,
	});
	return file;
}

/** Lessons are observations, not verified/promoted skills. Never copy raw secrets or prompt structure. */
export async function writeVaultLesson(
	options: LearningVaultOptions,
	lesson: string,
	context?: string,
): Promise<string> {
	const content = normalizeLearnedText(lesson, 16_000);
	if (!content) throw new Error("Cannot store an empty vault lesson.");
	const source = normalizeLearnedText(context ?? "", 4000);
	return writeRecord(
		options,
		"Lessons",
		"Captured Auto-Learn lesson",
		`## Learning\n\n${content}\n\n## Context\n\n${source || "Not supplied."}\n\n## Verification\n\nCaptured observation, not independently verified. Skill evaluation and promotion are separate actions.`,
		{ learningStatus: "captured" },
	);
}

/** Mirror only provenance/scores, not private benchmark answers or candidate prompts. */
export async function writeVaultEvolution(
	options: LearningVaultOptions,
	report: EvolutionReport,
	auditPath: string,
): Promise<string> {
	const scores =
		report.state === "failed"
			? "Evaluation did not complete; no promotion is permitted."
			: `Training: ${scoreEvolution(report.input.training, report.baselineTraining)} → ${scoreEvolution(report.input.training, report.training)} / ${report.input.training.length}. Holdout: ${scoreEvolution(report.input.holdout, report.baselineHoldout)} → ${scoreEvolution(report.input.holdout, report.holdout)} / ${report.input.holdout.length}.`;
	const body = `## Learning\n\n${normalizeLearnedText(report.input.lessons, 16_000)}\n\n## Evaluation\n\n${scores}\n\nModel: ${normalizeLearnedText(report.model, 200)}. Calls: ${report.calls}. Status: ${report.state}.\n\n## Provenance\n\nLocal audit: ${normalizeLearnedText(auditPath, 2000)}\n\nPrivate benchmark prompts/answers and candidate bodies remain in the local audit, not this vault note. Eligibility is limited to the supplied text benchmark; it is not general skill correctness.${report.error ? `\n\nFailure: ${normalizeLearnedText(report.error, 2000)}` : ""}`;
	return writeRecord(options, "Evolution", `Skill evolution: ${report.name}`, body, {
		learningStatus: report.state,
		evolutionRunId: report.id,
	});
}
