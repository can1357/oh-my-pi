import * as fs from "node:fs/promises";
import * as path from "node:path";

import { RpcClient } from "@oh-my-pi/pi-coding-agent/modes/rpc/rpc-client";

import { installAgent } from "./agent";
import type { AgentBinaries, GatewayConfig, TbTask, TrialResult, TrialUsage, VmonConfig } from "./types";
import { TrialVm } from "./vmon";

const EMPTY_USAGE: TrialUsage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	costUsd: 0,
	turns: 0,
};

const TERMINAL_BENCH_TOOLS = "bash,read,write,edit,grep,glob";

function elapsedMs(startedAt: number): number {
	return Math.round(performance.now() - startedAt);
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

async function ensureHostDir(dir: string): Promise<void> {
	await fs.mkdir(dir, { recursive: true });
}

async function writeArtifact(dir: string, name: string, content: string): Promise<void> {
	await Bun.write(path.join(dir, name), content);
}

function modelParts(value: string): { provider: string; model: string } {
	const slash = value.indexOf("/");
	if (slash <= 0 || slash === value.length - 1) throw new Error(`Model must be provider/model, got ${value}`);
	return { provider: value.slice(0, slash), model: value.slice(slash + 1) };
}

/** Run one Terminal-Bench task inside a fresh Vibemon microVM. */
export async function runTrial(opts: {
	task: TbTask;
	model: string;
	binaries: AgentBinaries;
	gateway: GatewayConfig;
	vmon: VmonConfig;
	trialDir: string;
	log?: (line: string) => void;
}): Promise<TrialResult> {
	const wallStartedAt = performance.now();
	const deadlineMs = (opts.task.agentTimeoutSec + opts.task.verifierTimeoutSec + 900) * 1_000;
	let vm: TrialVm | null = null;
	let client: RpcClient | null = null;
	let deadlineExpired = false;
	let usage: TrialUsage = { ...EMPTY_USAGE };
	let finalMessage = "";
	let agentMs = 0;
	let verifierMs = 0;
	let agentTimedOut = false;

	const deadline = setTimeout(() => {
		deadlineExpired = true;
		void client?.stop().catch(() => {});
		void vm?.rm();
	}, deadlineMs);
	deadline.unref();

	const checkDeadline = () => {
		if (deadlineExpired || performance.now() - wallStartedAt >= deadlineMs) {
			deadlineExpired = true;
			throw new Error(`Overall trial deadline exceeded (${Math.round(deadlineMs / 1000)}s)`);
		}
	};
	const beforeDeadline = <T>(operation: Promise<T>): Promise<T> =>
		Promise.race([
			operation,
			new Promise<T>((_, reject) => {
				const remainingMs = deadlineMs - (performance.now() - wallStartedAt);
				if (remainingMs <= 0) {
					reject(new Error(`Overall trial deadline exceeded (${Math.round(deadlineMs / 1000)}s)`));
					return;
				}
				const timer = setTimeout(
					() => reject(new Error(`Overall trial deadline exceeded (${Math.round(deadlineMs / 1000)}s)`)),
					remainingMs,
				);
				timer.unref();
				void operation.finally(() => clearTimeout(timer)).catch(() => {});
			}),
		]);

	try {
		await ensureHostDir(opts.trialDir);
		const suffix = crypto.randomUUID().replaceAll("-", "").slice(0, 6);
		const vmName = `tb-${opts.task.name}-${suffix}`;
		opts.log?.(`boot ${vmName} from ${opts.task.image}`);
		vm = await beforeDeadline(
			TrialVm.start({
				config: opts.vmon,
				image: opts.task.image,
				name: vmName,
				cpus: opts.task.cpus,
				memoryMb: opts.task.memoryMb,
				storageMb: opts.task.storageMb,
				timeoutSec: Math.ceil(deadlineMs / 1_000),
				env: opts.task.environmentEnv,
			}),
		);
		checkDeadline();

		opts.log?.("connect gateway");
		const gatewayUrl = await beforeDeadline(vm.startGateway(opts.gateway.url));
		opts.log?.("install agent");
		const entrypoint = await beforeDeadline(installAgent(vm, opts.binaries, { ...opts.gateway, url: gatewayUrl }));
		const logDirs = await vm.exec("mkdir -p /logs/agent /logs/verifier");
		if (logDirs.exitCode !== 0) throw new Error(`Could not create log directories: ${logDirs.stderr.trim()}`);
		checkDeadline();

		const { provider, model } = modelParts(opts.model);
		client = new RpcClient({
			spawn: vm.rpcTransport(entrypoint, opts.task.agentTimeoutSec + 30),
			provider,
			model,
			args: ["--no-session", "--auto-approve", "--tools", TERMINAL_BENCH_TOOLS],
		});
		let turns = 0;
		const unsubscribe = client.onEvent(event => {
			if (event.type === "turn_start") turns++;
		});
		let agentCollectionError: string | null = null;
		const agentStartedAt = performance.now();
		try {
			await client.start();
			opts.log?.("prompt");
			// Subscribe to agent_end before prompting: a fast turn could otherwise
			// emit agent_end between the prompt response and the idle subscription.
			const idle = client.waitForIdle(opts.task.agentTimeoutSec * 1000);
			idle.catch(() => {});
			await client.prompt(opts.task.instruction);
			try {
				await idle;
				opts.log?.("idle");
			} catch (error) {
				if (!errorMessage(error).startsWith("Timeout waiting for agent to become idle.")) throw error;
				agentTimedOut = true;
				opts.log?.("agent timeout");
				await client.abort().catch(() => {});
				await client.waitForIdle(5_000).catch(() => {});
			}
		} catch (error) {
			agentCollectionError = errorMessage(error);
		} finally {
			agentMs = elapsedMs(agentStartedAt);
		}

		try {
			const stats = await client.getSessionStats();
			usage = {
				input: stats.tokens.input,
				output: stats.tokens.output,
				cacheRead: stats.tokens.cacheRead,
				cacheWrite: stats.tokens.cacheWrite,
				costUsd: stats.cost,
				turns,
			};
		} catch (error) {
			agentCollectionError ??= errorMessage(error);
			usage.turns = turns;
		}
		try {
			finalMessage = (await client.getLastAssistantText()) ?? "";
		} catch (error) {
			agentCollectionError ??= errorMessage(error);
		}
		let transcript = "[]\n";
		try {
			const messages = await client.getMessages();
			transcript = `${JSON.stringify(messages, null, 2)}\n`;
		} catch (error) {
			agentCollectionError ??= errorMessage(error);
		}
		await writeArtifact(opts.trialDir, "transcript.json", transcript);
		unsubscribe();
		await client.stop().catch(() => {});
		client = null;
		checkDeadline();

		opts.log?.("verify");
		// Docker's default capability set denies CAP_SYS_TIME, but root inside a
		// microVM can change its clock. Restore host UTC before verification so
		// agent certificate workarounds cannot poison verifier networking.
		const hostEpoch = Math.floor(Date.now() / 1_000);
		await vm.exec(`date -u -s @${hostEpoch} >/dev/null 2>&1 || true`, { timeoutSec: 10 });
		const verifierStartedAt = performance.now();
		let verifierExitCode: number | null = null;
		let verifierFailure: string | null = null;
		try {
			await vm.copyDirectory(path.join(opts.task.dir, "tests"), "/tests");
			const script = await vm.exec("test -f /tests/test.sh");
			if (script.exitCode !== 0) throw new Error("Verifier script /tests/test.sh is missing");
			const chmod = await vm.exec("chmod +x /tests/test.sh");
			if (chmod.exitCode !== 0) throw new Error(`Could not make verifier executable: ${chmod.stderr.trim()}`);
			const verifier = await vm.exec("bash /tests/test.sh > /logs/verifier/test-stdout.txt 2>&1", {
				timeoutSec: opts.task.verifierTimeoutSec,
				env: opts.task.verifierEnv,
				cwd: vm.workdir,
			});
			verifierExitCode = verifier.exitCode;
		} catch (error) {
			verifierFailure = errorMessage(error);
		} finally {
			verifierMs = elapsedMs(verifierStartedAt);
		}
		checkDeadline();

		const rewardText = await vm.readFile("/logs/verifier/reward.txt");
		const parsedReward = rewardText === null ? Number.NaN : Number.parseFloat(rewardText.trim());
		const reward = Number.isFinite(parsedReward) && parsedReward >= 0 && parsedReward <= 1 ? parsedReward : null;
		const verifierOutput = (await vm.readFile("/logs/verifier/test-stdout.txt")) ?? "";
		await writeArtifact(opts.trialDir, "test-stdout.txt", verifierOutput);
		const ctrf = await vm.readFile("/logs/verifier/ctrf.json");
		if (ctrf !== null) await writeArtifact(opts.trialDir, "ctrf.json", ctrf);
		opts.log?.(`reward ${reward === null ? "missing" : reward}`);
		// The agent never completed a single turn: a harness/transport failure,
		// not a model failure. Reporting it as "fail" would pollute pass rates.
		if (agentCollectionError !== null && turns === 0) {
			return {
				status: "error",
				reward,
				agentTimedOut,
				usage,
				finalMessage,
				agentMs,
				verifierMs,
				wallMs: elapsedMs(wallStartedAt),
				error: `Agent run failed before any turn: ${agentCollectionError}`,
			};
		}

		if (reward === null) {
			const details = [
				verifierFailure,
				verifierExitCode === null ? null : `Verifier exit code: ${verifierExitCode}`,
				verifierOutput.length > 0 ? `Verifier output tail:\n${verifierOutput.slice(-4_000)}` : null,
				agentCollectionError ? `Agent RPC error: ${agentCollectionError}` : null,
			].filter((value): value is string => value !== null);
			return {
				status: "error",
				reward: null,
				agentTimedOut,
				usage,
				finalMessage,
				agentMs,
				verifierMs,
				wallMs: elapsedMs(wallStartedAt),
				error: details.join("\n") || "Verifier produced no reward",
			};
		}

		return {
			status: reward >= 1 ? "pass" : "fail",
			reward,
			agentTimedOut,
			usage,
			finalMessage,
			agentMs,
			verifierMs,
			wallMs: elapsedMs(wallStartedAt),
		};
	} catch (error) {
		return {
			status: "error",
			reward: null,
			agentTimedOut,
			usage,
			finalMessage,
			agentMs,
			verifierMs,
			wallMs: elapsedMs(wallStartedAt),
			error: errorMessage(error),
		};
	} finally {
		clearTimeout(deadline);
		await client?.stop().catch(() => {});
		await vm?.rm();
	}
}
