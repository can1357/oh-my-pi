/**
 * Bundled lessons. Markdown is imported as text so it ships in every build
 * (source, npm bundle, compiled binary); fixture trees go through `fixtures.ts`.
 * Adding a lesson: create `src/tutorials/<id>/` and register its files here.
 */
import basicsEdit from "./basics/edit.md" with { type: "text" };
import basicsLesson from "./basics/lesson.md" with { type: "text" };
import basicsRange from "./basics/range.md" with { type: "text" };
import basicsSelectors from "./basics/selectors.md" with { type: "text" };
import basicsUndo from "./basics/undo.md" with { type: "text" };
import basicsWhen from "./basics/when.md" with { type: "text" };
import btwHistory from "./btw/history.md" with { type: "text" };
import btwLanded from "./btw/landed.md" with { type: "text" };
import btwLesson from "./btw/lesson.md" with { type: "text" };
import btwStart from "./btw/start.md" with { type: "text" };
import btwWhen from "./btw/when.md" with { type: "text" };
import jevifyAnswer from "./jevify/answer.md" with { type: "text" };
import jevifyKeyword from "./jevify/keyword.md" with { type: "text" };
import jevifyLesson from "./jevify/lesson.md" with { type: "text" };
import jevifyPlain from "./jevify/plain.md" with { type: "text" };
import jevifyWhen from "./jevify/when.md" with { type: "text" };
import ttsrInspect from "./ttsr/inspect.md" with { type: "text" };
import ttsrLesson from "./ttsr/lesson.md" with { type: "text" };
import ttsrOwn from "./ttsr/own.md" with { type: "text" };
import ttsrOwnTrip from "./ttsr/own-trip.md" with { type: "text" };
import ttsrTrip from "./ttsr/trip.md" with { type: "text" };
import ttsrWhen from "./ttsr/when.md" with { type: "text" };
import { type Lesson, type LessonSource, parseLesson } from "./lesson";

export const LESSON_SOURCES: readonly LessonSource[] = [
	{
		id: "basics",
		files: {
			"lesson.md": basicsLesson,
			"range.md": basicsRange,
			"selectors.md": basicsSelectors,
			"edit.md": basicsEdit,
			"undo.md": basicsUndo,
			"when.md": basicsWhen,
		},
	},
	{
		id: "btw",
		files: {
			"lesson.md": btwLesson,
			"start.md": btwStart,
			"landed.md": btwLanded,
			"history.md": btwHistory,
			"when.md": btwWhen,
		},
	},
	{
		id: "jevify",
		files: {
			"lesson.md": jevifyLesson,
			"plain.md": jevifyPlain,
			"keyword.md": jevifyKeyword,
			"answer.md": jevifyAnswer,
			"when.md": jevifyWhen,
		},
	},
	{
		id: "ttsr",
		files: {
			"lesson.md": ttsrLesson,
			"trip.md": ttsrTrip,
			"inspect.md": ttsrInspect,
			"own.md": ttsrOwn,
			"own-trip.md": ttsrOwnTrip,
			"when.md": ttsrWhen,
		},
	},
];

let lessons: readonly Lesson[] | undefined;

/** Every bundled lesson, parsed once. */
export function getLessons(): readonly Lesson[] {
	lessons ??= LESSON_SOURCES.map(parseLesson);
	return lessons;
}

export function getLesson(id: string): Lesson | undefined {
	return getLessons().find(lesson => lesson.id === id);
}
