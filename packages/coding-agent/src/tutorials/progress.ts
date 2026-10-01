/**
 * Tutorial progress persisted as a small JSON file under the agent dir
 * (`~/.omp/agent/tutorials.json`): which steps of each lesson are done, whether
 * the lesson finished, and the sandbox/session of the latest run so `/tutorial
 * <id>` resumes an unfinished lesson instead of starting over.
 */
import * as path from "node:path";
import { OmpErrors, type } from "@oh-my-pi/omptype";
import { getAgentDir, isEnoent, logger } from "@oh-my-pi/pi-utils";
import { replaceFileAtomically } from "../utils/atomic-file";
import type { Lesson, LessonStep } from "./lesson";

const lessonProgressSchema = type({
	completed: "string[]",
	finished: "boolean",
	"sandbox?": "string",
	"sessionFile?": "string",
});

const progressFileSchema = type({
	version: "1",
	lessons: type({ "[string]": lessonProgressSchema }),
});

export type LessonProgress = typeof lessonProgressSchema.infer;
type ProgressFile = typeof progressFileSchema.infer;

export class TutorialProgressStore {
	readonly #filePath: string;
	#data: ProgressFile;

	constructor(filePath: string, data: ProgressFile) {
		this.#filePath = filePath;
		this.#data = data;
	}

	/** Load the store; a missing or unreadable file starts empty (the latter is logged, then overwritten on save). */
	static async load(filePath: string = path.join(getAgentDir(), "tutorials.json")): Promise<TutorialProgressStore> {
		let raw: unknown;
		try {
			raw = await Bun.file(filePath).json();
		} catch (error) {
			if (!isEnoent(error))
				logger.warn("Unreadable tutorial progress, starting fresh", { filePath, error: String(error) });
			return new TutorialProgressStore(filePath, { version: 1, lessons: {} });
		}
		const parsed = progressFileSchema(raw);
		if (parsed instanceof OmpErrors) {
			logger.warn("Malformed tutorial progress, starting fresh", { filePath, error: parsed.summary });
			return new TutorialProgressStore(filePath, { version: 1, lessons: {} });
		}
		return new TutorialProgressStore(filePath, parsed);
	}

	get(lessonId: string): LessonProgress | undefined {
		return this.#data.lessons[lessonId];
	}

	/** Lesson id whose latest run lives in `sessionFile`, if any. */
	lessonForSession(sessionFile: string | undefined): string | undefined {
		if (!sessionFile) return undefined;
		for (const [lessonId, progress] of Object.entries(this.#data.lessons)) {
			if (progress.sessionFile === sessionFile) return lessonId;
		}
		return undefined;
	}

	/** First step of `lesson` not yet completed; `undefined` once every step is done. */
	nextStep(lesson: Lesson): LessonStep | undefined {
		const completed = this.get(lesson.id)?.completed ?? [];
		return lesson.steps.find(step => !completed.includes(step.id));
	}

	/** Record a fresh run: new sandbox and session, no steps done. `finished` is the lasting ✓ and survives; per-run completion is `nextStep() === undefined`. */
	begin(lessonId: string, sandbox: string, sessionFile: string): Promise<void> {
		const finished = this.get(lessonId)?.finished ?? false;
		this.#data.lessons[lessonId] = { completed: [], finished, sandbox, sessionFile };
		return this.#save();
	}

	completeStep(lessonId: string, stepId: string): Promise<void> {
		const progress = (this.#data.lessons[lessonId] ??= { completed: [], finished: false });
		if (!progress.completed.includes(stepId)) progress.completed.push(stepId);
		return this.#save();
	}

	finish(lessonId: string): Promise<void> {
		const progress = (this.#data.lessons[lessonId] ??= { completed: [], finished: false });
		progress.finished = true;
		return this.#save();
	}

	async #save(): Promise<void> {
		const tempPath = `${this.#filePath}.${process.pid}.tmp`;
		await Bun.write(tempPath, `${JSON.stringify(this.#data, null, 2)}\n`);
		await replaceFileAtomically(tempPath, this.#filePath);
	}
}
