/**
 * The ⚡ topic icon a private chat shows while a turn runs.
 *
 * Telegram exposes custom topic icons as premium stickers; a controller caches
 * the sticker id on first use and disables itself after the first refusal, so
 * a chat without rights never pays a failing call per turn.
 */
import { logger } from "@oh-my-pi/pi-utils";
import { errorText } from "./text";
import type { TelegramApi } from "./types";

const TURN_EMOJI = "⚡";
const VARIATION_SELECTOR = /\uFE0F/gu;

/** Topic-icon controller for one chat. */
export interface TurnIcon {
	/** Sets (`on`) or clears (`off`) the ⚡ icon. False when unavailable. */
	set(threadId: number, on: boolean): Promise<boolean>;
}

export function createTurnIcon(options: { api: TelegramApi; chatId: number }): TurnIcon {
	const { api, chatId } = options;
	const privateChat = chatId > 0;
	let stickers: readonly { emoji?: string; custom_emoji_id?: string }[] | null = null;
	let iconId: string | null = null;
	let disabled = false;

	async function resolveIconId(): Promise<string | null> {
		if (iconId !== null) return iconId;
		if (stickers === null) {
			try {
				stickers = await api.getForumTopicIconStickers();
			} catch (error) {
				stickers = [];
				logger.debug("telegram: topic icon stickers unavailable", { error: errorText(error) });
			}
		}
		const found = stickers.find(
			sticker => String(sticker?.emoji ?? "").replace(VARIATION_SELECTOR, "") === TURN_EMOJI,
		);
		const id = found?.custom_emoji_id;
		if (typeof id !== "string" || id === "") {
			logger.debug("telegram: no ⚡ topic icon sticker", { emoji: TURN_EMOJI });
			return null;
		}
		iconId = id;
		return iconId;
	}

	return {
		async set(threadId, on) {
			if (disabled || !privateChat) return false;
			try {
				const id = on ? await resolveIconId() : "";
				if (id === null) return false;
				await api.editForumTopic({ chatId, threadId, iconCustomEmojiId: id });
				return true;
			} catch (error) {
				disabled = true;
				logger.debug("telegram: turn icon disabled", { threadId, error: errorText(error) });
				return false;
			}
		},
	};
}
