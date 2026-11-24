import type { ImageContent } from "@oh-my-pi/pi-ai";
import { Ellipsis } from "@oh-my-pi/pi-natives";
import { replaceTabs, truncateToWidth, wrapTextWithAnsi } from "../../../utils/text-width";

/** Most title rows the terminal prompt shows, so a long question cannot push the input row off-screen. */
const MAX_PROMPT_TITLE_ROWS = 3;

/** Border (2) + padX (2) columns consumed by the panel chrome. */
const PROMPT_TITLE_CHROME_COLUMNS = 4;

/**
 * `prefix` and `question` flattened onto one line, wrapped to the terminal's width and cut to
 * {@link MAX_PROMPT_TITLE_ROWS} rows (the last ends in `…` when cut). For terminal rendering only:
 * native hosts get the question whole ({@link HookEditorOptions.question}).
 */
export function boundPromptTitle(prefix: string, question: string): string {
	const width = Math.max(1, (process.stdout.columns ?? 80) - PROMPT_TITLE_CHROME_COLUMNS);
	const flat = replaceTabs(`${prefix}${question}`).replace(/\s+/g, " ").trim();
	const wrapped = wrapTextWithAnsi(flat, width);
	if (wrapped.length <= MAX_PROMPT_TITLE_ROWS) return wrapped.join("\n");
	const kept = wrapped.slice(0, MAX_PROMPT_TITLE_ROWS - 1);
	const last = truncateToWidth(wrapped.slice(MAX_PROMPT_TITLE_ROWS - 1).join(" "), width, Ellipsis.Unicode);
	return [...kept, last].join("\n");
}

export interface HookEditorOptions {
	/** Edit text with the host's configured external editor. */
	externalEditor?: (text: string) => Promise<string | null>;
	/** When true, use prompt-style keybindings with the legacy ask prompt chrome. */
	promptStyle?: boolean;
	/**
	 * The question the text answers (the ask tool's custom answers and notes). The terminal
	 * shows it after `<title>: `, wrapped and cut to three rows; native hosts put it whole,
	 * as markdown, under the title.
	 */
	question?: string;
	/** Allow clipboard images to be attached to this prompt. */
	acceptImages?: boolean;
	/** Images already represented by markers in the prefilled text. */
	images?: readonly ImageContent[];
	/**
	 * With `acceptImages`, called for an empty bracketed paste, which is how terminals that own
	 * the paste key send an image-only clipboard (#3601). The host attaches the image through the
	 * editor's handle (`HookEditorHandle.attachImage`); keys typed meanwhile wait for it.
	 */
	onPasteImage?: () => Promise<boolean>;
	/**
	 * With `acceptImages`, called for each path of a bracketed paste made only of image paths.
	 * Calls are not awaited in turn, so images attach as they finish loading and are renumbered
	 * in text order on submit.
	 */
	onPasteImagePath?: (path: string) => void | Promise<void>;
	/**
	 * Max rows the inner Editor may occupy. When omitted, the editor is
	 * bounded to the current terminal height minus the component's chrome
	 * (≈10 rows) so long content scrolls instead of pushing the submit
	 * hint out of view.
	 */
	maxHeight?: number;
}
