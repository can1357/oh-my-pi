type ExtractionRate = {
	total: number;
	survived: number;
	dropped: number;
	rate: number;
	dropped_samples: string[];
};

const CONTRACTIONS: readonly [RegExp, string][] = [
	[/\bu\b/g, "you"],
	[/\bur\b/g, "your"],
	[/\bu're\b/g, "you are"],
	[/\br\b/g, "are"],
	[/\by\b/g, "why"],
	[/\bb4\b/g, "before"],
	[/\bbc\b/g, "because"],
	[/\bcuz\b/g, "because"],
	[/\bgonna\b/g, "going to"],
	[/\bwanna\b/g, "want to"],
	[/\bgotta\b/g, "got to"],
	[/\bkinda\b/g, "kind of"],
	[/\bsorta\b/g, "sort of"],
	[/\bdunno\b/g, "don't know"],
	[/\blemme\b/g, "let me"],
	[/\bgimme\b/g, "give me"],
	[/\boutta\b/g, "out of"],
	[/\bhafta\b/g, "have to"],
	[/\bshoulda\b/g, "should have"],
	[/\bwoulda\b/g, "would have"],
	[/\bcoulda\b/g, "could have"],
];

const FILLER_WORDS: Readonly<Record<string, true>> = {
	afaik: true,
	brb: true,
	fr: true,
	fwiw: true,
	idc: true,
	idk: true,
	iirc: true,
	ikr: true,
	imho: true,
	imo: true,
	irl: true,
	istg: true,
	lmao: true,
	lmaoo: true,
	lmfao: true,
	lol: true,
	ngl: true,
	nvm: true,
	omg: true,
	omgg: true,
	omggg: true,
	rofl: true,
	smh: true,
	tbh: true,
	tldr: true,
	w: true,
	wdym: true,
	wtf: true,
};

const FRAGMENT_STARTERS: Readonly<Record<string, true>> = {
	building: true,
	checking: true,
	coming: true,
	deploying: true,
	feeling: true,
	fixing: true,
	going: true,
	hoping: true,
	looking: true,
	planning: true,
	running: true,
	testing: true,
	thinking: true,
	trying: true,
	wondering: true,
	working: true,
};

const EDGE_PUNCTUATION_RE = /^[.,!?;:'"]+|[.,!?;:'"]+$/g;
const REPEATED_CHARS_RE = /(.)\1{2,}/g;
function replaceNonAsciiRuns(value: string): string {
	let normalized = "";
	let inNonAsciiRun = false;
	for (let index = 0; index < value.length; index++) {
		const char = value[index];
		if (char === undefined) continue;
		if (char.charCodeAt(0) > 0x7f) {
			if (!inNonAsciiRun) normalized += " ";
			inNonAsciiRun = true;
		} else {
			normalized += char;
			inNonAsciiRun = false;
		}
	}
	return normalized;
}

export function normalizeChat(text: string, options: { add_implicit_subjects?: boolean } = {}): string | null {
	const addImplicitSubjects = options.add_implicit_subjects ?? true;
	if (text.trim().length === 0) return null;

	let normalized = text.toLowerCase().trim();
	for (const [pattern, replacement] of CONTRACTIONS) {
		normalized = normalized.replace(pattern, replacement);
	}

	const meaningful = normalized
		.split(/\s+/)
		.filter(word => FILLER_WORDS[word.replace(EDGE_PUNCTUATION_RE, "")] !== true);
	if (meaningful.length === 0) return null;

	normalized = meaningful.join(" ");
	normalized = normalized.replace(REPEATED_CHARS_RE, "$1");
	normalized = replaceNonAsciiRuns(normalized);
	normalized = normalized.split(/\s+/).filter(Boolean).join(" ");

	const words = normalized.length === 0 ? [] : normalized.split(" ");
	const wordCount = words.length;
	if (wordCount < 2) {
		if (wordCount === 1 && (words[0]?.length ?? 0) > 5) return normalized;
		return null;
	}

	if (addImplicitSubjects && wordCount === 2) {
		const firstWord = words[0] ?? "";
		if (FRAGMENT_STARTERS[firstWord] === true) normalized = `i am ${normalized}`;
	}

	return normalized;
}
export function normalizeBatch(messages: string[]): (string | null)[] {
	return messages.map(message => normalizeChat(message));
}
export function extractionRate(messages: string[]): ExtractionRate {
	const normalized = normalizeBatch(messages);
	let survived = 0;
	const droppedSamples: string[] = [];

	for (let i = 0; i < messages.length; i += 1) {
		if (normalized[i] !== null) {
			survived += 1;
		} else if (droppedSamples.length < 5) {
			const message = messages[i];
			if (message !== undefined) droppedSamples.push(message);
		}
	}

	const dropped = messages.length - survived;
	return {
		total: messages.length,
		survived,
		dropped,
		rate: messages.length === 0 ? 0.0 : Math.round((survived / messages.length) * 1000) / 1000,
		dropped_samples: droppedSamples,
	};
}
