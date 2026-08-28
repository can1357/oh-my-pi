import {
	type Component,
	extractPrintableText,
	fuzzyFilter,
	matchesKey,
	ScrollView,
	Spacer,
	Text,
	truncateToWidth,
} from "@oh-my-pi/pi-tui";
import { theme } from "../../modes/theme/theme";
import { matchesSelectCancel, matchesSelectDown, matchesSelectUp } from "../../modes/utils/keybinding-matchers";
import { OverlayPanel } from "./overlay-box";

interface UserMessageItem {
	id: string; // Entry ID in the session
	text: string; // The message text
	timestamp?: string; // Optional timestamp if available
}

/**
 * Custom user message list component with selection
 */
class UserMessageList implements Component {
	#filteredMessages: UserMessageItem[];
	#searchQuery = "";
	#selectedIndex: number = 0;
	onSelect?: (entryId: string) => void;
	onCancel?: () => void;
	#maxVisible: number = 10; // Max messages visible

	constructor(private readonly messages: UserMessageItem[]) {
		// Store messages in chronological order (oldest to newest)
		this.#filteredMessages = messages;
		// Start with the last (most recent) message selected
		this.#selectedIndex = Math.max(0, this.#filteredMessages.length - 1);
	}

	invalidate(): void {
		// No cached state to invalidate currently
	}

	#isSearchEnabled(): boolean {
		return this.messages.length > this.#maxVisible;
	}

	#shouldRenderSearchStatus(): boolean {
		return this.#isSearchEnabled() || this.#searchQuery.length > 0;
	}

	#renderStatusLine(_total: number): string {
		const query = this.#searchQuery.trim();
		const suffix = query ? `Search: ${this.#searchQuery}` : "Type to search";
		return theme.fg("muted", `  ${suffix}`);
	}

	#setSearchQuery(query: string): void {
		this.#searchQuery = query;
		this.#filteredMessages = query.trim()
			? fuzzyFilter(this.messages, query, message => `${message.text} ${message.timestamp ?? ""}`)
			: this.messages;
		this.#selectedIndex = query.trim() ? 0 : Math.max(0, this.#filteredMessages.length - 1);
	}

	#handleSearchInput(keyData: string): boolean {
		if (!this.#isSearchEnabled()) return false;

		if (matchesKey(keyData, "backspace")) {
			if (this.#searchQuery.length === 0) return false;
			const chars = [...this.#searchQuery];
			chars.pop();
			this.#setSearchQuery(chars.join(""));
			return true;
		}

		const printableText = extractPrintableText(keyData);
		if (printableText === undefined) return false;
		if (this.#searchQuery.length === 0 && printableText.trim().length === 0) return false;

		this.#setSearchQuery(this.#searchQuery + printableText);
		return true;
	}

	render(width: number): readonly string[] {
		const lines: string[] = [];

		if (this.messages.length === 0) {
			lines.push(theme.fg("muted", "  No user messages found"));
			return lines;
		}

		const total = this.#filteredMessages.length;

		// Calculate visible range with scrolling
		const startIndex = Math.max(
			0,
			Math.min(this.#selectedIndex - Math.floor(this.#maxVisible / 2), total - this.#maxVisible),
		);
		const endIndex = Math.min(startIndex + this.#maxVisible, total);

		// Render visible messages (2 lines per message + blank line)
		const overflow = total > this.#maxVisible;
		const rowWidth = Math.max(0, width - (overflow ? 1 : 0));
		const messageLines: string[] = [];
		for (let i = startIndex; i < endIndex; i++) {
			const message = this.#filteredMessages[i];
			if (!message) continue;
			const isSelected = i === this.#selectedIndex;

			// Normalize message to single line
			const normalizedMessage = message.text.replace(/\n/g, " ").trim();

			// First line: cursor + message
			const cursor = isSelected ? theme.fg("accent", "› ") : "  ";
			const maxMsgWidth = rowWidth - 2; // Account for cursor (2 chars)
			const truncatedMsg = truncateToWidth(normalizedMessage, maxMsgWidth);
			const messageLine = cursor + (isSelected ? theme.bold(truncatedMsg) : truncatedMsg);

			messageLines.push(messageLine);

			// Second line: metadata (position in history)
			const position = this.messages.indexOf(message) + 1;
			const metadata = `  Message ${position} of ${this.messages.length}`;
			const metadataLine = theme.fg("muted", metadata);
			messageLines.push(metadataLine);
			messageLines.push(""); // Blank line between messages
		}

		if (total === 0) {
			lines.push(theme.fg("muted", "  No matching messages"));
		} else {
			const visibleCount = endIndex - startIndex;
			const linesPerItem = visibleCount > 0 ? messageLines.length / visibleCount : 1;
			const sv = new ScrollView(messageLines, {
				height: messageLines.length,
				scrollbar: "auto",
				totalRows: Math.round(total * linesPerItem),
				theme: { track: t => theme.fg("muted", t), thumb: t => theme.fg("accent", t) },
			});
			sv.setScrollOffset(Math.round(startIndex * linesPerItem));
			lines.push(...sv.render(width));
		}

		// Add search indicator if needed
		if (this.#shouldRenderSearchStatus()) {
			lines.push(this.#renderStatusLine(total));
		}

		return lines;
	}

	handleInput(keyData: string): void {
		// Escape / cancel
		if (matchesSelectCancel(keyData)) {
			if (this.onCancel) {
				this.onCancel();
			}
			return;
		}

		if (this.#handleSearchInput(keyData)) {
			return;
		}

		// Up arrow - go to previous (older) message, wrap to bottom when at top
		if (matchesSelectUp(keyData)) {
			if (this.#filteredMessages.length > 0) {
				this.#selectedIndex =
					this.#selectedIndex === 0 ? this.#filteredMessages.length - 1 : this.#selectedIndex - 1;
			}
		}
		// Down arrow - go to next (newer) message, wrap to top when at bottom
		else if (matchesSelectDown(keyData)) {
			if (this.#filteredMessages.length > 0) {
				this.#selectedIndex =
					this.#selectedIndex === this.#filteredMessages.length - 1 ? 0 : this.#selectedIndex + 1;
			}
		}
		// Enter - select message and branch
		else if (matchesKey(keyData, "enter") || matchesKey(keyData, "return") || keyData === "\n") {
			const selected = this.#filteredMessages[this.#selectedIndex];
			if (selected && this.onSelect) {
				this.onSelect(selected.id);
			}
		}
	}
}

/**
 * Component that renders a user message selector for branching
 */
export class UserMessageSelectorComponent extends OverlayPanel {
	#messageList: UserMessageList;

	constructor(messages: UserMessageItem[], onSelect: (entryId: string) => void, onCancel: () => void) {
		super("Branch from Message");

		this.addChild(new Text(theme.fg("muted", "Select a message to create a new branch from that point"), 0, 0));
		this.addChild(new Spacer(1));

		// Create message list
		this.#messageList = new UserMessageList(messages);
		this.#messageList.onSelect = onSelect;
		this.#messageList.onCancel = onCancel;

		this.addChild(this.#messageList);

		this.addChild(new Spacer(1));

		// Auto-cancel if no messages
		if (messages.length === 0) {
			setTimeout(() => onCancel(), 100);
		}
	}

	getMessageList(): UserMessageList {
		return this.#messageList;
	}
}
