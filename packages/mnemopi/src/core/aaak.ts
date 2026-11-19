export const CATEGORY_MAP = {
	PREFERENCE: "PREF",
	TRAIT: "TRAIT",
	STATUS: "STAT",
	INSTRUCTION: "INST",
	PROJECT: "PROJ",
	LOCATION: "LOC",
	FAMILY: "FAM",
	OCCUPATION: "OCC",
	DECISION: "DEC",
	EVENT: "EVT",
	TOOL: "TOOL",
	FACT: "FACT",
	OPINION: "OPN",
} as const;

export const PHRASE_MAP = {
	"User asked ": "ASK ",
	"User wants ": "WANT ",
	"User prefers ": "PREF ",
	"User likes ": "LIKE ",
	"User dislikes ": "DISLIKE ",
	"User is ": "IS ",
	"User has ": "HAS ",
	"User built ": "BUILT ",
	"User asked for ": "ASK ",
	"User requested ": "REQ ",
	"Married to ": "MARRIED→",
	"Email: ": "@",
	"GitHub: ": "GH:",
	"Location: ": "LOC:",
	"Phone: ": "PH:",
	"User email is ": "@",
	"User voice message ": "VM ",
	"User stack: ": "STACK|",
	"Full-stack developer": "FSDEV",
	"Software Developer": "SDEV",
	"AI Systems Engineer": "AIENG",
	"real-time": "RT",
	"Real-time": "RT",
	bilingual: "bi",
	Bilingual: "bi",
	"self-hosted": "selfhost",
	automation: "auto",
	transcription: "transc",
	translation: "transl",
} as const;

export const STRUCTURAL_REPLACEMENTS: readonly (readonly [pattern: string, replacement: string])[] = [
	[" - ", " | "],
	[" -- ", " | "],
	[" | ", " | "],
	[", ", " | "],
	[" and ", "+"],
	[" or ", "/"],
	[" for ", "→"],
	[" to ", "→"],
	[" with ", " w/ "],
	[" over ", ">"],
	[" instead of ", "!>"],
	[" because of ", "∵"],
	[" due to ", "∵"],
	[" using ", "→"],
	[" built ", "→"],
	[" in ", ":"],
	[" at ", "@"],
	[" on ", "@"],
	[" from ", "<-"],
];

function reverseMap<const T extends Readonly<Record<string, string>>>(source: T): Record<T[keyof T], keyof T & string> {
	const reversed = Object.create(null) as Record<T[keyof T], keyof T & string>;
	for (const rawKey in source) {
		const key = rawKey as keyof T & string;
		const value = source[key];
		reversed[value] = key;
	}
	return reversed;
}

export const REV_CATEGORY = reverseMap(CATEGORY_MAP);

/**
 * Literal pattern for `phrase` that never matches inside a longer word: an edge that is a
 * word character must sit on a word boundary, so `complete` leaves `incomplete` and
 * `completed` intact. Space and punctuation edges match as before.
 */
function wholeWordPattern(phrase: string): RegExp {
	const start = /^[\p{L}\p{N}_]/u.test(phrase) ? "(?<![\\p{L}\\p{N}_])" : "";
	const end = /[\p{L}\p{N}_]$/u.test(phrase) ? "(?![\\p{L}\\p{N}_])" : "";
	return new RegExp(`${start}${RegExp.escape(phrase)}${end}`, "gu");
}

const PHRASE_PATTERNS = Object.entries(PHRASE_MAP)
	.sort(([left], [right]) => right.length - left.length)
	.map(([phrase, shorthand]) => [wholeWordPattern(phrase), shorthand] as const);
export const REV_PHRASE = reverseMap(PHRASE_MAP);

const STATUS_SHORTHANDS = [
	[wholeWordPattern("working correctly"), "OK"],
	[wholeWordPattern("working"), "OK"],
	[wholeWordPattern("complete"), "DONE"],
	[wholeWordPattern("completed"), "DONE"],
] as const;

function replaceAllLiteral(text: string, pattern: string, replacement: string): string {
	return text.replaceAll(pattern, replacement);
}

export function applyCategoryPrefixes(text: string): string {
	for (const rawFull in CATEGORY_MAP) {
		const full = rawFull as keyof typeof CATEGORY_MAP;
		const prefix = `${full}: `;
		if (text.startsWith(prefix)) {
			return text.replace(prefix, `${CATEGORY_MAP[full]}|`);
		}
	}
	return text;
}

export function applyPhrases(text: string): string {
	let result = text;
	for (const [pattern, shorthand] of PHRASE_PATTERNS) {
		result = result.replace(pattern, shorthand);
	}
	return result;
}

export function applyStructural(text: string): string {
	let result = text;
	for (const [pattern, replacement] of STRUCTURAL_REPLACEMENTS) {
		result = replaceAllLiteral(result, pattern, replacement);
	}
	return result;
}

export function compactParens(text: string): string {
	return text.replace(/\(\s*/g, "(").replaceAll(" )", ")");
}

export function encode(text: string): string {
	if (text.length === 0) {
		return text;
	}

	if (text.includes("|") && text.trim().split(/\s+/).length <= 3) {
		return text;
	}

	let result = text.trim();
	result = applyCategoryPrefixes(result);
	result = applyPhrases(result);
	result = applyStructural(result);
	result = compactParens(result);
	for (const [pattern, shorthand] of STATUS_SHORTHANDS) {
		result = result.replace(pattern, shorthand);
	}
	return result.trim();
}

export const aaakEncode = encode;
