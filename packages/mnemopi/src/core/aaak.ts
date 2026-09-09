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

const SORTED_PHRASES = Object.entries(PHRASE_MAP).sort(([left], [right]) => right.length - left.length);
export const REV_PHRASE = reverseMap(PHRASE_MAP);

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
	for (const [phrase, shorthand] of SORTED_PHRASES) {
		result = replaceAllLiteral(result, phrase, shorthand);
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
	result = result.replaceAll("working correctly", "OK");
	result = result.replaceAll("working", "OK");
	result = result.replaceAll("complete", "DONE");
	result = result.replaceAll("completed", "DONE");
	return result.trim();
}

export const aaakEncode = encode;
