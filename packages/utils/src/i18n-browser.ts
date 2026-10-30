import { createTranslator, type Messages } from "./i18n-core";

let language: "ko" | "en" = "en";
let messages: Messages = {};
export let t = createTranslator(messages);

// pi-utils also compiles in Node hosts whose ambient document type is deliberately minimal.
const host = globalThis as unknown as {
	__OMP_I18N__?: unknown;
	document?: {
		getElementById(id: string): { textContent: string | null } | null;
		documentElement: { lang: string };
	};
};

/** Importing this module never reads the DOM or loads a language pack. */
export function getLanguage(): "ko" | "en" {
	return language;
}

export function getMessages(): Messages {
	return messages;
}

/** Await before rendering UI or registering translated custom elements. */
export async function initializeI18n(): Promise<void> {
	language = "en";
	messages = {};
	t = createTranslator(messages);
	try {
		const data = host.document?.getElementById("omp-i18n");
		const selected: unknown = data ? JSON.parse(data.textContent ?? "") : host.__OMP_I18N__;
		if (selected !== undefined) {
			if (typeof selected !== "object" || selected === null || Array.isArray(selected)) {
				throw new Error("Invalid browser language pack.");
			}
			const pack = selected as { language?: unknown; messages?: unknown };
			if (typeof pack.language === "string" && /^ko(?:-kr)?$/i.test(pack.language)) {
				// The host supplies validated messages; no catalog is hidden in the English bundle.
				const next = createTranslator(pack.messages);
				messages = pack.messages as Messages;
				t = next;
				language = "ko";
			}
		}
	} catch {
		// Neither rejected data nor exception details may disclose host/user secrets.
		console.error("Could not load Korean language pack; using English.");
	}
	if (host.document) host.document.documentElement.lang = language;
}
