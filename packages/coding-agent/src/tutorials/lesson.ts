/**
 * Tutorial lesson model and loader.
 *
 * A lesson is data: `lesson.md` (YAML frontmatter + intro body), one `<stepId>.md`
 * per step, `when.md` for the closing card, plus a `fixture/` tree (and optional
 * `commits/<name>/` overlays) materialized by `sandbox.ts`. This module turns the
 * markdown sources into a validated {@link Lesson}; every malformed field fails
 * with a {@link LessonFormatError} naming the lesson and the offending field.
 */
import { OmpErrors, type } from "@oh-my-pi/omptype";
import { parseFrontmatter } from "@oh-my-pi/pi-utils";
import { MAGIC_KEYWORDS } from "../modes/magic-keywords";

/** One declarative step check. A step passes when all of its checks pass in the same evaluation. */
export type StepCheck =
	| { kind: "turn" }
	| { kind: "keyword"; word: string }
	| { kind: "tool"; name: string; match?: RegExp }
	| { kind: "command"; name: string }
	| { kind: "file"; path: string; matches: RegExp }
	| { kind: "reply"; pattern: RegExp };

export interface LessonStep {
	id: string;
	/** Handlebars source of the step card text. */
	text: string;
	/** Shown on `/tutorial hint` and when an evaluation fails. */
	hint: string;
	/** One-line "what happened" note shown when the step passes. */
	done: string;
	checks: StepCheck[];
}

/** An overlay directory committed on top of the initial fixture commit. */
export interface LessonCommit {
	/** Directory relative to the lesson root, e.g. `commits/rename`. */
	dir: string;
	message: string;
}

export interface Lesson {
	id: string;
	title: string;
	minutes: number;
	/** Tool names that must all be enabled for the lesson to make sense. */
	requires: string[];
	/** Handlebars source of the intro shown when the lesson starts. */
	intro: string;
	/** Handlebars source of the closing "when to reach for this" card. */
	when: string;
	history: LessonCommit[];
	steps: LessonStep[];
}

/** Raw markdown sources of one lesson, keyed by file name relative to the lesson dir. */
export interface LessonSource {
	id: string;
	files: Readonly<Record<string, string>>;
}

export class LessonFormatError extends Error {
	constructor(lessonId: string, problem: string) {
		super(`Tutorial lesson "${lessonId}": ${problem}`);
		this.name = "LessonFormatError";
	}
}

const checkSchema = type("'turn'")
	.or({ turn: "unknown" })
	.or({ keyword: "string" })
	.or({ tool: "string", "match?": "string" })
	.or({ command: "string" })
	.or({ file: "string", matches: "string" })
	.or({ reply: "string" });

type RawCheck = typeof checkSchema.infer;

const frontmatterSchema = type({
	id: "string",
	title: "string",
	minutes: "number > 0",
	"requires?": "string[]",
	"history?": type({ dir: "string", message: "string" }).array(),
	steps: type({ id: "string", hint: "string", done: "string", check: checkSchema.or(checkSchema.array()) })
		.array()
		.atLeastLength(1),
});

/** Case-insensitive, no `m`: `^`/`$` anchor the whole text, so `^(?![\s\S]*foo)` reads "does not contain foo". */
const REGEX_FLAGS = "i";
const MAGIC_KEYWORD_WORDS: ReadonlySet<string> = new Set(MAGIC_KEYWORDS.map(keyword => keyword.word));

function compileRegex(lessonId: string, source: string, field: string): RegExp {
	try {
		return new RegExp(source, REGEX_FLAGS);
	} catch (error) {
		throw new LessonFormatError(
			lessonId,
			`${field} is not a valid regex: ${error instanceof Error ? error.message : String(error)}`,
		);
	}
}

function parseCheck(lessonId: string, raw: RawCheck, field: string): StepCheck {
	if (raw === "turn" || "turn" in raw) return { kind: "turn" };
	if ("keyword" in raw) {
		if (!MAGIC_KEYWORD_WORDS.has(raw.keyword)) {
			throw new LessonFormatError(lessonId, `${field}.keyword "${raw.keyword}" is not a registered magic keyword`);
		}
		return { kind: "keyword", word: raw.keyword };
	}
	if ("tool" in raw) {
		return {
			kind: "tool",
			name: raw.tool,
			match: raw.match === undefined ? undefined : compileRegex(lessonId, raw.match, `${field}.match`),
		};
	}
	if ("command" in raw) {
		if (!/^\/\S+$/.test(raw.command)) {
			throw new LessonFormatError(lessonId, `${field}.command must look like "/name"`);
		}
		return { kind: "command", name: raw.command.slice(1) };
	}
	if ("file" in raw) {
		if (raw.file.startsWith("/") || raw.file.split(/[\\/]/).includes("..")) {
			throw new LessonFormatError(lessonId, `${field}.file must be a relative path inside the lesson repo`);
		}
		return { kind: "file", path: raw.file, matches: compileRegex(lessonId, raw.matches, `${field}.matches`) };
	}
	return { kind: "reply", pattern: compileRegex(lessonId, raw.reply, `${field}.reply`) };
}

function requireFile(source: LessonSource, name: string): string {
	const text = source.files[name];
	if (text === undefined) throw new LessonFormatError(source.id, `missing ${name}`);
	return text.trim();
}

/** Parse and validate one lesson from its markdown sources. */
export function parseLesson(source: LessonSource): Lesson {
	const lessonId = source.id;
	let parsed: { frontmatter: Record<string, unknown>; body: string };
	try {
		parsed = parseFrontmatter(requireFile(source, "lesson.md"), {
			source: `${lessonId}/lesson.md`,
			level: "fatal",
			repair: false,
		});
	} catch (error) {
		if (error instanceof LessonFormatError) throw error;
		throw new LessonFormatError(lessonId, error instanceof Error ? error.message : String(error));
	}
	const frontmatter = frontmatterSchema(parsed.frontmatter);
	if (frontmatter instanceof OmpErrors) throw new LessonFormatError(lessonId, frontmatter.summary);
	if (frontmatter.id !== lessonId) {
		throw new LessonFormatError(lessonId, `id "${frontmatter.id}" does not match the lesson directory`);
	}
	const intro = parsed.body.trim();
	if (!intro) throw new LessonFormatError(lessonId, "lesson.md has no intro body");

	const seen = new Set<string>();
	const steps = frontmatter.steps.map((step, index): LessonStep => {
		if (seen.has(step.id)) throw new LessonFormatError(lessonId, `duplicate step id "${step.id}"`);
		seen.add(step.id);
		const rawChecks = Array.isArray(step.check) ? step.check : [step.check];
		if (rawChecks.length === 0) throw new LessonFormatError(lessonId, `steps[${index}].check is empty`);
		return {
			id: step.id,
			text: requireFile(source, `${step.id}.md`),
			hint: step.hint.trim(),
			done: step.done.trim(),
			checks: rawChecks.map((check, checkIndex) =>
				parseCheck(lessonId, check, `steps[${index}].check[${checkIndex}]`),
			),
		};
	});

	return {
		id: frontmatter.id,
		title: frontmatter.title,
		minutes: frontmatter.minutes,
		requires: frontmatter.requires ?? [],
		intro,
		when: requireFile(source, "when.md"),
		history: frontmatter.history ?? [],
		steps,
	};
}
