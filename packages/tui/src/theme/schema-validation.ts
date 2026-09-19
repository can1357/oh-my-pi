import { type } from "@oh-my-pi/omptype";
import type { SpinnerFramesOverride } from "./symbols";
import type { ThemeJson } from "./schema";

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
	"assistantMessageText?": "string | number",
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
});

const spinnerFramesSchema = type("unknown").narrow((value): value is SpinnerFramesOverride => {
	if (Array.isArray(value)) return value.length >= 1 && value.every(item => typeof item === "string");
	if (!value || typeof value !== "object") return false;
	const obj = value as Record<string, unknown>;
	const status = obj.status;
	const activity = obj.activity;
	if (status === undefined && activity === undefined) return false;
	if (
		status !== undefined &&
		(!Array.isArray(status) || status.length < 1 || !status.every(item => typeof item === "string"))
	) {
		return false;
	}
	if (
		activity !== undefined &&
		(!Array.isArray(activity) || activity.length < 1 || !activity.every(item => typeof item === "string"))
	) {
		return false;
	}
	return true;
});

const themeJsonSchema = type({
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

/** Validate a custom theme with the full omptype contract. */
export function validateThemeJson(value: unknown): ThemeJson {
	const parsed = themeJsonSchema(value);
	if (parsed instanceof type.errors) throw new Error(parsed.summary);
	return parsed as ThemeJson;
}
