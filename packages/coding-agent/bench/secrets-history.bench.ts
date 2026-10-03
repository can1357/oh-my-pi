#!/usr/bin/env bun
/**
 * Synthetic inputs only; no credentials, network or session files.
 * Run: bun packages/coding-agent/bench/secrets-history.bench.ts
 */
import assert from "node:assert/strict";
import type { Message } from "@oh-my-pi/pi-ai";
import { builtinCredentialSecretEntries } from "../src/secrets";
import { obfuscateMessages, obfuscateProviderContext } from "../src/secrets/message-transform";
import { type SecretEntry, SecretObfuscator } from "../src/secrets/obfuscator";

const KEY = "synthetic-history-benchmark-key";
const PLAIN = "SYNTHETIC_PLAIN_SECRET_7_ABCDEFGHIJK";
const CUSTOM = "synthetic_token_7_abcdef123456";
const AWS = `AKIA${"A".repeat(16)}`;
const RETAINED = "retained-history-";

export function runSecretsHistoryBenchmark() {
	const entries: SecretEntry[] = [
		...builtinCredentialSecretEntries(),
		...Array.from({ length: 32 }, (_, index): SecretEntry => ({
			type: "plain",
			content: `SYNTHETIC_PLAIN_SECRET_${index}_ABCDEFGHIJK`,
			friendlyName: index === 7 ? "SYNTHETICTOKEN7ABCDEF123456" : `SyntheticPlain${index}`,
		})),
		...Array.from({ length: 24 }, (_, index): SecretEntry => ({
			type: "regex",
			content: `synthetic_token_${index}_[a-f0-9]{12}`,
			literalPrefixes: index < 16 ? [`synthetic_token_${index}_`] : undefined,
		})),
	];
	const obfuscator = new SecretObfuscator(entries, KEY);
	const history: Message[] = Array.from({ length: 400 }, (_, index) => ({
		role: "user",
		content:
			`${RETAINED}${index}\n${"ordinary synthetic context without credentials; ".repeat(40)}\n` +
			(index % 7 === 0 ? `${PLAIN} ` : "") +
			(index % 13 === 0 ? `${CUSTOM} ` : "") +
			(index % 29 === 0 ? AWS : ""),
		timestamp: index,
	}));
	const regexSources = new Set(
		entries.filter(entry => entry.type === "regex").map(entry => new RegExp(entry.content).source),
	);
	const probes = new Set(
		entries.flatMap(entry => entry.literalPrefixes ?? []).flatMap(probe => [probe, probe.toLowerCase()]),
	);
	const originalExec = RegExp.prototype.exec;
	const originalIncludes = String.prototype.includes;
	let regexExecutions = 0;
	let retainedRegexExecutions = 0;
	let literalProbes = 0;
	RegExp.prototype.exec = function (text: string) {
		if (regexSources.has(this.source)) {
			regexExecutions++;
			if (originalIncludes.call(text, RETAINED)) retainedRegexExecutions++;
		}
		return originalExec.call(this, text);
	};
	String.prototype.includes = function (search: string, position?: number) {
		if (probes.has(search)) literalProbes++;
		return originalIncludes.call(this, search, position);
	};
	const phases: Array<{
		name: string;
		wallMs: number;
		cpuMs: number;
		regexExecutions: number;
		retainedRegexExecutions: number;
		literalProbes: number;
	}> = [];
	try {
		const run = (name: string, messages: Message[]) => {
			regexExecutions = 0;
			retainedRegexExecutions = 0;
			literalProbes = 0;
			const cpuStart = process.cpuUsage();
			const wallStart = performance.now();
			// The real SDK safety boundaries: transcript conversion, then provider context.
			const converted = obfuscateMessages(
				obfuscator,
				messages.map(message => ({ ...message })),
			);
			const context = obfuscateProviderContext(obfuscator, { messages: converted.map(message => ({ ...message })) });
			const cpu = process.cpuUsage(cpuStart);
			phases.push({
				name,
				wallMs: performance.now() - wallStart,
				cpuMs: (cpu.user + cpu.system) / 1000,
				regexExecutions,
				retainedRegexExecutions,
				literalProbes,
			});
			const serialized = JSON.stringify(context.messages);
			for (const secret of [PLAIN, CUSTOM, AWS]) assert(!originalIncludes.call(serialized, secret));
			assert(!originalIncludes.call(serialized, "SYNTHETICTOKEN7ABCDEF123456_"));
			for (let index = 0; index < messages.length; index++) {
				const input = messages[index]!;
				const output = context.messages[index]!;
				assert(input.role === "user" && typeof input.content === "string");
				assert(output.role === "user" && typeof output.content === "string");
				assert.equal(obfuscator.deobfuscate(output.content), input.content);
			}
			return serialized;
		};
		const expected = run("cold", history);
		assert.equal(run("settle-1", history), expected);
		assert.equal(run("settle-2", history), expected);
		for (let turn = 0; turn < 4; turn++) {
			assert.equal(run(`warm-${turn}`, history), expected);
			assert.equal(phases.at(-1)!.retainedRegexExecutions, 0);
		}
		const appended: Message[] = [
			...history,
			{ role: "user", content: "new harmless synthetic context", timestamp: 1000 },
		];
		run("append-harmless", appended);
		assert.equal(phases.at(-1)!.retainedRegexExecutions, 0);
		const changed: Message[] = [
			...history,
			{ role: "user", content: "new synthetic_token_7_111111111111", timestamp: 1001 },
		];
		const changedOutput = run("append-secret", changed);
		assert(!originalIncludes.call(changedOutput, "synthetic_token_7_111111111111"));
		return {
			messages: history.length,
			inputCharacters: history.reduce(
				(count, message) => count + (typeof message.content === "string" ? message.content.length : 0),
				0,
			),
			phases,
		};
	} finally {
		RegExp.prototype.exec = originalExec;
		String.prototype.includes = originalIncludes;
	}
}

if (import.meta.main) {
	console.log(JSON.stringify(runSecretsHistoryBenchmark(), null, 2));
}
