import { deserialize, serialize } from "bun:jsc";
import { type BigIntStats, constants } from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { FrontmatterError, isRecord, logger } from "@oh-my-pi/pi-utils";
import packageJson from "../../package.json" with { type: "json" };
import { parseConfiguredThinkingLevel } from "../thinking/levels";
import { replaceFileAtomically } from "../utils/atomic-file";
import { parseAgent } from "./agents";
import type { AgentSource } from "./task-details";
import type { AgentDefinition } from "./types";

// Release changes also invalidate parser output and tool-name normalization.
const CACHE_VERSION = `${packageJson.version}:1`;
const READ_FLAGS = constants.O_RDONLY | constants.O_NONBLOCK;

interface CachedAgent {
	signature: string;
	agent: AgentDefinition;
}

export interface AgentFileCache {
	load(filePath: string, source: AgentSource): Promise<AgentDefinition | null>;
	save(): Promise<void>;
}

const emptyCache: ReadonlyMap<string, unknown> = new Map();

async function readCache(cachePath: string): Promise<ReadonlyMap<string, unknown>> {
	try {
		const file = await fs.open(cachePath, READ_FLAGS);
		try {
			if (!(await file.stat()).isFile()) return emptyCache;
			const snapshot: unknown = deserialize(await file.readFile());
			if (isRecord(snapshot) && snapshot.version === CACHE_VERSION && snapshot.entries instanceof Map) {
				return snapshot.entries;
			}
		} finally {
			await file.close();
		}
	} catch {
		// Missing, unreadable and incompatible snapshots all fall back to Markdown.
	}
	return emptyCache;
}

function fileSignature(stat: BigIntStats): string {
	return `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeNs}:${stat.ctimeNs}`;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string");
}

function isCachedAgent(entry: unknown, filePath: string): entry is CachedAgent {
	if (!isRecord(entry) || typeof entry.signature !== "string" || !isRecord(entry.agent)) return false;
	const agent = entry.agent;
	return (
		agent.filePath === filePath &&
		(agent.source === "user" || agent.source === "project") &&
		typeof agent.name === "string" &&
		agent.name.length > 0 &&
		typeof agent.description === "string" &&
		agent.description.length > 0 &&
		typeof agent.systemPrompt === "string" &&
		(agent.tools === undefined || isStringArray(agent.tools)) &&
		(agent.spawns === undefined || agent.spawns === "*" || isStringArray(agent.spawns)) &&
		(agent.model === undefined || isStringArray(agent.model)) &&
		(agent.autoloadSkills === undefined || isStringArray(agent.autoloadSkills)) &&
		(agent.thinkingLevel === undefined ||
			(typeof agent.thinkingLevel === "string" &&
				parseConfiguredThinkingLevel(agent.thinkingLevel) === agent.thinkingLevel)) &&
		(agent.blocking === undefined || typeof agent.blocking === "boolean") &&
		(agent.structured === undefined || typeof agent.structured === "boolean") &&
		(agent.readSummarize === undefined || typeof agent.readSummarize === "boolean") &&
		(agent.prewalk === undefined || typeof agent.prewalk === "boolean" || typeof agent.prewalk === "string") &&
		(agent.advisor === undefined || typeof agent.advisor === "boolean" || typeof agent.advisor === "string")
	);
}

/** One cache per scan. Its entries accelerate parsing, never directory or roster discovery. */
export function createAgentFileCache(cachePath: string | undefined): AgentFileCache {
	const previous = cachePath ? readCache(cachePath) : undefined;
	const entries = new Map<string, CachedAgent>();
	let changed = false;
	return {
		async load(filePath, source) {
			const cached = (await previous)?.get(filePath);
			if (isCachedAgent(cached, filePath)) {
				const stat = await fs.stat(filePath, { bigint: true });
				if (!stat.isFile()) return null;
				if (cached.signature === fileSignature(stat)) {
					entries.set(filePath, cached);
					return cached.agent;
				}
			}
			// Fingerprint the handle we actually read; the path or symlink may have
			// been replaced since enumeration or the cache-hit check above.
			const file = await fs.open(filePath, READ_FLAGS);
			try {
				const stat = await file.stat({ bigint: true });
				if (!stat.isFile()) return null;
				const markdown = await file.readFile("utf8");
				if (!cachePath) return parseAgent(filePath, markdown, source, "warn");
				let agent: AgentDefinition;
				try {
					agent = parseAgent(filePath, markdown, source);
				} catch (error) {
					if (!(error instanceof FrontmatterError)) throw error;
					// The fatal attempt already logged the YAML error. Keep the lenient
					// result, but don't cache it and suppress later scan warnings.
					return parseAgent(filePath, markdown, source, "off");
				}
				// Empty allowlists may have logged a malformed-tools warning.
				if (agent.tools?.length !== 0) {
					entries.set(filePath, { signature: fileSignature(stat), agent });
					changed = true;
				}
				return agent;
			} finally {
				await file.close();
			}
		},
		async save() {
			if (!cachePath || !previous) return;
			const prior = await previous;
			if (!changed && prior.size === entries.size) return;
			const temporary = `${cachePath}.${process.pid}.${crypto.randomUUID()}.tmp`;
			try {
				const payload = serialize({ version: CACHE_VERSION, entries }, { binaryType: "nodebuffer" });
				await fs.mkdir(path.dirname(cachePath), { recursive: true });
				await fs.writeFile(temporary, payload, { flag: "wx", mode: 0o600 });
				await replaceFileAtomically(temporary, cachePath);
			} catch (error) {
				logger.debug("Failed to persist parsed task agents", { error: String(error) });
				await fs.rm(temporary, { force: true }).catch(() => {});
			}
		},
	};
}
