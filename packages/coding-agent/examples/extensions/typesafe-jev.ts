/**
 * TypeSafe Jev skill routing
 *
 * Names at most one installed skill before the chat model runs. Jev is not a
 * chat model (max output tokens 0) — do not put it in `/model`. This follows
 * call 1 of https://docs.typesafe.ai/cookbooks/skill_suggestion.md: one
 * Choice over the roster plus three gate Nouls in the same request. Typical
 * omp rosters (~40 skills) fit in one Choice; the cookbook's second request
 * (rerank the top 3 with SKILL.md excerpts) is the follow-up when lookalikes
 * collide or the roster grows past ~100.
 *
 * Injects a per-turn `<skill_relevance>` line via `systemPromptAppend`. Quiet
 * when nothing fits. Missing key, timeout, or HTTP error: fail-open.
 *
 * Usage:
 * 1. `/login typesafe` or `TYPESAFE_API_KEY` in the environment / ~/.omp/.env
 * 2. Copy this file to ~/.omp/agent/extensions/
 * 3. `/jev` prints key + roster size. Restart omp so the extension loads.
 */
import { appendFileSync, existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const BASE_URL = (process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/$/, "");
const MODEL = process.env.TYPESAFE_DEFAULT_MODEL || "jev-latest";
const HOOK_BUDGET_MS = 2500;
const MAX_CHOICES = 240;
const GATE_THRESHOLD = 0.3;
const LOG = join(homedir(), ".omp/agent/extensions/typesafe-jev.log");

const GATE_QUESTIONS = {
	acts_on_user_system:
		"Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
	would_follow_documented_procedure:
		"Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?",
	prose_suffices:
		"Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
} as const;
const INVERTED = new Set(["prose_suffices"]);

type Skill = { name: string; description: string };

function loadKey(): string {
	if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
	for (const file of [join(homedir(), ".omp/.env")]) {
		try {
			for (const line of readFileSync(file, "utf8").split("\n")) {
				if (line.startsWith("TYPESAFE_API_KEY=")) {
					const v = line.slice("TYPESAFE_API_KEY=".length).trim().replace(/^['"]|['"]$/g, "");
					if (v) return v;
				}
			}
		} catch {
			/* missing file */
		}
	}
	return "";
}

function parseFrontmatter(text: string): { name?: string; description?: string } {
	if (!text.startsWith("---")) return {};
	const end = text.indexOf("\n---", 3);
	if (end < 0) return {};
	const block = text.slice(3, end);
	const out: { name?: string; description?: string } = {};
	let current: "name" | "description" | null = null;
	let folded = "";
	for (const raw of block.split("\n")) {
		if (/^\s/.test(raw) && current === "description") {
			folded += " " + raw.trim();
			continue;
		}
		if (current === "description") {
			out.description = folded.trim();
			current = null;
		}
		const m = raw.match(/^(name|description):\s*(.*)$/);
		if (!m) continue;
		const key = m[1] as "name" | "description";
		const val = m[2].trim();
		if (key === "description" && (val === ">" || val === "|")) {
			current = "description";
			folded = "";
			continue;
		}
		out[key] = val.replace(/^['"]|['"]$/g, "");
	}
	if (current === "description") out.description = folded.trim();
	return out;
}

function skillDirs(cwd?: string): string[] {
	const home = homedir();
	const dirs = [
		join(home, ".omp/skills"),
		join(home, ".omp/agent/managed-skills"),
		join(home, ".agents/skills"),
	];
	if (cwd) {
		dirs.push(join(cwd, ".omp/skills"), join(cwd, ".agents/skills"));
	}
	return dirs;
}

function loadRoster(cwd?: string): Skill[] {
	const seen = new Set<string>();
	const skills: Skill[] = [];
	for (const root of skillDirs(cwd)) {
		if (!existsSync(root)) continue;
		let entries: string[] = [];
		try {
			entries = readdirSync(root);
		} catch {
			continue;
		}
		for (const name of entries) {
			const skillMd = join(root, name, "SKILL.md");
			if (!existsSync(skillMd) || seen.has(name)) continue;
			try {
				const meta = parseFrontmatter(readFileSync(skillMd, "utf8"));
				const id = (meta.name || name).trim();
				if (!id || id.length > 64) continue;
				seen.add(name);
				seen.add(id);
				skills.push({
					name: id,
					description: (meta.description || id).replace(/\s+/g, " ").slice(0, 120),
				});
			} catch {
				/* skip unreadable skill */
			}
		}
	}
	return skills.slice(0, MAX_CHOICES);
}

function log(kind: string, detail: string): void {
	try {
		appendFileSync(LOG, `${new Date().toISOString()}\t${kind}\t${detail}\n`);
	} catch {
		/* diagnostics only */
	}
}

function gateMean(answers: Record<string, { noul?: number } | undefined>): number {
	const values: number[] = [];
	for (const key of Object.keys(GATE_QUESTIONS)) {
		const noul = Number(answers[`gate::${key}`]?.noul ?? 0);
		values.push(INVERTED.has(key) ? 1 - noul : noul);
	}
	if (values.length === 0) return 0;
	return values.reduce((a, b) => a + b, 0) / values.length;
}

async function systemone(
	key: string,
	state: unknown,
	questions: Record<string, unknown>,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<any> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	if (signal) {
		if (signal.aborted) ac.abort();
		else signal.addEventListener("abort", () => ac.abort(), { once: true });
	}
	try {
		const res = await fetch(`${BASE_URL}/v1/systemone`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ state, model: MODEL, questions }),
			signal: ac.signal,
		});
		if (!res.ok) {
			const body = await res.text().catch(() => "");
			throw new Error(`TypeSafe ${res.status} ${body.slice(0, 180)}`);
		}
		return await res.json();
	} finally {
		clearTimeout(timer);
	}
}

async function route(
	prompt: string,
	key: string,
	skills: Skill[],
): Promise<string | undefined> {
	if (!prompt.trim() || prompt.trim().startsWith("/")) return;
	if (skills.length < 2) return;

	const criteria: Record<string, string | null> = {};
	for (const skill of skills) criteria[skill.name] = skill.description;

	const questions: Record<string, unknown> = {
		which: {
			type: "choice",
			instructions:
				"Which of these skills, if any, is the right one to load to help with the user's latest request?",
			criteria,
		},
	};
	for (const [key, text] of Object.entries(GATE_QUESTIONS)) {
		questions[`gate::${key}`] = { type: "noul", instructions: text };
	}

	const started = Date.now();
	const body = await systemone(
		key,
		{ request: prompt.slice(0, 4000), recent_context: "" },
		questions,
		HOOK_BUDGET_MS,
	);
	const which = body?.answers?.which;
	const choice = String(which?.choice || "");
	const p = Number(which?.probabilities?.[choice] ?? 0);
	const gate = gateMean(body?.answers || {});
	log(
		"suggest",
		`${choice || "-"} gate=${gate.toFixed(3)} p=${p.toFixed(3)} ${(Date.now() - started) / 1000}s model=${body?.model || "?"}`,
	);
	if (!choice || gate < GATE_THRESHOLD) return;
	return [
		"<skill_relevance>",
		`Relevant to the current request: ${choice}. Ignore this if it does not fit what the user actually asked for.`,
		"</skill_relevance>",
	].join("\n");
}

export default function typesafeJev(pi: ExtensionAPI) {
	pi.setLabel("TypeSafe Jev skill routing");
	const key = loadKey();
	const skills = loadRoster();

	pi.on("before_agent_start", async (event, ctx) => {
		if (!key) return;
		try {
			const roster = skills.length >= 2 ? skills : loadRoster(ctx.cwd);
			const block = await route(event.prompt, key, roster);
			if (!block) return;
			return { systemPromptAppend: block };
		} catch (error) {
			log("error", error instanceof Error ? error.message : String(error));
			return;
		}
	});

	pi.registerCommand("jev", {
		description: "TypeSafe Jev status (native System One skill routing)",
		async handler(_args, ctx) {
			ctx.ui.notify(
				key
					? `Jev: key present, ${skills.length} skills, model ${MODEL} @ ${BASE_URL}`
					: "Jev: TYPESAFE_API_KEY missing — /login typesafe or put it in ~/.omp/.env",
				key ? "info" : "warning",
			);
		},
	});
}
