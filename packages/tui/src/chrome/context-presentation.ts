import type { ThemeColor } from "../theme";
import type { SymbolKey } from "../theme/symbols";
import type { ContextCategoryId } from "./context-view-model";

/** Shared category styles for maps and interactive legends; resolve glyphs at render time. */
const SYSTEM = { color: "accent", symbol: "context.content" } as const;
const DETAILS = { color: "customMessageLabel", symbol: "context.content" } as const;
const TOOLS = { color: "warning", symbol: "context.content" } as const;
const SKILLS = { color: "success", symbol: "context.content" } as const;
const MESSAGES = { color: "userMessageText", symbol: "context.messages" } as const;
const OUTPUT = { color: "muted", symbol: "context.messages" } as const;
export const CONTEXT_PRESENTATION = {
	"system-prompt": SYSTEM,
	skills: SKILLS,
	"built-in-tools": TOOLS,
	"custom-tools": DETAILS,
	// Shares the System Prompt color; the message glyph tells them apart in the map.
	"user-messages": { color: "accent", symbol: "context.messages" },
	"assistant-messages": MESSAGES,
	"assistant-thinking": DETAILS,
	"tool-calls": TOOLS,
	"tool-output": OUTPUT,
	buffer: { color: "warning", symbol: "context.buffer" },
	free: { color: "dim", symbol: "context.free" },
} as const satisfies Record<ContextPresentationId, { color: ThemeColor; symbol: SymbolKey }>;
export type ContextPresentationId = ContextCategoryId | "buffer" | "free";
