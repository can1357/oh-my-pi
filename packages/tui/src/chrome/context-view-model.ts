/** Context snapshot shapes shared by the session snapshot builder and the context viewer. */
import { t as __ompTranslate } from "@oh-my-pi/pi-utils/i18n";
import type { ContextBreakdown } from "../status-line/context-usage";

interface ContextCategoryDescriptor {
	readonly id: string;
	readonly label: string;
	/** Overview row label when the Overview weight differs from the category's content. */
	readonly overviewLabel?: string;
	/** Listed with its weight but never opened. */
	readonly openable?: false;
}

/** Context categories in display order. */
export const CONTEXT_CATEGORIES = [
	// The Overview weight excludes the Skills listing; content views keep complete system blocks.
	{
		id: "system-prompt",
		label: __ompTranslate("System Prompt"),
		overviewLabel: __ompTranslate("System Prompt (excluding Skills)"),
	},
	// An estimate of the prompt's skill listing, without entries of its own.
	{ id: "skills", label: __ompTranslate("Skills"), openable: false },
	{ id: "built-in-tools", label: __ompTranslate("Built-in Tools") },
	{ id: "custom-tools", label: __ompTranslate("Custom Tools") },
	{ id: "user-messages", label: __ompTranslate("User / Developer Messages") },
	{ id: "assistant-messages", label: __ompTranslate("Assistant Messages") },
	{ id: "assistant-thinking", label: __ompTranslate("Assistant Thinking") },
	{ id: "tool-calls", label: __ompTranslate("Tool Calls") },
	{ id: "tool-output", label: __ompTranslate("Tool Output") },
] as const satisfies readonly ContextCategoryDescriptor[];

export type ContextCategoryId = (typeof CONTEXT_CATEGORIES)[number]["id"];

const DESCRIPTORS_BY_ID = new Map<ContextCategoryId, ContextCategoryDescriptor>(
	CONTEXT_CATEGORIES.map(descriptor => [descriptor.id, descriptor]),
);

/** Descriptor of a category id: its label, optional Overview label, and whether it can be opened. */
export function contextCategoryDescriptor(id: ContextCategoryId): ContextCategoryDescriptor {
	return DESCRIPTORS_BY_ID.get(id)!;
}

export interface ContextThinkingGroup {
	readonly id: string;
	readonly label: string;
	readonly tokens: number;
	readonly interrupted?: boolean;
}

export interface ContextViewEntry {
	readonly id: string;
	readonly label: string;
	readonly text: string;
	/** Aggregation weight for the unscaled replay estimate; shared blocks contribute through their group. */
	readonly tokens: number;
	readonly interrupted?: boolean;
	readonly thinkingGroup?: ContextThinkingGroup;
	readonly path?: string;
	readonly info?: string;
	readonly timestamp?: number;
	readonly callId?: string;
}

export interface ContextViewCategory {
	id: ContextCategoryId;
	key?: string;
	label: string;
	/** Overview attribution weight, not reported usage; may differ from the entry sum (e.g. Skills subtraction). */
	tokens: number;
	entries: ContextViewEntry[];
	children?: ContextViewCategory[];
}

export interface ContextViewData {
	readonly breakdown: ContextBreakdown;
	readonly categories: readonly ContextViewCategory[];
}
