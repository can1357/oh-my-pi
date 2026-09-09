/**
 * Edit benchmark task definitions loaded from fixtures.
 *
 * Supports loading from either:
 * - A fixtures directory (for development)
 * - A fixtures.tar.gz tarball (for distribution)
 */
/// <reference types="./bun-imports.d.ts" />
import * as fs from "node:fs/promises";
import * as path from "node:path";

export interface EditTask {
	id: string;
	name: string;
	prompt: string;
	files: string[];
	metadata?: TaskMetadata;
	inputDir: string;
	expectedDir: string;
}

export interface TaskMetadata {
	seed?: number;
	mutationType?: string;
	mutationCategory?: string;
	difficulty?: string;
	difficultyScore?: number;
	filePath?: string;
	fileName?: string;
	lineNumber?: number;
	originalSnippet?: string;
	mutatedSnippet?: string;
}

function titleize(id: string): string {
	return id
		.split(/[-_]/)
		.map(part => (part ? part[0].toUpperCase() + part.slice(1) : part))
		.join(" ");
}

async function listFiles(rootDir: string, subPath = ""): Promise<string[]> {
	const entries = await fs.readdir(path.join(rootDir, subPath), { withFileTypes: true });
	const files: string[] = [];

	for (const entry of entries) {
		const relativePath = path.join(subPath, entry.name);
		const absolutePath = path.join(rootDir, relativePath);
		if (entry.isDirectory()) {
			files.push(...(await listFiles(rootDir, relativePath)));
		} else if (entry.isFile()) {
			files.push(relativePath);
		} else if (entry.isSymbolicLink()) {
			const stats = await fs.stat(absolutePath).catch(() => null);
			if (stats?.isFile()) {
				files.push(relativePath);
			}
		}
	}

	return files.sort();
}

export async function loadTasksFromDir(fixturesDir: string): Promise<EditTask[]> {
	const entries = await fs.readdir(fixturesDir, { withFileTypes: true });
	const tasks: EditTask[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const challengeDir = path.join(fixturesDir, entry.name);
		const promptPath = path.join(challengeDir, "prompt.md");
		const inputDir = path.join(challengeDir, "input");
		const expectedDir = path.join(challengeDir, "expected");
		const metadataPath = path.join(challengeDir, "metadata.json");

		const promptFile = Bun.file(promptPath);
		if (!(await promptFile.exists())) {
			throw new Error(`Missing prompt.md for ${entry.name}`);
		}

		const inputDirStat = await fs.stat(inputDir).catch(() => null);
		if (!inputDirStat?.isDirectory()) {
			throw new Error(`Missing input directory for ${entry.name}`);
		}

		const expectedDirStat = await fs.stat(expectedDir).catch(() => null);
		if (!expectedDirStat?.isDirectory()) {
			throw new Error(`Missing expected directory for ${entry.name}`);
		}

		const prompt = (await promptFile.text()).trim();
		const files = await listFiles(inputDir);
		const metadata = await loadMetadata(metadataPath);

		tasks.push({
			id: entry.name,
			name: titleize(entry.name),
			prompt,
			inputDir,
			expectedDir,
			files,
			metadata,
		});
	}

	return tasks.sort((a, b) => a.id.localeCompare(b.id));
}

export interface FixtureValidationIssue {
	taskId: string;
	message: string;
}

export async function validateFixturesFromDir(fixturesPath: string): Promise<FixtureValidationIssue[]> {
	const entries = await fs.readdir(fixturesPath, { withFileTypes: true });
	const issues: FixtureValidationIssue[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const taskId = entry.name;
		const challengeDir = path.join(fixturesPath, entry.name);
		const promptPath = path.join(challengeDir, "prompt.md");
		const inputDir = path.join(challengeDir, "input");
		const expectedDir = path.join(challengeDir, "expected");
		const metadataPath = path.join(challengeDir, "metadata.json");

		const promptFile = Bun.file(promptPath);
		if (!(await promptFile.exists())) {
			issues.push({ taskId, message: "prompt.md is missing" });
		} else if ((await promptFile.text()).trim().length === 0) {
			issues.push({ taskId, message: "prompt.md is empty" });
		}

		const inputDirStat = await fs.stat(inputDir).catch(() => null);
		if (!inputDirStat?.isDirectory()) {
			issues.push({ taskId, message: "input directory is missing" });
		}
		const expectedDirStat = await fs.stat(expectedDir).catch(() => null);
		if (!expectedDirStat?.isDirectory()) {
			issues.push({ taskId, message: "expected directory is missing" });
		}

		const inputFiles = inputDirStat?.isDirectory() ? await listFiles(inputDir) : [];
		const expectedFiles = expectedDirStat?.isDirectory() ? await listFiles(expectedDir) : [];

		if (inputFiles.length === 0) {
			issues.push({ taskId, message: "input directory is empty" });
		}
		if (expectedFiles.length === 0) {
			issues.push({ taskId, message: "expected directory is empty" });
		}

		for (const file of inputFiles) {
			const content = await Bun.file(path.join(inputDir, file)).text();
			if (content.length === 0) {
				issues.push({ taskId, message: `input/${file} is empty` });
			}
		}
		for (const file of expectedFiles) {
			const content = await Bun.file(path.join(expectedDir, file)).text();
			if (content.length === 0) {
				issues.push({ taskId, message: `expected/${file} is empty` });
			}
		}

		const metadataFile = Bun.file(metadataPath);
		if (!(await metadataFile.exists())) {
			issues.push({ taskId, message: "metadata.json is missing" });
			continue;
		}
		let metadata: Record<string, unknown> | undefined;
		try {
			metadata = JSON.parse(await metadataFile.text()) as Record<string, unknown>;
		} catch (err) {
			const error = err instanceof Error ? err.message : String(err);
			issues.push({ taskId, message: `metadata.json is invalid JSON: ${error}` });
			continue;
		}

		if (typeof metadata.file_path !== "string" || metadata.file_path.trim().length === 0) {
			issues.push({ taskId, message: "metadata.json missing file_path" });
			continue;
		}
		const fileName = path.basename(metadata.file_path);
		if (!inputFiles.some(file => path.basename(file) === fileName)) {
			issues.push({
				taskId,
				message: `metadata file_path ${metadata.file_path} not found in input files`,
			});
		}
		if (!expectedFiles.some(file => path.basename(file) === fileName)) {
			issues.push({
				taskId,
				message: `metadata file_path ${metadata.file_path} not found in expected files`,
			});
		}
	}

	return issues;
}

async function loadMetadata(metadataPath: string): Promise<TaskMetadata | undefined> {
	const metadataFile = Bun.file(metadataPath);
	const exists = await metadataFile.exists();
	if (!exists) {
		return undefined;
	}
	const raw = (await metadataFile.json()) as Record<string, unknown>;
	return parseTaskMetadata(raw);
}

function parseTaskMetadata(raw: Record<string, unknown> | undefined): TaskMetadata | undefined {
	if (!raw) {
		return undefined;
	}
	const metadata: TaskMetadata = {};
	if (typeof raw.seed === "number") {
		metadata.seed = raw.seed;
	}
	if (typeof raw.mutation_type === "string") {
		metadata.mutationType = raw.mutation_type;
	}
	if (typeof raw.mutation_category === "string") {
		metadata.mutationCategory = raw.mutation_category;
	}
	if (typeof raw.category === "string" && !metadata.mutationCategory) {
		metadata.mutationCategory = raw.category;
	}
	if (typeof raw.mutationType === "string" && !metadata.mutationType) {
		metadata.mutationType = raw.mutationType;
	}
	if (typeof raw.mutationCategory === "string" && !metadata.mutationCategory) {
		metadata.mutationCategory = raw.mutationCategory;
	}
	if (typeof raw.difficulty === "string") {
		metadata.difficulty = raw.difficulty;
	}
	if (typeof raw.difficulty_score === "number") {
		metadata.difficultyScore = raw.difficulty_score;
	}
	if (typeof raw.difficultyScore === "number" && metadata.difficultyScore === undefined) {
		metadata.difficultyScore = raw.difficultyScore;
	}
	if (typeof raw.file_path === "string") {
		metadata.filePath = raw.file_path;
	}
	if (typeof raw.line_number === "number") {
		metadata.lineNumber = raw.line_number;
	}
	if (typeof raw.original_snippet === "string") {
		metadata.originalSnippet = raw.original_snippet;
	}
	if (typeof raw.mutated_snippet === "string") {
		metadata.mutatedSnippet = raw.mutated_snippet;
	}
	if (typeof raw.fileName === "string") {
		metadata.fileName = raw.fileName;
	}
	if (!metadata.fileName && typeof metadata.filePath === "string" && metadata.filePath.trim().length > 0) {
		metadata.fileName = path.basename(metadata.filePath);
	}
	return Object.keys(metadata).length > 0 ? metadata : undefined;
}
