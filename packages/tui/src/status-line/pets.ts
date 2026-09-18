import { theme } from "../theme";

const BUCKET_MS = 120_000;
const FRESH_MS = 120_000;
const OVERLOAD_PERCENT = 85;

// Code Cat's four faces and session-stable rotation, with English messages.
const POOLS = {
	thinking: {
		face: "(=^-.-^=)c(_)",
		lines: [
			"This cat is deep in thought.",
			"The CPU is purring!",
			"Quiet, my neurons are working at full speed.",
			"Let me think... where are the treats? I mean, the logic.",
			"Thinking... one of life's great feline mysteries.",
			"Exploring the solution space across all nine lives.",
			"Recursion too deep. Untangling a ball of yarn first.",
			"Shh, an idea is about to bite.",
			"Compiling cat thoughts... 99% complete.",
			"Diving deep into the code. Do not disturb.",
			"Paw on chin. Entering wise-cat mode.",
			"My whiskers say this plan could work!",
		],
	},
	idle: {
		face: "(=^.w.^=)",
		lines: [
			"I am watching over you. Keep coding!",
			"Your code is looking lovely today.",
			"This line of code is cat-approved.",
			"Meow? Nice variable name.",
			"Take breaks in moderation. Pet cats without limits.",
			"With this cat on guard, bugs had better beware.",
			"The keyboard is yours. Your lap is mine.",
			"Tired of coding? Look at the cat to recharge.",
			"Ship something elegant today. Meow!",
			"Remember to drink water, not just lick your paws.",
			"I will debug with you until the end of time.",
			"The tail forecast says it is a good day to commit.",
		],
	},
	fresh: {
		face: "(=^-.-^=)zZ",
		lines: [
			"Just woke up. Ready to build something?",
			"New session! What shall we make today?",
			"A little stretch... all right, let's get to work!",
			"Your cat is ready. Awaiting instructions!",
			"A fine day for coding, not loafing. Except for me.",
			"Magic cat online. Make a wish!",
			"First goal: zero errors, zero warnings.",
			"Good morning, human! I mean, engineer!",
			"Paws warmed up. Keyboard polished.",
			"A coffee, a cat, and some cheerful coding.",
		],
	},
	overload: {
		face: "(=;x.x;=);;",
		lines: [
			"My brain is about to burst. Meow!",
			"Context is full of treats. Time for /compact!",
			"Memory is overflowing. I am starting to forget...",
			"No room left. Could we tidy up?",
			"I have used eight and a half of my nine lives!",
			"Context pressure alert. My ears are steaming.",
			"Compact soon or I might cough up a hairball.",
			"Running out of room. Save your progress!",
		],
	},
};

export function renderPetStatus(
	sessionId: string,
	createdAt: string | undefined,
	contextPercent: number,
	isStreaming: boolean,
	now = Date.now(),
): string {
	const age = createdAt ? now - Date.parse(createdAt) : Number.POSITIVE_INFINITY;
	const state =
		contextPercent >= OVERLOAD_PERCENT ? "overload" : age < FRESH_MS ? "fresh" : isStreaming ? "thinking" : "idle";
	const pool = POOLS[state];
	let seed = 0x811c9dc5;
	for (let i = 0; i < sessionId.length; i++) {
		seed = Math.imul(seed ^ sessionId.charCodeAt(i), 0x01000193) >>> 0;
	}
	const line = pool.lines[(seed + Math.floor(now / BUCKET_MS)) % pool.lines.length];
	return `${theme.fg("warning", pool.face)} "${line}"`;
}
