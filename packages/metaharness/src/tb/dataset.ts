import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isEnoent } from "@oh-my-pi/pi-utils";
import { $ } from "bun";
import type { TbTask } from "./types";

interface TaskFilter {
	include?: string[];
	exclude?: string[];
}
async function directoryStat(candidate: string): Promise<"directory" | "other" | "missing"> {
	try {
		return (await fs.stat(candidate)).isDirectory() ? "directory" : "other";
	} catch (error) {
		if (isEnoent(error)) return "missing";
		throw error;
	}
}

async function validateTasksDir(tasksDir: string): Promise<string> {
	const absolute = path.resolve(tasksDir);
	try {
		const entries = await fs.readdir(absolute, { withFileTypes: true });
		for (const entry of entries) {
			if (!entry.isDirectory()) continue;
			if (await Bun.file(path.join(absolute, entry.name, "task.toml")).exists()) return absolute;
		}
	} catch (error) {
		if (isEnoent(error)) throw new Error(`Terminal-Bench tasks directory does not exist: ${absolute}`);
		throw error;
	}
	throw new Error(`Terminal-Bench tasks directory contains no task.toml files: ${absolute}`);
}

function repositoryName(source: string): string {
	const trimmed = source.replace(/\/+$/, "");
	const basename = trimmed.slice(trimmed.lastIndexOf("/") + 1).replace(/\.git$/, "");
	if (!basename) throw new Error(`Cannot determine repository name from dataset source: ${source}`);
	return basename;
}

function gitError(action: string, source: string, stderr: Uint8Array): Error {
	const detail = new TextDecoder().decode(stderr).trim();
	return new Error(`${action} ${source} failed${detail ? `: ${detail}` : ""}`);
}

export async function resolveDataset(source: string, cacheDir: string): Promise<string> {
	const sourceKind = await directoryStat(source);
	if (sourceKind === "directory") {
		const absoluteSource = path.resolve(source);
		const nestedTasks = path.join(absoluteSource, "tasks");
		const tasksDir = (await directoryStat(nestedTasks)) === "directory" ? nestedTasks : absoluteSource;
		return validateTasksDir(tasksDir);
	}
	if (sourceKind === "other") throw new Error(`Terminal-Bench dataset source is not a directory: ${source}`);

	const isGitUrl = source.startsWith("http://") || source.startsWith("https://") || source.startsWith("git@");
	if (!isGitUrl) throw new Error(`Terminal-Bench dataset source does not exist: ${source}`);

	const absoluteCache = path.resolve(cacheDir);
	await fs.mkdir(absoluteCache, { recursive: true });
	const checkoutDir = path.join(absoluteCache, repositoryName(source));
	const gitDir = path.join(checkoutDir, ".git");
	if ((await directoryStat(gitDir)) === "directory") {
		const result = await $`git pull --ff-only`.cwd(checkoutDir).quiet().nothrow();
		if (result.exitCode !== 0) throw gitError("Updating", source, result.stderr);
	} else {
		const result = await $`git clone --depth 1 ${source} ${checkoutDir}`.quiet().nothrow();
		if (result.exitCode !== 0) throw gitError("Cloning", source, result.stderr);
	}

	return validateTasksDir(path.join(checkoutDir, "tasks"));
}

function asRecord(value: unknown): Record<string, unknown> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	return value as Record<string, unknown>;
}

function asNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function stringRecord(value: unknown): Record<string, string> {
	const source = asRecord(value);
	const result: Record<string, string> = {};
	for (const key in source) result[key] = String(source[key]);
	return result;
}

function globPattern(pattern: string): RegExp {
	const escaped = pattern
		.split("*")
		.map(part => part.replace(/[\\^$.*+?()[\]{}|]/g, "\\$&"))
		.join(".*");
	return new RegExp(`^${escaped}$`);
}

export async function loadTasks(tasksDir: string, filter?: TaskFilter): Promise<TbTask[]> {
	const absoluteTasksDir = path.resolve(tasksDir);
	const entries = await fs.readdir(absoluteTasksDir, { withFileTypes: true });
	const tasks: TbTask[] = [];
	const includePatterns = (filter?.include ?? []).map(globPattern);
	const excludePatterns = (filter?.exclude ?? []).map(globPattern);

	for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
		if (!entry.isDirectory()) continue;
		if (excludePatterns.some(pattern => pattern.test(entry.name))) continue;
		if (includePatterns.length > 0 && !includePatterns.some(pattern => pattern.test(entry.name))) continue;
		const dir = path.join(absoluteTasksDir, entry.name);
		let taskToml: string;
		try {
			taskToml = await Bun.file(path.join(dir, "task.toml")).text();
		} catch (error) {
			if (isEnoent(error)) continue;
			throw error;
		}

		const parsed = asRecord(Bun.TOML.parse(taskToml));
		const environment = asRecord(parsed.environment);
		const image = environment.docker_image;
		if (typeof image !== "string" || image.length === 0) continue;
		const agent = asRecord(parsed.agent);
		const verifier = asRecord(parsed.verifier);
		const metadata = asRecord(parsed.metadata);

		tasks.push({
			name: entry.name,
			dir,
			instruction: await Bun.file(path.join(dir, "instruction.md")).text(),
			image,
			cpus: asNumber(environment.cpus, 0),
			memoryMb: asNumber(environment.memory_mb, 0),
			storageMb: asNumber(environment.storage_mb, 10_240),
			agentTimeoutSec: asNumber(agent.timeout_sec, 900),
			verifierTimeoutSec: asNumber(verifier.timeout_sec, 900),
			environmentEnv: stringRecord(environment.env),
			verifierEnv: stringRecord(verifier.env),
			difficulty:
				metadata.difficulty === undefined || metadata.difficulty === null ? "" : String(metadata.difficulty),
			category: metadata.category === undefined || metadata.category === null ? "" : String(metadata.category),
		});
	}

	return tasks;
}
