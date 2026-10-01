/**
 * Interactive `/tutorial` runtime: lesson list, sandbox session park/resume, the
 * lesson card pinned above the composer (the extension widget area, not an
 * overlay), and step evaluation after every finished turn.
 *
 * A tutorial session is an ordinary session whose cwd is the lesson sandbox. It
 * is tagged with a `tutorial` custom entry carrying the session it parked, so
 * `/tutorial exit` returns there exactly; progress lives in `tutorials.json`.
 */
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { OmpErrors, type } from "@oh-my-pi/omptype";
import { Container, Markdown, Spacer, Text } from "@oh-my-pi/pi-tui";
import { DynamicBorder } from "@oh-my-pi/pi-tui/chrome/dynamic-border";
import { TranscriptBlock } from "@oh-my-pi/pi-tui/chrome/transcript-container";
import { shortenPath } from "@oh-my-pi/pi-tui/render/render-utils";
import { getMarkdownTheme, theme } from "@oh-my-pi/pi-tui/theme";
import { logger, prompt } from "@oh-my-pi/pi-utils";
import type { InteractiveModeContext } from "../modes/types";
import type { AgentSessionEvent } from "../session/agent-session-events";
import { getLesson, getLessons } from "./catalog";
import { emptyObservation, findFailingCheck, recordSessionEvent, type StepObservation } from "./checks";
import type { Lesson, LessonStep, StepCheck } from "./lesson";
import { TutorialProgressStore } from "./progress";
import { createSandbox, getTutorialSandboxRoot } from "./sandbox";

const CARD_WIDGET_KEY = "tutorial";
const SESSION_TAG = "tutorial";

const sessionTagSchema = type({ lessonId: "string", returnCwd: "string", "returnSession?": "string" });
type SessionTag = typeof sessionTagSchema.infer;

export interface TutorialControllerOptions {
	/** Progress file; defaults to `tutorials.json` under the agent dir. */
	progressFile?: string;
	/** Parent of lesson sandboxes; defaults to `getTutorialSandboxRoot()`. */
	sandboxRoot?: string;
}

interface ActiveLesson {
	lesson: Lesson;
	sandbox: string;
	sessionFile: string;
}

/** Tools named by `lesson.requires` that the session does not have enabled. */
export function missingLessonTools(lesson: Lesson, enabledTools: readonly string[]): string[] {
	return lesson.requires.filter(tool => !enabledTools.includes(tool));
}

function describeCheck(check: StepCheck): string {
	switch (check.kind) {
		case "turn":
			return "a finished turn";
		case "keyword":
			return `the \`${check.word}\` keyword in your message`;
		case "tool":
			return `a \`${check.name}\` tool call`;
		case "command":
			return `\`/${check.name}\``;
		case "file":
			return `a change to \`${check.path}\``;
		case "reply":
			return "a matching answer";
	}
}

export class TutorialController {
	readonly #ctx: InteractiveModeContext;
	#store: Promise<TutorialProgressStore> | undefined;
	#loadedStore: TutorialProgressStore | undefined;
	#active: ActiveLesson | undefined;
	#observation: StepObservation = emptyObservation();
	#evaluation: Promise<void> = Promise.resolve();

	readonly #options: TutorialControllerOptions;

	constructor(ctx: InteractiveModeContext, options: TutorialControllerOptions = {}) {
		this.#ctx = ctx;
		this.#options = options;
	}

	#getStore(): Promise<TutorialProgressStore> {
		this.#store ??= TutorialProgressStore.load(this.#options.progressFile).then(store => {
			this.#loadedStore = store;
			return store;
		});
		return this.#store;
	}

	/** Load progress and show the card when the startup session is a tutorial session. */
	async init(): Promise<void> {
		await this.#getStore();
		this.syncCard();
	}

	/** `/tutorial [<id>|hint|skip|exit]`. */
	async handleCommand(args: string): Promise<void> {
		const arg = args.trim();
		try {
			if (arg === "") await this.#showList();
			else if (arg === "hint") this.#showHint();
			else if (arg === "skip") await this.#skip();
			else if (arg === "exit") await this.#exit();
			else await this.#start(arg);
		} catch (error) {
			logger.error("Tutorial command failed", { args: arg, error: String(error) });
			this.#ctx.showError(`Tutorial: ${error instanceof Error ? error.message : String(error)}`);
		}
	}

	/** Fold a session event into the current step's observation; evaluate when a turn hands control back. */
	onSessionEvent(event: AgentSessionEvent): void {
		if (!this.#active) return;
		if (recordSessionEvent(this.#observation, event)) this.#queueEvaluation(true);
	}

	/** Record a submitted slash command (canonical name, no `/`). Evaluates immediately when idle. */
	noteCommand(name: string): void {
		if (!this.#active || name === "tutorial") return;
		this.#observation.commands.push(name);
		if (this.#ctx.session.isStreaming) return;
		// Unrelated commands (/model, /copy, …) mid-step must not nag with a hint;
		// only a step waiting on a command reports why it has not passed yet.
		const step = this.#loadedStore?.nextStep(this.#active.lesson);
		this.#queueEvaluation(step?.checks.some(check => check.kind === "command") ?? false);
	}

	/** Resolves once every queued step evaluation has run. */
	settled(): Promise<void> {
		return this.#evaluation;
	}

	/** Show the card for the current session's lesson, or remove it when the session is not a tutorial session. */
	syncCard(): void {
		const store = this.#loadedStore;
		const sessionFile = this.#ctx.sessionManager.getSessionFile();
		const lessonId = store?.lessonForSession(sessionFile);
		const lesson = lessonId ? getLesson(lessonId) : undefined;
		const sandbox = lessonId ? store?.get(lessonId)?.sandbox : undefined;
		if (!lesson || !sandbox || !sessionFile) {
			if (this.#active) this.#ctx.setHookWidget(CARD_WIDGET_KEY, undefined);
			this.#active = undefined;
			return;
		}
		if (this.#active?.sessionFile !== sessionFile) this.#observation = emptyObservation();
		this.#active = { lesson, sandbox, sessionFile };
		const step = store!.nextStep(lesson);
		const card = this.#buildCard(lesson, sandbox, step, store!.get(lesson.id)?.completed ?? []);
		this.#ctx.setHookWidget(CARD_WIDGET_KEY, () => card);
	}

	#render(template: string, sandbox: string): string {
		return prompt.render(template, { dir: shortenPath(sandbox) }).trim();
	}

	#buildCard(lesson: Lesson, sandbox: string, step: LessonStep | undefined, completed: readonly string[]): Container {
		const card = new Container();
		card.addChild(new DynamicBorder());
		const index = step ? lesson.steps.indexOf(step) : lesson.steps.length;
		const dots = lesson.steps
			.map((candidate, i) =>
				completed.includes(candidate.id)
					? theme.fg("success", theme.status.success)
					: i === index
						? theme.fg("accent", theme.status.running)
						: theme.fg("dim", theme.status.pending),
			)
			.join(" ");
		const position = step ? `step ${index + 1}/${lesson.steps.length}` : "done";
		card.addChild(
			new Text(
				`${theme.bold(theme.fg("accent", `Tutorial · ${lesson.title}`))}  ${theme.fg("muted", position)}  ${dots}`,
				1,
				0,
			),
		);
		const body = step ? step.text : lesson.when;
		card.addChild(new Markdown(this.#render(body, sandbox), 1, 0, getMarkdownTheme()));
		const footer = step
			? "/tutorial hint · /tutorial skip · /tutorial exit"
			: "/tutorial exit returns to your session · /tutorial lists more lessons";
		card.addChild(new Text(theme.fg("dim", footer), 1, 0));
		return card;
	}

	async #showList(): Promise<void> {
		const store = await this.#getStore();
		const enabled = this.#ctx.session.getEnabledToolNames();
		const lessons = getLessons();
		const idWidth = Math.max(...lessons.map(lesson => lesson.id.length));
		const titleWidth = Math.max(...lessons.map(lesson => lesson.title.length));
		const block = new TranscriptBlock();
		block.addChild(new DynamicBorder());
		block.addChild(new Text(theme.bold(theme.fg("accent", "Tutorials")), 1, 0));
		block.addChild(
			new Text(theme.fg("muted", "Practise a feature in a throwaway repo. Start one with /tutorial <id>."), 1, 0),
		);
		block.addChild(new Spacer(1));
		for (const lesson of lessons) {
			const progress = store.get(lesson.id);
			const missing = missingLessonTools(lesson, enabled);
			const marker = progress?.finished ? theme.fg("success", theme.status.success) : " ";
			const columns = `${lesson.id.padEnd(idWidth)}  ${lesson.title.padEnd(titleWidth)}  ${lesson.minutes} min`;
			let note = "";
			if (missing.length > 0) {
				note = `needs ${missing.join(", ")} (disabled)`;
			} else if (progress?.sessionFile && store.nextStep(lesson)) {
				const done = progress.completed.length;
				note = `step ${Math.min(done + 1, lesson.steps.length)}/${lesson.steps.length} — /tutorial ${lesson.id} resumes`;
			}
			const row =
				missing.length > 0
					? theme.fg("dim", `${columns}  ${note}`)
					: `${theme.fg("accent", lesson.id.padEnd(idWidth))}  ${columns.slice(idWidth + 2)}${note ? `  ${theme.fg("muted", note)}` : ""}`;
			block.addChild(new Text(`${marker} ${row}`, 1, 0));
		}
		block.addChild(new DynamicBorder());
		this.#ctx.presentCommandOutput(block);
	}

	#showHint(): void {
		const active = this.#active;
		if (!active) {
			this.#ctx.showStatus("No lesson running. /tutorial lists lessons.");
			return;
		}
		const step = this.#loadedStore?.nextStep(active.lesson);
		this.#ctx.showStatus(step ? `Hint: ${step.hint}` : "Lesson complete. /tutorial exit returns to your session.");
	}

	async #skip(): Promise<void> {
		const active = this.#active;
		if (!active) {
			this.#ctx.showStatus("No lesson running. /tutorial lists lessons.");
			return;
		}
		const store = await this.#getStore();
		const step = store.nextStep(active.lesson);
		if (!step) return;
		await this.#advance(store, active, step, `Skipped: ${step.done}`);
	}

	async #advance(store: TutorialProgressStore, active: ActiveLesson, step: LessonStep, note: string): Promise<void> {
		await store.completeStep(active.lesson.id, step.id);
		this.#observation = emptyObservation();
		this.#ctx.presentCommandOutput(new Text(`${theme.fg("success", theme.status.success)} ${note}`, 1, 0));
		if (!store.nextStep(active.lesson)) {
			await store.finish(active.lesson.id);
			this.#ctx.presentCommandOutput(
				new Text(
					theme.fg("accent", `Lesson complete: ${active.lesson.title}. The card shows when to reach for it.`),
					1,
					0,
				),
			);
		}
		this.syncCard();
	}

	#queueEvaluation(showHint: boolean): void {
		this.#evaluation = this.#evaluation
			.then(() => this.#evaluate(showHint))
			.catch(error => logger.warn("Tutorial step evaluation failed", { error: String(error) }));
	}

	async #evaluate(showHint: boolean): Promise<void> {
		const store = await this.#getStore();
		// A passing step re-checks the next one against the repo right away, so a
		// step whose state the previous turn already produced does not wait a turn.
		for (let first = true; ; first = false) {
			const active = this.#active;
			if (!active || active.sessionFile !== this.#ctx.sessionManager.getSessionFile()) return;
			const step = store.nextStep(active.lesson);
			if (!step) return;
			const failing = await findFailingCheck(step.checks, this.#observation, active.sandbox);
			if (failing) {
				if (first && showHint) {
					this.#ctx.showStatus(`Not yet — waiting for ${describeCheck(failing)}. Hint: ${step.hint}`, {
						dim: true,
					});
				}
				return;
			}
			await this.#advance(store, active, step, step.done);
		}
	}

	#currentTag(): SessionTag | undefined {
		const entries = this.#ctx.sessionManager.getEntries();
		for (let i = entries.length - 1; i >= 0; i--) {
			const entry = entries[i]!;
			if (entry.type !== "custom" || entry.customType !== SESSION_TAG) continue;
			const tag = sessionTagSchema(entry.data);
			if (!(tag instanceof OmpErrors)) return tag;
		}
		return undefined;
	}

	async #start(id: string): Promise<void> {
		const lesson = getLesson(id);
		if (!lesson) {
			this.#ctx.showError(`Unknown lesson "${id}". /tutorial lists lessons.`);
			return;
		}
		const missing = missingLessonTools(lesson, this.#ctx.session.getEnabledToolNames());
		if (missing.length > 0) {
			this.#ctx.showWarning(`Lesson "${id}" needs the ${missing.join(", ")} tool(s), which are disabled here.`);
			return;
		}
		if (this.#ctx.session.isStreaming) {
			this.#ctx.showWarning("Wait for the current response to finish or abort it before starting a lesson.");
			return;
		}
		const sessionManager = this.#ctx.sessionManager;
		const currentFile = sessionManager.getSessionFile();
		if (!currentFile) {
			this.#ctx.showError("Tutorials need session persistence (omp was started with --no-session).");
			return;
		}
		const store = await this.#getStore();
		const progress = store.get(id);
		if (this.#active?.lesson.id === id && progress?.sessionFile === currentFile) {
			this.syncCard();
			this.#ctx.showStatus(`Already in lesson "${id}".`);
			return;
		}
		// Starting from inside another lesson keeps that lesson's return target, so
		// exit always lands back in the session the user came from.
		const tag: SessionTag = (this.#active && this.#currentTag()) || {
			lessonId: id,
			returnCwd: sessionManager.getCwd(),
			returnSession: currentFile,
		};

		// Resume while the latest run has steps left; `finished` is the lasting ✓
		// and stays true across replays, so it cannot gate this.
		if (
			progress?.sessionFile &&
			store.nextStep(lesson) &&
			progress.sandbox &&
			(await this.#exists(progress.sessionFile)) &&
			(await this.#exists(progress.sandbox))
		) {
			await this.#ctx.handleResumeSession(progress.sessionFile);
			if (sessionManager.getSessionFile() !== progress.sessionFile) return;
			sessionManager.appendCustomEntry(SESSION_TAG, { ...tag, lessonId: id });
			this.syncCard();
			this.#ctx.showStatus(`Resumed lesson "${lesson.title}".`);
			return;
		}

		const sandboxRoot = this.#options.sandboxRoot ?? getTutorialSandboxRoot();
		const sandbox = await createSandbox(lesson, { root: sandboxRoot });
		await this.#ctx.handleClearCommand();
		if (sessionManager.getSessionFile() === currentFile) {
			await this.#removeSandbox(sandboxRoot, sandbox);
			return;
		}
		await this.#ctx.handleMoveCommand(sandbox);
		const sessionFile = sessionManager.getSessionFile();
		if (sessionManager.getCwd() !== sandbox || !sessionFile) {
			await this.#removeSandbox(sandboxRoot, sandbox);
			this.#ctx.showError(`Could not open a session in ${shortenPath(sandbox)}.`);
			return;
		}
		sessionManager.appendCustomEntry(SESSION_TAG, { ...tag, lessonId: id });
		const previous = progress?.sandbox;
		await store.begin(id, sandbox, sessionFile);
		if (previous && previous !== sandbox) await this.#removeSandbox(sandboxRoot, previous);
		this.#ctx.presentCommandOutput(new Markdown(this.#render(lesson.intro, sandbox), 1, 1, getMarkdownTheme()));
		this.syncCard();
	}

	/** Delete a lesson sandbox; refuses anything outside `root` so a stale progress entry can't reach user files. */
	async #removeSandbox(root: string, sandbox: string): Promise<void> {
		const relative = path.relative(path.resolve(root), path.resolve(sandbox));
		if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return;
		try {
			await fs.rm(sandbox, { recursive: true, force: true });
		} catch (error) {
			logger.warn("Could not remove tutorial sandbox", { sandbox, error: String(error) });
		}
	}

	async #exists(target: string): Promise<boolean> {
		try {
			await fs.stat(target);
			return true;
		} catch {
			return false;
		}
	}

	async #exit(): Promise<void> {
		const tag = this.#active ? this.#currentTag() : undefined;
		if (!tag) {
			this.#ctx.showStatus("Not in a tutorial session.");
			return;
		}
		if (this.#ctx.session.isStreaming) {
			this.#ctx.showWarning("Wait for the current response to finish or abort it before leaving the lesson.");
			return;
		}
		const sessionManager = this.#ctx.sessionManager;
		if (tag.returnSession && (await this.#exists(tag.returnSession))) {
			await this.#ctx.handleResumeSession(tag.returnSession);
		} else {
			await this.#ctx.handleClearCommand();
			await this.#ctx.handleMoveCommand(tag.returnCwd);
		}
		this.syncCard();
		if (!this.#active) {
			this.#ctx.showStatus(`Left the lesson. Back in ${shortenPath(sessionManager.getCwd())}.`);
		}
	}
}
