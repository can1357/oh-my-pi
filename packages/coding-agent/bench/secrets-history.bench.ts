/**
 * Benchmark: outbound secret obfuscation over a long conversation history.
 *
 * Each "request" runs both SDK boundaries (transcript conversion, then provider
 * context) over the whole history, as every turn does. Inputs are synthetic.
 *
 * Run: bun packages/coding-agent/bench/secrets-history.bench.ts [messages...]
 */
import type { Message } from "@oh-my-pi/pi-ai";
import { builtinCredentialSecretEntries } from "../src/secrets";
import { obfuscateMessages, obfuscateProviderContext } from "../src/secrets/message-transform";
import { type SecretEntry, SecretObfuscator } from "../src/secrets/obfuscator";

const PLAIN = "SYNTHETIC_PLAIN_SECRET_7_ABCDEFGHIJK";
const AWS = `AKIA${"A".repeat(16)}`;
const ITERS = 5;

function buildEntries(): SecretEntry[] {
	return [
		...builtinCredentialSecretEntries(),
		...Array.from({ length: 32 }, (_, index): SecretEntry => ({
			type: "plain",
			content: `SYNTHETIC_PLAIN_SECRET_${index}_ABCDEFGHIJK`,
			friendlyName: `SyntheticPlain${index}`,
		})),
		...Array.from({ length: 24 }, (_, index): SecretEntry => ({
			type: "regex",
			content: `synthetic_token_${index}_[a-f0-9]{12}`,
			friendlyName: index % 2 === 0 ? `SyntheticToken${index}` : undefined,
			literalPrefixes: index < 16 ? [`synthetic_token_${index}_`] : undefined,
		})),
	];
}

function buildHistory(count: number): Message[] {
	return Array.from({ length: count }, (_, index): Message => {
		const body =
			`turn ${index}\n${"ordinary synthetic context without credentials; ".repeat(40)}\n` +
			(index % 7 === 0 ? `${PLAIN} ` : "") +
			(index % 13 === 0 ? `synthetic_token_${index % 24}_${index.toString(16).padStart(12, "0")} ` : "") +
			(index % 29 === 0 ? AWS : "");
		if (index % 3 === 1) {
			return {
				role: "assistant",
				content: [{ type: "text", text: body }],
				api: "openai-responses",
				provider: "openai",
				model: "synthetic",
				usage: {
					input: 0,
					output: 0,
					cacheRead: 0,
					cacheWrite: 0,
					totalTokens: 0,
					cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
				},
				stopReason: "stop",
				timestamp: index,
			};
		}
		return { role: "user", content: body, timestamp: index };
	});
}

function request(obfuscator: SecretObfuscator, history: Message[]): Message[] {
	const converted = obfuscateMessages(obfuscator, history);
	return obfuscateProviderContext(obfuscator, { messages: converted }).messages;
}

const sizes = process.argv.slice(2).map(Number);
for (const count of sizes.length > 0 ? sizes : [400, 1600]) {
	const obfuscator = new SecretObfuscator(buildEntries(), "synthetic-bench-key");
	const history = buildHistory(count);
	const characters = JSON.stringify(history).length;
	let start = Bun.nanoseconds();
	const output = JSON.stringify(request(obfuscator, history));
	const coldMs = (Bun.nanoseconds() - start) / 1e6;
	for (const secret of [PLAIN, AWS, "synthetic_token_0_000000000000"]) {
		if (output.includes(secret)) throw new Error(`leaked ${secret}`);
	}
	start = Bun.nanoseconds();
	for (let i = 0; i < ITERS; i++) request(obfuscator, history);
	const warmMs = (Bun.nanoseconds() - start) / 1e6 / ITERS;
	console.log(
		`${count} messages, ${(characters / 1024 / 1024).toFixed(2)} MiB: first request ${coldMs.toFixed(1)}ms, steady ${warmMs.toFixed(1)}ms/request`,
	);
}
