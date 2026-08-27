import { type } from "@oh-my-pi/omptype";
import type { SpinnerFramesOverride } from "./symbols";

// ============================================================================
// Types & Schema
// ============================================================================

export type ColorValue = string | number;

const themeColorsSchema = type({
	accent: "string | number",
	border: "string | number",
	borderAccent: "string | number",
	borderMuted: "string | number",
	success: "string | number",
	error: "string | number",
	warning: "string | number",
	muted: "string | number",
	dim: "string | number",
	text: "string | number",
	thinkingText: "string | number",
	selectedBg: "string | number",
	userMessageBg: "string | number",
	userMessageText: "string | number",
	customMessageBg: "string | number",
	customMessageText: "string | number",
	customMessageLabel: "string | number",
	toolPendingBg: "string | number",
	toolSuccessBg: "string | number",
	toolErrorBg: "string | number",
	toolTitle: "string | number",
	toolOutput: "string | number",
	mdHeading: "string | number",
	mdLink: "string | number",
	mdLinkUrl: "string | number",
	mdCode: "string | number",
	mdCodeBlock: "string | number",
	mdCodeBlockBorder: "string | number",
	mdQuote: "string | number",
	mdQuoteBorder: "string | number",
	mdHr: "string | number",
	mdListBullet: "string | number",
	toolDiffAdded: "string | number",
	toolDiffRemoved: "string | number",
	toolDiffContext: "string | number",
	syntaxComment: "string | number",
	syntaxKeyword: "string | number",
	syntaxFunction: "string | number",
	syntaxVariable: "string | number",
	syntaxString: "string | number",
	syntaxNumber: "string | number",
	syntaxType: "string | number",
	syntaxOperator: "string | number",
	syntaxPunctuation: "string | number",
	thinkingOff: "string | number",
	thinkingMinimal: "string | number",
	thinkingLow: "string | number",
	thinkingMedium: "string | number",
	thinkingHigh: "string | number",
	thinkingXhigh: "string | number",
	"thinkingMax?": "string | number",
	bashMode: "string | number",
	pythonMode: "string | number",
	statusLineBg: "string | number",
	statusLineSep: "string | number",
	statusLineModel: "string | number",
	statusLinePath: "string | number",
	statusLineGitClean: "string | number",
	statusLineGitDirty: "string | number",
	statusLineContext: "string | number",
	statusLineSpend: "string | number",
	statusLineStaged: "string | number",
	statusLineDirty: "string | number",
	statusLineUntracked: "string | number",
	statusLineOutput: "string | number",
	statusLineCost: "string | number",
	statusLineSubagents: "string | number",
	"finalAnswerBg?": "string | number",
	"finalAnswerText?": "string | number",
});
const spinnerFramesSchema = type("unknown").narrow((value): value is SpinnerFramesOverride => {
	if (Array.isArray(value)) {
		return value.length >= 1 && value.every(item => typeof item === "string");
	}
	if (value && typeof value === "object") {
		const obj = value as Record<string, unknown>;
		const status = obj.status;
		const activity = obj.activity;
		if (status === undefined && activity === undefined) return false;
		if (status !== undefined) {
			if (!Array.isArray(status) || status.length < 1 || !status.every(item => typeof item === "string")) {
				return false;
			}
		}
		if (activity !== undefined) {
			if (!Array.isArray(activity) || activity.length < 1 || !activity.every(item => typeof item === "string")) {
				return false;
			}
		}
		return true;
	}
	return false;
});
export const themeJsonSchema = type({
	"$schema?": "string",
	name: "string",
	"vars?": { "[string]": "string | number" },
	colors: themeColorsSchema,
	"export?": {
		"pageBg?": "string | number",
		"cardBg?": "string | number",
		"infoBg?": "string | number",
	},
	"symbols?": {
		"preset?": "'unicode' | 'nerd' | 'ascii'",
		"overrides?": { "[string]": "string" },
		"spinnerFrames?": spinnerFramesSchema,
	},
});

export type ThemeJson = typeof themeJsonSchema.infer;

export type ThemeColor =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text"
	| "thinkingText"
	| "userMessageText"
	| "customMessageText"
	| "customMessageLabel"
	| "toolTitle"
	| "toolOutput"
	| "mdHeading"
	| "mdLink"
	| "mdLinkUrl"
	| "mdCode"
	| "mdCodeBlock"
	| "mdCodeBlockBorder"
	| "mdQuote"
	| "mdQuoteBorder"
	| "mdHr"
	| "mdListBullet"
	| "toolDiffAdded"
	| "toolDiffRemoved"
	| "toolDiffContext"
	| "syntaxComment"
	| "syntaxKeyword"
	| "syntaxFunction"
	| "syntaxVariable"
	| "syntaxString"
	| "syntaxNumber"
	| "syntaxType"
	| "syntaxOperator"
	| "syntaxPunctuation"
	| "thinkingOff"
	| "thinkingMinimal"
	| "thinkingLow"
	| "thinkingMedium"
	| "thinkingHigh"
	| "thinkingXhigh"
	| "thinkingMax"
	| "bashMode"
	| "pythonMode"
	| "statusLineSep"
	| "statusLineModel"
	| "statusLinePath"
	| "statusLineGitClean"
	| "statusLineGitDirty"
	| "statusLineContext"
	| "statusLineSpend"
	| "statusLineStaged"
	| "statusLineDirty"
	| "statusLineUntracked"
	| "statusLineOutput"
	| "statusLineCost"
	| "statusLineSubagents"
	| "finalAnswerText";

/** Set of all valid ThemeColor string values for runtime validation */
const THEME_COLOR_RECORD = {
	accent: true,
	border: true,
	borderAccent: true,
	borderMuted: true,
	success: true,
	error: true,
	warning: true,
	muted: true,
	dim: true,
	text: true,
	thinkingText: true,
	userMessageText: true,
	customMessageText: true,
	customMessageLabel: true,
	toolTitle: true,
	toolOutput: true,
	mdHeading: true,
	mdLink: true,
	mdLinkUrl: true,
	mdCode: true,
	mdCodeBlock: true,
	mdCodeBlockBorder: true,
	mdQuote: true,
	mdQuoteBorder: true,
	mdHr: true,
	mdListBullet: true,
	toolDiffAdded: true,
	toolDiffRemoved: true,
	toolDiffContext: true,
	syntaxComment: true,
	syntaxKeyword: true,
	syntaxFunction: true,
	syntaxVariable: true,
	syntaxString: true,
	syntaxNumber: true,
	syntaxType: true,
	syntaxOperator: true,
	syntaxPunctuation: true,
	thinkingOff: true,
	thinkingMinimal: true,
	thinkingLow: true,
	thinkingMedium: true,
	thinkingHigh: true,
	thinkingXhigh: true,
	thinkingMax: true,
	bashMode: true,
	pythonMode: true,
	statusLineSep: true,
	statusLineModel: true,
	statusLinePath: true,
	statusLineGitClean: true,
	statusLineGitDirty: true,
	statusLineContext: true,
	statusLineSpend: true,
	statusLineStaged: true,
	statusLineDirty: true,
	statusLineUntracked: true,
	statusLineOutput: true,
	statusLineCost: true,
	statusLineSubagents: true,
	finalAnswerText: true,
} satisfies Record<ThemeColor, true>;

const VALID_THEME_COLORS: ReadonlySet<string> = new Set(Object.keys(THEME_COLOR_RECORD));

/** Check if a string is a valid ThemeColor value */
export function isValidThemeColor(color: string): color is ThemeColor {
	return VALID_THEME_COLORS.has(color);
}

export type ThemeBg =
	| "selectedBg"
	| "userMessageBg"
	| "customMessageBg"
	| "toolPendingBg"
	| "toolSuccessBg"
	| "toolErrorBg"
	| "statusLineBg"
	| "finalAnswerBg";

export type ColorMode = "truecolor" | "256color";
