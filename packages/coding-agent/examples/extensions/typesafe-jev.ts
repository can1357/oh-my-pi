/**
 * TypeSafe Jev skill routing (cookbook calls 1–2).
 *
 * Call 1: Choice over the roster + three gate Nouls. Call 2 (auto): rerank the
 * top 3 with SKILL.md excerpts + fits Nouls when the roster is large or the
 * top two choices collide. Injects `<skill_relevance>` via systemPromptAppend.
 * Fail-open on missing key, timeout, or HTTP error.
 *
 * Usage:
 * 1. `/login typesafe` or `TYPESAFE_API_KEY` in ~/.omp/.env
 * 2. Restart omp so the extension loads.
 * 3. `/jev` prints key + roster size + rerank mode.
 */
import { appendFileSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent";

const BASE_URL = (process.env.TYPESAFE_BASE_URL || "https://api.typesafe.ai").replace(/\/$/, "");
const MODEL = process.env.TYPESAFE_DEFAULT_MODEL || "jev-latest";
const HOOK_BUDGET_MS = 2500;
const MAX_CHOICES = 240;
const GATE_THRESHOLD = 0.3;
const FITS_THRESHOLD = 0.3;
const SHORTLIST = 3;
const EXCERPT_CHARS = 700;
const LOOKALIKE_DELTA = 0.1;
const ROSTER_RERANK_THRESHOLD = 100;
const HIGH_CONFIDENCE_GATE = 0.6;
const HIGH_CONFIDENCE_PROB = 0.7;
const NONE_OF_THESE = "none_of_these";
const LOG = join(homedir(), ".omp/agent/extensions/typesafe-jev/route.log");

const GATE_QUESTIONS = {
	acts_on_user_system:
		"Is the assistant being asked to act on the user's files, accounts, devices, or online services, rather than only to explain or advise?",
	would_follow_documented_procedure:
		"Would a careful expert answering this consult a specific documented procedure or set of commands, rather than answering from general understanding?",
	prose_suffices:
		"Could a knowledgeable generalist fully satisfy this request in prose, with no tools, no documentation, and no access to the user's files or accounts?",
} as const;
const INVERTED = new Set(["prose_suffices"]);

type Skill = { name: string; description: string; skillMd?: string };

function loadKey(): string {
	if (process.env.TYPESAFE_API_KEY?.trim()) return process.env.TYPESAFE_API_KEY.trim();
	try {
		for (const line of readFileSync(join(homedir(), ".omp/.env"), "utf8").split("\n")) {
			if (line.startsWith("TYPESAFE_API_KEY=")) {
				const v = line.slice("TYPESAFE_API_KEY=".length).trim().replace(/^['"]|['"]$/g, "");
				if (v) return v;
			}
		}
	} catch {
		/* missing file */
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

function stripFrontmatter(text: string): string {
	if (!text.startsWith("---")) return text;
	const end = text.indexOf("\n---", 3);
	if (end < 0) return text;
	return text.slice(end + 4).trimStart();
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
				const raw = readFileSync(skillMd, "utf8");
				const meta = parseFrontmatter(raw);
				const id = (meta.name || name).trim();
				if (!id || id.length > 64) continue;
				seen.add(name);
				seen.add(id);
				skills.push({
					name: id,
					description: (meta.description || id).replace(/\s+/g, " ").slice(0, 120),
					skillMd,
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

function topProbs(probabilities: Record<string, number> | undefined): number[] {
	if (!probabilities) return [];
	return Object.values(probabilities)
		.map(Number)
		.filter(Number.isFinite)
		.sort((a, b) => b - a);
}

function shouldRerank(rosterSize: number, gate: number, probabilities: Record<string, number> | undefined): boolean {
	const rerankEnv = (process.env.TYPESAFE_JEV_RERANK || "auto").toLowerCase();
	if (rerankEnv === "off" || rerankEnv === "false" || rerankEnv === "0") return false;
	if (rerankEnv === "always" || rerankEnv === "1") return true;
	if (rosterSize >= ROSTER_RERANK_THRESHOLD) return true;
	const [first, second] = topProbs(probabilities);
	if (first !== undefined && gate >= HIGH_CONFIDENCE_GATE && first >= HIGH_CONFIDENCE_PROB) return false;
	if (first !== undefined && second !== undefined && first - second <= LOOKALIKE_DELTA) return true;
	return false;
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

function rankedShortlist(probabilities: Record<string, number> | undefined, roster: Skill[]): string[] {
	if (!probabilities) return roster.slice(0, SHORTLIST).map(s => s.name);
	const allowed = new Set(roster.map(s => s.name));
	return Object.entries(probabilities)
		.filter(([name, p]) => allowed.has(name) && Number.isFinite(Number(p)))
		.sort((a, b) => Number(b[1]) - Number(a[1]))
		.slice(0, SHORTLIST)
		.map(([name]) => name);
}

function skillExcerpt(skill: Skill | undefined): string {
	if (!skill?.skillMd) return "";
	try {
		const body = stripFrontmatter(readFileSync(skill.skillMd, "utf8"));
		return body.replace(/\s+/g, " ").slice(0, EXCERPT_CHARS);
	} catch {
		return "";
	}
}

async function rerank(
	prompt: string,
	shortlist: string[],
	byName: Map<string, Skill>,
	key: string,
	budgetMs: number,
): Promise<{ winner: string; fits: number; p: number; model: string } | null> {
	const criteria: Record<string, string> = { [NONE_OF_THESE]: "None of these skills fit the request." };
	for (const name of shortlist) {
		const skill = byName.get(name);
		const excerpt = skillExcerpt(skill);
		criteria[name] = excerpt ? `${skill?.description ?? name} — ${excerpt}` : (skill?.description ?? name);
	}
	const questions: Record<string, unknown> = {
		which: {
			type: "choice",
			instructions:
				"Exactly one of these skills is the right one to load for the user's latest request. Which one? Read what each actually does, not just its name.",
			criteria,
		},
	};
	for (const name of shortlist) {
		const skill = byName.get(name);
		questions[`fits::${name}`] = {
			type: "noul",
			instructions: `Does the skill '${name}' do the specific thing the user's request asks for? It is described as: ${skill?.description ?? name}`,
		};
	}
	const body = await systemone(
		key,
		{ request: prompt.slice(0, 4000), recent_context: "" },
		questions,
		budgetMs,
	);
	const choice = String(body?.answers?.which?.choice || "");
	if (!choice || choice === NONE_OF_THESE || !byName.has(choice)) return null;
	const fitsEntries = Object.entries(body?.answers || {}).filter(([k]) => k.startsWith("fits::"));
	const fitsValues = fitsEntries.map(([, v]) => Number((v as { noul?: number })?.noul ?? 0));
	const bestFits = fitsValues.length ? Math.max(...fitsValues) : 0;
	if (bestFits < FITS_THRESHOLD) return null;
	const winnerFits = Number(body?.answers?.[`fits::${choice}`]?.noul ?? bestFits);
	return {
		winner: choice,
		fits: winnerFits,
		p: Number(body?.answers?.which?.probabilities?.[choice] ?? 0),
		model: body?.model || "?",
	};
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
	for (const [keyName, text] of Object.entries(GATE_QUESTIONS)) {
		questions[`gate::${keyName}`] = { type: "noul", instructions: text };
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
	let p = Number(which?.probabilities?.[choice] ?? 0);
	const gate = gateMean(body?.answers || {});
	const byName = new Map(skills.map(skill => [skill.name, skill]));

	let winner = choice;
	let fits: number | undefined;
	let model = body?.model || "?";
	let reranked = false;

	if (choice && gate >= GATE_THRESHOLD && shouldRerank(skills.length, gate, which?.probabilities)) {
		const remaining = Math.max(400, HOOK_BUDGET_MS - (Date.now() - started));
		const shortlist = rankedShortlist(which?.probabilities, skills);
		const second = await rerank(prompt, shortlist, byName, key, remaining);
		if (!second) return;
		winner = second.winner;
		fits = second.fits;
		p = second.p;
		model = second.model;
		reranked = true;
	} else if (!choice || gate < GATE_THRESHOLD) {
		return;
	}

	log(
		"suggest",
		`${winner || "-"} gate=${gate.toFixed(3)}${fits !== undefined ? ` fits=${fits.toFixed(3)}` : ""} p=${p.toFixed(3)}${reranked ? " rerank" : ""} ${(Date.now() - started) / 1000}s model=${model}`,
	);
	if (!winner) return;
	return [
		"<skill_relevance>",
		`Relevant to the current request: ${winner}. Ignore this if it does not fit what the user actually asked for.`,
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
			const rerank = process.env.TYPESAFE_JEV_RERANK || "auto";
			ctx.ui.notify(
				key
					? `Jev: key present, ${skills.length} skills, rerank=${rerank}, model ${MODEL} @ ${BASE_URL}`
					: "Jev: TYPESAFE_API_KEY missing — /login typesafe or put it in ~/.omp/.env",
				key ? "info" : "warning",
			);
		},
	});
}
