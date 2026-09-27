/**
 * Delivery ladder for outbound text: rich message → HTML → plain text.
 *
 * `send` walks the rungs, carrying whatever the failed rung did not manage to
 * send into the next one; `edit` clips a message outside a topic and continues
 * an overflow as further messages in one. Those continuation messages are
 * remembered per message id: the next edit patches them in place and only sends
 * chunks that have no continuation yet, so repeatedly editing a growing answer
 * (the stream does it every two seconds) costs one call per rendered chunk
 * instead of re-posting the whole tail. Continuations the answer no longer
 * reaches are blanked to the clip glyph — Telegram refuses empty text and has no
 * delete — so the visible answer never keeps a stale revision. A method-not-found
 * refusal disables the rich rung for the rest of the process, "message is not
 * modified" counts as success, and nothing here ever throws — failures are
 * logged and reported through the return value.
 */

import { logger } from "@oh-my-pi/pi-utils";
import { escapeHtml, plainText } from "./markdown-inline";
import { TELEGRAM_TEXT_LIMIT, renderAssistantText } from "./markdown";
import { RICH_TEXT_LIMIT, richMarkdown } from "./rich";
import type {
	TelegramApi,
	TelegramChatId,
	TelegramDelivery,
	TelegramInlineKeyboardMarkup,
	TelegramMessage,
	TelegramRichDraft,
} from "./types";

const METHOD_MISSING = /^(?:not found|method not found)|unknown method/iu;
const NOT_MODIFIED = /message is not modified/iu;
const CLIP = "…";

/** Edited messages that keep their continuation ids; the oldest falls out first (edited again, it posts a fresh tail). */
const TRACKED_CONTINUATIONS = 256;

const continuationKey = (chatId: TelegramChatId, messageId: number): string => `${chatId}:${messageId}`;

type Mode = "rich" | "html" | "plain";

interface Target {
	chatId: TelegramChatId;
	threadId?: number | null;
	replyMarkup?: TelegramInlineKeyboardMarkup | null;
	disableNotification?: boolean;
}

interface SendFields extends Target {
	markdown: string;
}

interface EditFields extends Target {
	messageId: number;
	markdown: string;
}

interface DraftFields {
	chatId: TelegramChatId;
	threadId?: number | null;
	draftId: number;
	markdown?: string;
	thinking?: string | null;
	canStop?: boolean;
}

interface PostProps {
	replyMarkup?: TelegramInlineKeyboardMarkup;
	disableNotification?: boolean;
}

const LIMITS: Record<Mode, number> = {
	rich: RICH_TEXT_LIMIT,
	html: TELEGRAM_TEXT_LIMIT,
	plain: TELEGRAM_TEXT_LIMIT,
};

const threadField = (threadId?: number | null): { threadId?: number } =>
	threadId === null || threadId === undefined ? {} : { threadId };

const markupField = (
	replyMarkup?: TelegramInlineKeyboardMarkup | null,
): { replyMarkup?: TelegramInlineKeyboardMarkup } =>
	replyMarkup === null || replyMarkup === undefined ? {} : { replyMarkup };

const quietField = (disableNotification?: boolean): { disableNotification?: boolean } =>
	disableNotification === true ? { disableNotification: true } : {};

const inThread = (threadId?: number | null): boolean => threadId !== null && threadId !== undefined;

const clipText = (text: string, limit: number): string =>
	text.length <= limit ? text : `${text.slice(0, limit - 1)}${CLIP}`;

const codeOf = (error: unknown): unknown =>
	typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;

const textOf = (error: unknown): string => String((error as { message?: unknown } | null)?.message ?? error);

const nextMode = (mode: Mode): Mode | null => (mode === "rich" ? "html" : mode === "html" ? "plain" : null);

const carryInto = (mode: Mode, rest: readonly string[]): string[] =>
	mode === "plain" ? rest.map(plainText) : renderAssistantText(rest.join("\n"));

function messageIdOf(sent: TelegramMessage | true): number | null {
	const id = typeof sent === "object" && sent !== null ? sent.message_id : undefined;
	return typeof id === "number" ? id : null;
}

function draftMessage(markdown: string, thinking: string | null, shape: number): TelegramRichDraft {
	const body = clipText(richMarkdown(markdown).join("\n"), RICH_TEXT_LIMIT);
	const tag = thinking === null ? "" : `<tg-thinking>${escapeHtml(thinking)}</tg-thinking>\n`;
	if (shape === 0) return { markdown: `${tag}${body}` };
	const html = thinking === null ? "" : `<tg-thinking>${escapeHtml(thinking)}</tg-thinking>`;
	return { html: `${html}${renderAssistantText(markdown).join("\n")}` };
}

/** Builds the delivery ladder over one Bot API client. */
export function createDelivery(deps: { api: TelegramApi }): TelegramDelivery {
	const { api } = deps;
	let rich = typeof api.sendRichMessage === "function";
	let draftShape = 0;
	/**
	 * Continuation message ids per `chatId:messageId`, in the order they were
	 * posted (the overflow of an `edit`, or of a `send` a later edit maintains).
	 * Insertion order doubles as recency, so the oldest entry is the first key.
	 */
	const continuations = new Map<string, number[]>();

	/** Records freshly posted continuations for a root message, evicting the oldest entry past the cap. */
	const track = (key: string, ids: readonly number[]): void => {
		if (ids.length === 0) return;
		const known = [...(continuations.get(key) ?? []), ...ids];
		continuations.delete(key);
		continuations.set(key, known);
		while (continuations.size > TRACKED_CONTINUATIONS) {
			const oldest = continuations.keys().next();
			if (oldest.done === true) break;
			continuations.delete(oldest.value);
		}
	};

	const note = (event: string, context: Record<string, unknown>): void => {
		logger.debug(`telegram: ${event}`, context);
	};
	const failure = (event: string, error: unknown, context: Record<string, unknown>): void => {
		logger.warn(`telegram: ${event}`, { ...context, error: textOf(error) });
	};

	const methodMissing = (error: unknown): boolean => codeOf(error) === 404 || METHOD_MISSING.test(textOf(error));
	const unchanged = (error: unknown): boolean => NOT_MODIFIED.test(textOf(error));
	const recoverable = (error: unknown): boolean =>
		(codeOf(error) === 400 && !unchanged(error)) || methodMissing(error);
	const dropRich = (error: unknown, context: Record<string, unknown>): void => {
		if (!methodMissing(error)) return;
		rich = false;
		note("deliver.rich_off", context);
	};

	const render: Record<Mode, (markdown: string) => string[]> = {
		rich: markdown => richMarkdown(markdown),
		html: markdown => renderAssistantText(markdown),
		plain: markdown => renderAssistantText(markdown).map(plainText),
	};

	const post: Record<Mode, (fields: Target, chunk: string, props: PostProps) => Promise<TelegramMessage>> = {
		rich: (fields, chunk, props) =>
			api.sendRichMessage({
				chatId: fields.chatId,
				...threadField(fields.threadId),
				richMessage: { markdown: chunk },
				...props,
			}),
		html: (fields, chunk, props) =>
			api.sendMessage({
				chatId: fields.chatId,
				...threadField(fields.threadId),
				text: chunk,
				parseMode: "HTML",
				...props,
			}),
		plain: (fields, chunk, props) =>
			api.sendMessage({ chatId: fields.chatId, ...threadField(fields.threadId), text: chunk, ...props }),
	};

	const patch: Record<Mode, (fields: EditFields, text: string, props: PostProps) => Promise<TelegramMessage | true>> =
		{
			rich: (fields, text, props) =>
				api.editMessageText({
					chatId: fields.chatId,
					messageId: fields.messageId,
					richMessage: { markdown: text },
					...props,
				}),
			html: (fields, text, props) =>
				api.editMessageText({
					chatId: fields.chatId,
					messageId: fields.messageId,
					text,
					parseMode: "HTML",
					...props,
				}),
			plain: (fields, text, props) =>
				api.editMessageText({ chatId: fields.chatId, messageId: fields.messageId, text, ...props }),
		};

	async function sendChunks(
		mode: Mode,
		chunks: readonly string[],
		fields: Target,
	): Promise<{ ids: number[]; error: unknown | null; rest: string[] }> {
		const ids: number[] = [];
		for (let index = 0; index < chunks.length; index += 1) {
			const props: PostProps = {
				...(index === chunks.length - 1 ? markupField(fields.replyMarkup) : {}),
				...quietField(fields.disableNotification),
			};
			try {
				const sent = await post[mode](fields, chunks[index], props);
				const id = messageIdOf(sent);
				if (id !== null) ids.push(id);
			} catch (error) {
				return { ids, error, rest: chunks.slice(index) };
			}
		}
		return { ids, error: null, rest: [] };
	}

	async function send(fields: SendFields): Promise<number[]> {
		const ids: number[] = [];
		const modes: Mode[] = rich ? ["rich", "html", "plain"] : ["html", "plain"];
		let chunks: string[] | null = null;
		for (const mode of modes) {
			try {
				chunks ??= render[mode](fields.markdown);
				const placed = await sendChunks(mode, chunks, fields);
				ids.push(...placed.ids);
				if (placed.error === null) break;
				failure(`deliver.${mode}`, placed.error, { threadId: fields.threadId ?? null });
				if (mode === "rich") dropRich(placed.error, { threadId: fields.threadId ?? null });
				const next = nextMode(mode);
				if (!recoverable(placed.error) || next === null) break;
				chunks = carryInto(next, placed.rest);
			} catch (error) {
				failure(`deliver.${mode}`, error, { threadId: fields.threadId ?? null });
				if (mode === "rich") dropRich(error, { threadId: fields.threadId ?? null });
				chunks = null;
				if (nextMode(mode) === null) break;
			}
		}
		const root = ids[0];
		// Remembered so a later `edit` of this message patches the tail instead of re-posting it.
		if (root !== undefined) track(continuationKey(fields.chatId, root), ids.slice(1));
		return ids;
	}

	/** Patches one continuation of an edited message, logging — never propagating — a refusal. */
	async function patchQuiet(mode: Mode, fields: EditFields, text: string, props: PostProps): Promise<void> {
		try {
			await patch[mode](fields, text, props);
		} catch (error) {
			if (unchanged(error)) return;
			failure(`deliver.${mode}`, error, { messageId: fields.messageId });
		}
	}

	/**
	 * Brings the continuations of an edited message up to date: known ones are
	 * patched in place, only chunks without a continuation are sent, and
	 * continuations the answer no longer reaches are blanked (Telegram refuses
	 * empty text and has no delete, so a revision is never left visible). The
	 * keyboard rides the last chunk, as in {@link send}.
	 */
	async function editContinuations(
		mode: Mode,
		fields: EditFields,
		key: string,
		chunks: readonly string[],
	): Promise<void> {
		const known = continuations.get(key) ?? [];
		for (let index = 0; index < Math.min(known.length, chunks.length); index += 1) {
			const props = index === chunks.length - 1 ? markupField(fields.replyMarkup) : {};
			await patchQuiet(mode, { ...fields, messageId: known[index] }, chunks[index], props);
		}
		if (chunks.length > known.length) {
			const placed = await sendChunks(mode, chunks.slice(known.length), fields);
			track(key, placed.ids);
			if (placed.error !== null) failure(`deliver.${mode}`, placed.error, { threadId: fields.threadId ?? null });
		}
		for (let index = chunks.length; index < known.length; index += 1) {
			await patchQuiet(mode, { ...fields, messageId: known[index] }, CLIP, {});
		}
	}

	async function editOne(mode: Mode, fields: EditFields): Promise<void> {
		const chunks = render[mode](fields.markdown);
		if (!inThread(fields.threadId)) {
			await patch[mode](fields, clipText(chunks.join("\n"), LIMITS[mode]), markupField(fields.replyMarkup));
			return;
		}
		const key = continuationKey(fields.chatId, fields.messageId);
		if (chunks.length <= 1) {
			await patch[mode](fields, clipText(chunks.join("\n"), LIMITS[mode]), markupField(fields.replyMarkup));
			await editContinuations(mode, fields, key, []);
			return;
		}
		await patch[mode](fields, chunks[0], {});
		await editContinuations(mode, fields, key, chunks.slice(1));
	}

	async function edit(fields: EditFields): Promise<boolean> {
		const modes: Mode[] = rich ? ["rich", "html", "plain"] : ["html", "plain"];
		for (const mode of modes) {
			try {
				await editOne(mode, fields);
				return true;
			} catch (error) {
				if (unchanged(error)) {
					note("deliver.edit_unchanged", { messageId: fields.messageId });
					return true;
				}
				failure(`deliver.${mode}`, error, { messageId: fields.messageId });
				if (mode === "rich") dropRich(error, { messageId: fields.messageId });
				if (!recoverable(error) || nextMode(mode) === null) return false;
			}
		}
		return false;
	}

	async function draft(fields: DraftFields): Promise<boolean> {
		if (!rich || Number(fields.chatId) <= 0 || typeof api.sendRichMessageDraft !== "function") return false;
		const thinking = fields.thinking ?? null;
		const markdown = fields.markdown ?? "";
		const shapes = draftShape === 0 ? [0, 1] : [1, 0];
		for (const shape of shapes) {
			try {
				await api.sendRichMessageDraft({
					chatId: fields.chatId,
					...threadField(fields.threadId),
					draftId: fields.draftId,
					richMessage: draftMessage(markdown, thinking, shape),
					canStop: fields.canStop === true,
				});
				draftShape = shape;
				return true;
			} catch (error) {
				failure(`deliver.draft_${shape}`, error, { threadId: fields.threadId ?? null });
				if (methodMissing(error)) {
					rich = false;
					note("deliver.rich_off", { threadId: fields.threadId ?? null });
					return false;
				}
			}
		}
		return false;
	}

	return { send, edit, draft };
}
