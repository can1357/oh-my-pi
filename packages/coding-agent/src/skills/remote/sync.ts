/**
 * Index mutation for remote skills: `add`, `sync`, `remove`, `list`.
 *
 * These are the only operations that touch the network during setup. Discovery
 * reads the index they produce and never fetches.
 */
import * as path from "node:path";
import { getAgentDir, parseFrontmatter } from "@oh-my-pi/pi-utils";
import { validateAgentSkillFrontmatter } from "../../discovery/agent-plugin-format";
import {
	MAX_SKILL_DOCUMENT_BYTES,
	listRemoteSkillFiles,
	parseRemoteSourceSpec,
	readRemoteFile,
	resolveRemoteCommit,
	type FetchFn,
} from "./source";
import {
	fileExists,
	findProjectRemoteSkillIndex,
	loadRemoteSkillDescriptors,
	projectRemoteSkillIndexPath,
	readRemoteSkillIndex,
	userRemoteSkillIndexPath,
	writeRemoteSkillIndex,
	type RemoteSkillIndexEntry,
} from "./store";
import { RemoteSkillError, type RemoteSkillDescriptor } from "./types";

export interface RemoteIndexTarget {
	/** Index file to mutate. */
	file: string;
	/** Level stored on descriptors (informational; the provider derives it from the file). */
	level: "user" | "project";
}

/** Resolve the index file for `--global` / project scope. Project is created on demand. */
export async function resolveRemoteIndexTarget(options: {
	cwd: string;
	global: boolean;
	agentDir?: string;
}): Promise<RemoteIndexTarget> {
	if (options.global) return { file: userRemoteSkillIndexPath(options.agentDir), level: "user" };
	return {
		file: (await findProjectRemoteSkillIndex(options.cwd)) ?? projectRemoteSkillIndexPath(options.cwd),
		level: "project",
	};
}

export interface RemoteAddOptions {
	cwd: string;
	global: boolean;
	agentDir?: string;
	fetch?: FetchFn;
	signal?: AbortSignal;
}

export interface RemoteAddResult {
	file: string;
	added: string[];
	updated: string[];
	/** Commit that every added/updated skill was pinned to. */
	commit: string;
}

/**
 * Register every skill in one GitHub subdirectory.
 *
 * One tree listing enumerates the skills, then one `SKILL.md` per skill is read
 * for its description. Each descriptor stores the resolved commit, so later
 * task reads are independent of branch movement.
 */
export async function addRemoteSkills(spec: string, options: RemoteAddOptions): Promise<RemoteAddResult> {
	const parsed = parseRemoteSourceSpec(spec);
	const commit = await resolveRemoteCommit(parsed.repository, parsed.ref, {
		fetch: options.fetch,
		signal: options.signal,
	});
	const files = await listRemoteSkillFiles(parsed.repository, commit, parsed.directory, {
		fetch: options.fetch,
		signal: options.signal,
	});
	if (files.length === 0) {
		const where = parsed.directory === "" ? "the repository root" : `"${parsed.directory}"`;
		throw new RemoteSkillError("INVALID_SOURCE", `no SKILL.md under ${where} of ${parsed.repository}@${commit}`);
	}
	const target = await resolveRemoteIndexTarget(options);
	const index = await readRemoteSkillIndex(target.file);
	const skills: Record<string, RemoteSkillDescriptor> = { ...index.skills };
	const added: string[] = [];
	const updated: string[] = [];
	for (const file of files) {
		const directory = path.posix.dirname(file);
		const bytes = await readRemoteFile(parsed.repository, commit, file, {
			fetch: options.fetch,
			signal: options.signal,
			maxBytes: MAX_SKILL_DOCUMENT_BYTES,
		});
		if (bytes === null) {
			throw new RemoteSkillError("NOT_FOUND", `${parsed.repository}@${commit}:${file}`);
		}
		const text = new TextDecoder().decode(bytes);
		let frontmatter: Record<string, unknown>;
		try {
			frontmatter = parseFrontmatter(text, {
				source: `${parsed.repository}:${file}`,
				level: "fatal",
				repair: false,
				rawKeys: true,
			}).frontmatter;
		} catch (error) {
			throw new RemoteSkillError("INVALID_SKILL", `${file}: malformed YAML frontmatter (${String(error)})`);
		}
		const violation = validateAgentSkillFrontmatter(frontmatter, path.posix.basename(directory));
		if (violation !== null) throw new RemoteSkillError("INVALID_SKILL", `${file}: ${violation}`);
		const name = frontmatter.name as string;
		const existing = skills[name];
		if (existing && (existing.repository !== parsed.repository || existing.directory !== directory)) {
			throw new RemoteSkillError(
				"INVALID_SOURCE",
				`${name} is already registered from ${existing.repository}#${existing.directory}; remove it first`,
			);
		}
		skills[name] = {
			name,
			description: (frontmatter.description as string).trim(),
			origin: "github",
			repository: parsed.repository,
			directory,
			ref: parsed.ref,
			commit,
		};
		(existing ? updated : added).push(name);
	}
	await writeRemoteSkillIndex(target.file, { version: 1, skills });
	return { file: target.file, added, updated, commit };
}

export interface RemoteSkillChange {
	name: string;
	from: string;
	to: string;
}

/**
 * Re-resolve the configured ref of each registered skill and repin it.
 *
 * A skill whose `ref` is already a commit is skipped: an explicit commit is a
 * request for that exact revision, not a pointer to follow.
 */
export async function syncRemoteSkills(options: {
	cwd: string;
	global?: boolean;
	names?: string[];
	agentDir?: string;
	fetch?: FetchFn;
	signal?: AbortSignal;
}): Promise<{ file: string; changes: RemoteSkillChange[] }> {
	const targets: RemoteIndexTarget[] = [];
	if (options.global === true) {
		targets.push({ file: userRemoteSkillIndexPath(options.agentDir), level: "user" });
	} else {
		const projectFile = await findProjectRemoteSkillIndex(options.cwd);
		if (projectFile) targets.push({ file: projectFile, level: "project" });
		if (options.global !== false) {
			const userFile = userRemoteSkillIndexPath(options.agentDir);
			if (await fileExists(userFile)) targets.push({ file: userFile, level: "user" });
		}
	}
	if (targets.length === 0) throw new RemoteSkillError("NOT_FOUND", "no remote skill index found");

	const selected = options.names === undefined ? undefined : new Set(options.names);
	const changes: RemoteSkillChange[] = [];
	let lastFile = targets[0]!.file;
	for (const target of targets) {
		lastFile = target.file;
		const index = await readRemoteSkillIndex(target.file);
		const skills: Record<string, RemoteSkillDescriptor> = { ...index.skills };
		for (const [name, descriptor] of Object.entries(index.skills)) {
			if (selected && !selected.has(name)) continue;
			const commit = await resolveRemoteCommit(descriptor.repository, descriptor.ref, {
				fetch: options.fetch,
				signal: options.signal,
			});
			if (commit === descriptor.commit) continue;
			const bytes = await readRemoteFile(descriptor.repository, commit, `${descriptor.directory}/SKILL.md`, {
				fetch: options.fetch,
				signal: options.signal,
				maxBytes: MAX_SKILL_DOCUMENT_BYTES,
			});
			if (bytes === null) {
				throw new RemoteSkillError(
					"NOT_FOUND",
					`${descriptor.repository}@${commit}:${descriptor.directory}/SKILL.md`,
				);
			}
			const { frontmatter } = parseFrontmatter(new TextDecoder().decode(bytes), {
				source: `${descriptor.repository}:${descriptor.directory}/SKILL.md`,
				level: "fatal",
				repair: false,
				rawKeys: true,
			});
			const violation = validateAgentSkillFrontmatter(frontmatter, path.posix.basename(descriptor.directory));
			if (violation !== null) throw new RemoteSkillError("INVALID_SKILL", `${name}: ${violation}`);
			skills[name] = {
				...descriptor,
				commit,
				description: (frontmatter.description as string).trim(),
			};
			changes.push({ name, from: descriptor.commit, to: commit });
		}
		if (changes.length > 0) await writeRemoteSkillIndex(target.file, { version: 1, skills });
	}
	return { file: lastFile, changes };
}

/** Remove skills from the index by name; returns the names actually removed. */
export async function removeRemoteSkills(options: {
	cwd: string;
	global?: boolean;
	names: string[];
	agentDir?: string;
}): Promise<{ removed: string[]; files: string[] }> {
	if (options.names.length === 0) throw new RemoteSkillError("INVALID_SOURCE", "no skill names given");
	const targets: RemoteIndexTarget[] = [];
	if (options.global === true) {
		targets.push({ file: userRemoteSkillIndexPath(options.agentDir), level: "user" });
	} else {
		const projectFile = await findProjectRemoteSkillIndex(options.cwd);
		if (projectFile) targets.push({ file: projectFile, level: "project" });
		const userFile = userRemoteSkillIndexPath(options.agentDir);
		if (await fileExists(userFile)) targets.push({ file: userFile, level: "user" });
	}
	const removed: string[] = [];
	const files: string[] = [];
	const wanted = new Set(options.names);
	for (const target of targets) {
		const index = await readRemoteSkillIndex(target.file);
		const skills: Record<string, RemoteSkillDescriptor> = {};
		let changed = false;
		for (const [name, descriptor] of Object.entries(index.skills)) {
			if (wanted.has(name)) {
				changed = true;
				removed.push(name);
				continue;
			}
			skills[name] = descriptor;
		}
		if (!changed) continue;
		await writeRemoteSkillIndex(target.file, { version: 1, skills });
		files.push(target.file);
	}
	const missing = options.names.filter(name => !removed.includes(name));
	if (missing.length > 0) {
		throw new RemoteSkillError("NOT_FOUND", `not registered: ${missing.join(", ")}`);
	}
	return { removed, files };
}

/** Registered descriptors, project shadowing user. */
export async function listRemoteSkills(options: { cwd: string; agentDir?: string }): Promise<RemoteSkillIndexEntry[]> {
	return await loadRemoteSkillDescriptors(options.cwd, options.agentDir ?? getAgentDir());
}
