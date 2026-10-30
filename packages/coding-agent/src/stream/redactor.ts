import { getAgentDir, getDotenvEnvValues, logger } from "@oh-my-pi/pi-utils";
import { builtinCredentialSecretEntries, collectEnvSecrets, loadSecrets } from "../secrets";
import { CREDENTIAL_PREFIX_RULES } from "../secrets/patterns";

const REDACTION = "••••••";
const MIN_PLAIN_SECRET_LENGTH = 8;
const MIN_TYPED_PREFIX_LENGTH = 6;
const SECRET_NAME_RE = /(KEY|SECRET|TOKEN|PASSWORD|PASSWD|PASS|AUTH|CREDENTIAL|PRIVATE|OAUTH)(_|$)/i;
const ASSIGNMENT_RE = /["']?([A-Za-z_][A-Za-z0-9_]*)["']?\s*(?:=|:)\s*(?:"([^"\s]{4,})"|'([^'\s]{4,})'|([^\s"']{4,}))/g;
const CONNECTION_URL_RE = /[a-z][a-z0-9+.-]*:\/\/[^/:@?#\s]*:([^/?#@\s]+)@/gi;

interface PlainSecret {
	readonly value: string;
	readonly prefix: string;
}

/** Irreversible, deliberately conservative terminal-row redaction for public streams. */
export class StreamRedactor {
	#patterns: readonly RegExp[];
	#plainSecrets: readonly PlainSecret[];

	constructor(patterns: readonly RegExp[], plainSecrets: readonly PlainSecret[]) {
		this.#patterns = patterns;
		this.#plainSecrets = plainSecrets;
	}

	/** Build a redactor from configured secrets, the environment, and user regex sources. */
	static async load(cwd: string, extraPatterns: readonly string[]): Promise<StreamRedactor> {
		const patterns: RegExp[] = builtinCredentialSecretEntries().map(entry => {
			const flags = entry.flags?.includes("g") ? entry.flags : `${entry.flags ?? ""}g`;
			return new RegExp(entry.content, flags);
		});

		const tokenPrefixSources = CREDENTIAL_PREFIX_RULES.filter(rule => rule.mode === "token").map(rule => rule.source);
		const linePrefixSources = CREDENTIAL_PREFIX_RULES.filter(rule => rule.mode === "line").map(rule => rule.source);
		const bearerPrefixSources = CREDENTIAL_PREFIX_RULES.filter(rule => rule.mode === "bearer-token").map(
			rule => rule.source,
		);
		// Left boundary keeps `desk-lamp` from tripping the bare `sk-` introducer.
		patterns.push(new RegExp(`(?<![A-Za-z0-9_-])(?:${tokenPrefixSources.join("|")})\\S*`, "g"));
		patterns.push(new RegExp(`(?:${linePrefixSources.join("|")})[^\\r\\n]*`, "g"));
		patterns.push(new RegExp(`(?<=\\b(?:${bearerPrefixSources.join("|")}))\\S+`, "gi"));

		for (const source of extraPatterns) {
			try {
				patterns.push(new RegExp(source, "g"));
			} catch (error) {
				logger.warn("Skipping invalid stream redaction pattern", { source, error: String(error) });
			}
		}

		const values = new Set<string>();
		const configured = await loadSecrets(cwd, getAgentDir());
		for (const entry of configured) {
			if (entry.type === "plain" && entry.content.length >= MIN_PLAIN_SECRET_LENGTH) values.add(entry.content);
		}
		for (const entry of collectEnvSecrets()) {
			if (entry.content.length >= MIN_PLAIN_SECRET_LENGTH) values.add(entry.content);
		}
		for (const value of getDotenvEnvValues(cwd)) {
			if (value.length >= MIN_PLAIN_SECRET_LENGTH) values.add(value);
		}

		const plainSecrets = [...values].map(value => ({ value, prefix: value.slice(0, MIN_TYPED_PREFIX_LENGTH) }));
		return new StreamRedactor(patterns, plainSecrets);
	}

	/** Redact one ANSI terminal row, dropping styling whenever any sensitive span is found. */
	redactRow(row: string): string {
		const plain = Bun.stripANSI(row);
		const spans: number[] = [];

		for (const pattern of this.#patterns) {
			pattern.lastIndex = 0;
			let match: RegExpExecArray | null;
			while ((match = pattern.exec(plain)) !== null) {
				if (match[0].length > 0) {
					spans.push(match.index, match.index + match[0].length);
				} else {
					pattern.lastIndex++;
				}
			}
		}

		ASSIGNMENT_RE.lastIndex = 0;
		let assignment: RegExpExecArray | null;
		while ((assignment = ASSIGNMENT_RE.exec(plain)) !== null) {
			if (!SECRET_NAME_RE.test(assignment[1])) continue;
			const value = assignment[2] ?? assignment[3] ?? assignment[4];
			const start = assignment.index + assignment[0].lastIndexOf(value);
			spans.push(start, start + value.length);
		}

		CONNECTION_URL_RE.lastIndex = 0;
		let connection: RegExpExecArray | null;
		while ((connection = CONNECTION_URL_RE.exec(plain)) !== null) {
			const password = connection[1];
			const start = connection.index + connection[0].lastIndexOf(password);
			spans.push(start, start + password.length);
		}

		for (const secret of this.#plainSecrets) {
			let start = plain.indexOf(secret.prefix);
			while (start !== -1) {
				let length = MIN_TYPED_PREFIX_LENGTH;
				while (
					length < secret.value.length &&
					start + length < plain.length &&
					plain.charCodeAt(start + length) === secret.value.charCodeAt(length)
				) {
					length++;
				}
				spans.push(start, start + length);
				start = plain.indexOf(secret.prefix, start + 1);
			}
		}

		if (spans.length === 0) return row;

		for (let index = 2; index < spans.length; index += 2) {
			const start = spans[index];
			const end = spans[index + 1];
			let cursor = index;
			while (cursor > 0 && spans[cursor - 2] > start) {
				spans[cursor] = spans[cursor - 2];
				spans[cursor + 1] = spans[cursor - 1];
				cursor -= 2;
			}
			spans[cursor] = start;
			spans[cursor + 1] = end;
		}

		let mergedLength = 0;
		for (let index = 0; index < spans.length; index += 2) {
			const start = spans[index];
			const end = spans[index + 1];
			if (mergedLength > 0 && start < spans[mergedLength - 1]) {
				spans[mergedLength - 1] = Math.max(spans[mergedLength - 1], end);
				continue;
			}
			spans[mergedLength++] = start;
			spans[mergedLength++] = end;
		}

		let output = "";
		let cursor = 0;
		for (let index = 0; index < mergedLength; index += 2) {
			output += plain.slice(cursor, spans[index]);
			output += REDACTION;
			cursor = spans[index + 1];
		}
		return output + plain.slice(cursor);
	}
}
