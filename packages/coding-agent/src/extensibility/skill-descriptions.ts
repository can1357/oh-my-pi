import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import { type Api, completeSimple, type Model } from "@oh-my-pi/pi-ai";
import { getAgentDir, logger, prompt } from "@oh-my-pi/pi-utils";
import type { ModelRegistry } from "../config/model-registry";
import { getModelMatchPreferences, parseModelPattern, resolveRoleSelection } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import MODEL_PRIO from "../priority.json" with { type: "json" };
import compressDescriptionPrompt from "../prompts/skills/compress-description.md" with { type: "text" };
import { Semaphore } from "../task/parallel";
import type { Skill } from "./skills";

const MAX_PREVIEW_CHARS = 100;
const MAX_COMPRESSED_CHARS = 160;
const MAX_COMPRESSED_WORDS = 12;
const inFlight = new Map<string, Promise<void>>();
const compressionSlots = new Semaphore(4);

export type SkillDescriptionCompressor = (name: string, description: string, request: string) => Promise<string>;

/** Resolve the configured fast role for each background request, without using the foreground model. */
export function createSkillDescriptionCompressor(
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
): SkillDescriptionCompressor {
	return async (_name, _description, request) => {
		const available = registry.getAvailable();
		const configured = resolveRoleSelection(["smol"], settings, available);
		let preferred: Model<Api> | undefined;
		if (!configured) {
			const preferences = getModelMatchPreferences(settings);
			for (const pattern of MODEL_PRIO.smol) {
				preferred = parseModelPattern(pattern, available, preferences).model;
				if (preferred) break;
			}
		}
		const selected =
			configured ??
			(preferred ? { model: preferred, thinkingLevel: undefined } : undefined) ??
			resolveRoleSelection(["tiny"], settings, available);
		if (!selected) throw new Error("No smol or tiny model available");
		const { model } = selected;
		const apiKey = await registry.getApiKey(model, sessionId);
		if (!apiKey) throw new Error(`No credential for ${model.provider}/${model.id}`);
		const response = await completeSimple(
			model,
			{
				messages: [{ role: "user", content: request, timestamp: Date.now() }],
			},
			{
				apiKey: registry.resolver(model, sessionId),
				sessionId,
				maxTokens: 1024,
				disableReasoning: true,
				temperature: 0,
				signal: AbortSignal.timeout(30_000),
			},
		);
		if (response.stopReason !== "stop") {
			throw new Error(`Model stopped: ${response.stopReason} ${response.errorMessage ?? ""}`);
		}
		return response.content
			.filter(block => block.type === "text")
			.map(block => block.text)
			.join("");
	};
}

function keyFor(skill: Pick<Skill, "name" | "description">): string {
	return new Bun.CryptoHasher("sha256")
		.update(compressDescriptionPrompt)
		.update("\0")
		.update(skill.name)
		.update("\0")
		.update(skill.description)
		.digest("hex");
}

/** A deterministic, bounded routing hint while model compression is pending. */
export function previewSkillDescription(description: string): string {
	const text = description.replace(/\s+/g, " ").trim();
	if (text.length <= MAX_PREVIEW_CHARS) return text;
	const boundary = text.slice(0, MAX_PREVIEW_CHARS - 1);
	const sentence = boundary.match(/^.*?[.!?](?=\s|$)/)?.[0];
	if (sentence && sentence.length >= 40) return sentence;
	const word = boundary.slice(0, boundary.lastIndexOf(" ")).trimEnd();
	return `${word || boundary}…`;
}

function validCompression(text: string): string | null {
	const line = text.trim();
	if (!line || /[\r\n]/.test(line) || line.length > MAX_COMPRESSED_CHARS) return null;
	if (line.split(/\s+/).length > MAX_COMPRESSED_WORDS) return null;
	return line;
}

function openDb(dbPath: string): Database | null {
	try {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
		const db = new Database(dbPath, { create: true });
		try {
			// Install before any lock-taking statement (SQLite cache contention, #2421).
			db.run("PRAGMA busy_timeout = 100");
			db.run("PRAGMA journal_mode=WAL");
			db.run("PRAGMA synchronous=NORMAL");
			db.run("CREATE TABLE IF NOT EXISTS skill_descriptions (key TEXT PRIMARY KEY, description TEXT NOT NULL)");
			fs.chmodSync(dbPath, 0o600);
			return db;
		} catch (error) {
			db.close();
			throw error;
		}
	} catch (error) {
		logger.warn("Skill description cache unavailable", { error: String(error) });
		return null;
	}
}

/** One prompt/session snapshot; completing a background job never mutates its rendered descriptions. */
export class SkillDescriptionCatalog {
	readonly #dbPath: string;
	readonly #compress?: SkillDescriptionCompressor;
	readonly #verbatim: boolean;
	readonly #snapshot = new Map<string, string>();

	/**
	 * `verbatim` renders every description exactly as authored: no preview truncation, no cache
	 * reads, and no compression work (`skills.compressDescriptions: false`).
	 */
	constructor(options: { dbPath?: string; compress?: SkillDescriptionCompressor; verbatim?: boolean } = {}) {
		this.#dbPath = options.dbPath ?? path.join(getAgentDir(), "skill-descriptions.db");
		this.#compress = options.compress;
		this.#verbatim = options.verbatim === true;
	}

	/** Read the session's frozen prompt hints without starting new model work. */
	snapshot(skills: readonly Skill[]): Array<Skill & { description: string }> {
		if (this.#verbatim) return skills.map(skill => ({ ...skill }));
		return skills.map(skill => ({
			...skill,
			description: this.#snapshot.get(keyFor(skill)) ?? previewSkillDescription(skill.description),
		}));
	}

	render(skills: readonly Skill[]): Array<Skill & { description: string }> {
		if (skills.length === 0) return [];
		if (this.#verbatim) return skills.map(skill => ({ ...skill }));
		const db = openDb(this.#dbPath);
		try {
			return skills.map(skill => {
				const key = keyFor(skill);
				let description = this.#snapshot.get(key);
				if (description === undefined) {
					try {
						description = db
							?.query<{ description: string }, [string]>(
								"SELECT description FROM skill_descriptions WHERE key = ?",
							)
							.get(key)?.description;
					} catch (error) {
						logger.warn("Skill description cache read failed", { error: String(error) });
					}
					if (description === undefined) {
						description = previewSkillDescription(skill.description);
						if (db) this.#schedule(key, skill);
					}
					this.#snapshot.set(key, description);
				}
				return { ...skill, description };
			});
		} finally {
			db?.close();
		}
	}

	/** Await background writes already scheduled by this catalog (for shutdown or tests). */
	async waitForPending(): Promise<void> {
		const prefix = `${this.#dbPath}:`;
		await Promise.all([...inFlight].filter(([key]) => key.startsWith(prefix)).map(([, pending]) => pending));
	}

	#schedule(key: string, skill: Skill): void {
		if (!this.#compress) return;
		const job = `${this.#dbPath}:${key}`;
		if (inFlight.has(job)) return;
		// Defer model work until the current synchronous prompt rendering has finished.
		const pending = Promise.resolve().then(async () => {
			try {
				await compressionSlots.acquire();
				try {
					const request = prompt.render(compressDescriptionPrompt, {
						name: skill.name,
						description: skill.description,
					});
					const result = validCompression(await this.#compress!(skill.name, skill.description, request));
					if (!result) throw new Error("Invalid single-line skill description (max 12 words, 160 chars)");
					const db = openDb(this.#dbPath);
					if (!db) return;
					try {
						db.run("INSERT OR REPLACE INTO skill_descriptions (key, description) VALUES (?, ?)", [key, result]);
					} finally {
						db.close();
					}
				} finally {
					compressionSlots.release();
				}
			} catch (error) {
				logger.warn("Skill description compression failed", { skill: skill.name, error: String(error) });
			} finally {
				inFlight.delete(job);
			}
		});
		inFlight.set(job, pending);
	}
}
