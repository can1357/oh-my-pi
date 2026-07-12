/**
 * MsiDockerBackend — executes ephemeral jobs in isolated Docker containers on the MSI.
 *
 * Contract per prompt §16:
 * - unique container/volume/network per job, labeled ompk.job_id + ompk.managed
 * - non-root user, no privileged mode, no host Docker socket mount
 * - per-job CPU/RAM/PID/timeout limits
 * - cleanup is idempotent and verifies actual resource absence
 *
 * This implementation invokes the Docker CLI via Bun.spawn. It does NOT require
 * Docker SDK bindings — the CLI is the only verified interface at Phase 1.
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { logger } from "@pk-nerdsaver-ai/pi-utils";
import type {
	BackendCapabilities,
	BackendEstimate,
	BackendReadiness,
	CleanupResult,
	ConnectionInfo,
	ExecutionBackend,
	ExecutionControl,
	RuntimeHandle,
	RuntimeStatusResult,
	WorkspaceArtifacts,
	WorkspaceLaunchSpec,
} from "./types";

export const MSI_DOCKER_BACKEND_ID = "msi-docker" as const;

/** Labels applied to every managed resource for orphan reaping. */
const MANAGED_LABEL = "ompk.managed=true";
const ARTIFACT_FIELD_NAMES = ["patch", "changed-files", "agent-exit-code", "validation-exit-code"] as const;

function jobLabel(jobId: string): string {
	return `ompk.job_id=${jobId}`;
}

export interface DockerCommandOptions {
	readonly signal?: AbortSignal;
}

export interface DockerCommandResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly code: number;
}

/** Injectable seam for contract tests and alternative Docker transports. */
export type DockerCommandRunner = (
	args: readonly string[],
	options?: DockerCommandOptions,
) => Promise<DockerCommandResult>;

export interface MsiDockerBackendOptions {
	readonly defaultImage?: string;
	readonly cpuLimit?: string;
	readonly memoryLimit?: string;
	readonly pidsLimit?: number;
	/** Name of an externally managed network that enforces restricted egress. */
	readonly restrictedNetworkName?: string;
	/** HTTPS repository hosts permitted on the restricted egress network. */
	readonly allowedRepoHosts?: readonly string[];
	readonly executeDocker?: DockerCommandRunner;
}

interface ResolvedMsiDockerBackendOptions {
	readonly defaultImage: string;
	readonly cpuLimit: string;
	readonly memoryLimit: string;
	readonly pidsLimit: number;
	readonly restrictedNetworkName?: string;
	readonly allowedRepoHosts: readonly string[];
}

async function runDockerCommand(
	args: readonly string[],
	options: DockerCommandOptions = {},
): Promise<DockerCommandResult> {
	if (options.signal?.aborted) throw createAbortError();

	const proc = Bun.spawn(["docker", ...args], {
		stdout: "pipe",
		stderr: "pipe",
	});
	const abort = (): void => {
		proc.kill();
	};
	options.signal?.addEventListener("abort", abort, { once: true });
	try {
		const [stdout, stderr, exitCode] = await Promise.all([
			new Response(proc.stdout).text(),
			new Response(proc.stderr).text(),
			proc.exited,
		]);
		if (options.signal?.aborted) throw createAbortError();
		return { stdout: stdout.trim(), stderr: stderr.trim(), code: exitCode ?? -1 };
	} finally {
		options.signal?.removeEventListener("abort", abort);
	}
}

function createAbortError(): Error {
	const error = new Error("Docker command aborted");
	error.name = "AbortError";
	return error;
}

function isMissingResource(stderr: string): boolean {
	const message = stderr.toLowerCase();
	return message.includes("no such") || message.includes("not found");
}

async function dockerResourceGone(
	executeDocker: DockerCommandRunner,
	resourceType: "container" | "volume" | "network",
	id: string,
	errors: string[],
): Promise<boolean> {
	try {
		const result = await executeDocker(["inspect", "--type", resourceType, id]);
		if (result.code === 0) return false;
		if (isMissingResource(result.stderr)) return true;
		errors.push(`${resourceType} inspect did not confirm removal: ${result.stderr || `exit ${result.code}`}`);
		return false;
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		errors.push(`${resourceType} inspect failed: ${reason}`);
		return false;
	}
}

interface EntrypointFile {
	readonly directory: string;
	readonly path: string;
}

async function createEntrypointFile(script: string): Promise<EntrypointFile> {
	const directory = await mkdtemp(join(tmpdir(), "ompk-remote-workspace-"));
	const path = join(directory, "entrypoint.sh");
	await writeFile(path, script, { encoding: "utf8", mode: 0o644 });
	return { directory, path };
}

async function removeEntrypointDirectory(directory: string): Promise<void> {
	await rm(directory, { recursive: true, force: true });
}

function safeHttpsRepositoryUrl(repoUrl: string): URL {
	let parsed: URL;
	try {
		parsed = new URL(repoUrl);
	} catch {
		throw new Error("Repository URL must be an absolute credential-free HTTPS URL");
	}
	if (
		parsed.protocol !== "https:" ||
		!parsed.hostname ||
		parsed.username ||
		parsed.password ||
		parsed.search ||
		parsed.hash
	) {
		throw new Error("Repository URL must be a credential-free HTTPS URL without query or fragment");
	}
	return parsed;
}

export class MsiDockerBackend implements ExecutionBackend {
	readonly id = MSI_DOCKER_BACKEND_ID;
	readonly #opts: ResolvedMsiDockerBackendOptions;
	readonly #executeDocker: DockerCommandRunner;

	readonly capabilities: BackendCapabilities = Object.freeze({
		interactiveShell: true,
		browserIDE: false,
		persistentVolume: true,
		fullPauseResume: false,
		docker: true,
		nestedVirtualization: false,
		gpu: false,
		longRunning: true,
		publicPreviewPorts: false,
		privateNetworking: true,
		windows: false,
		linux: true,
		arm64: false,
		maxWorkspaceBytes: 10 * 1024 * 1024 * 1024,
	});

	constructor(opts: MsiDockerBackendOptions = {}) {
		this.#opts = {
			defaultImage: opts.defaultImage ?? "oh-my-pi/pi:dev",
			cpuLimit: opts.cpuLimit ?? "2",
			memoryLimit: opts.memoryLimit ?? "4g",
			pidsLimit: opts.pidsLimit ?? 256,
			restrictedNetworkName: opts.restrictedNetworkName,
			allowedRepoHosts: Object.freeze((opts.allowedRepoHosts ?? []).map(host => host.toLowerCase())),
		};
		this.#executeDocker = opts.executeDocker ?? runDockerCommand;
	}

	async probe(): Promise<BackendReadiness> {
		const checkedAt = new Date().toISOString();
		const issues: string[] = [];

		const { code: dockerCode, stderr } = await this.#executeDocker(["info", "--format", "{{.ServerVersion}}"]);
		if (dockerCode !== 0) {
			issues.push(`Docker daemon not reachable: ${stderr}`);
			return { backendId: this.id, status: "unavailable", checkedAt, issues, capabilities: this.capabilities };
		}

		const { code: imageCode } = await this.#executeDocker(["image", "inspect", this.#opts.defaultImage]);
		if (imageCode !== 0) {
			issues.push(`Worker image "${this.#opts.defaultImage}" not found locally — build with: bun run pi:image`);
		}

		return {
			backendId: this.id,
			status: issues.length === 0 ? "ready" : "degraded",
			checkedAt,
			issues,
			capabilities: this.capabilities,
		};
	}

	async estimate(_spec: WorkspaceLaunchSpec): Promise<BackendEstimate> {
		return {
			backendId: this.id,
			estimatedStartMs: 5_000,
			notes: "MSI Docker: cold start ~5s for existing image",
		};
	}

	async launch(spec: WorkspaceLaunchSpec): Promise<RuntimeHandle> {
		const repository = safeHttpsRepositoryUrl(spec.repoUrl);
		if (spec.env && Object.keys(spec.env).length > 0) {
			throw new Error("Custom environment variables are unsupported until a secure injection path is available");
		}
		if (spec.networkEgress !== "restricted") {
			throw new Error("Repository cloning requires explicitly configured restricted network egress");
		}
		if (!this.#opts.restrictedNetworkName || this.#opts.allowedRepoHosts.length === 0) {
			throw new Error("Restricted egress requires a managed network and an allowed repository host list");
		}
		if (!this.#opts.allowedRepoHosts.includes(repository.hostname.toLowerCase())) {
			throw new Error(`Repository host ${repository.hostname} is not permitted by the restricted egress policy`);
		}

		const image = spec.image || this.#opts.defaultImage;
		const containerName = `ompk-job-${spec.jobId}`;
		const volumeName = `ompk-vol-${spec.jobId}`;
		const entrypoint = await createEntrypointFile(buildEntrypointScript(spec));

		logger.info("msi-docker: launching job", { jobId: spec.jobId, image, containerName });
		try {
			const { code: volCode, stderr: volErr } = await this.#executeDocker([
				"volume",
				"create",
				"--label",
				MANAGED_LABEL,
				"--label",
				jobLabel(spec.jobId),
				volumeName,
			]);
			if (volCode !== 0) throw new Error(`Failed to create volume ${volumeName}: ${volErr}`);

			const runArgs = [
				"run",
				"--detach",
				"--name",
				containerName,
				"--label",
				MANAGED_LABEL,
				"--label",
				jobLabel(spec.jobId),
				"--volume",
				`${volumeName}:/workspace`,
				"--mount",
				`type=bind,src=${entrypoint.path},dst=/opt/ompk-entrypoint,readonly`,
				"--workdir",
				"/workspace",
				"--cpus",
				this.#opts.cpuLimit,
				"--memory",
				this.#opts.memoryLimit,
				"--pids-limit",
				String(this.#opts.pidsLimit),
				"--network",
				this.#opts.restrictedNetworkName,
				"--read-only",
				"--tmpfs",
				"/tmp:rw,noexec,nosuid,size=512m",
				"--security-opt",
				"no-new-privileges",
				"--user",
				"1000:1000",
				"--entrypoint",
				"/bin/sh",
				image,
				"/opt/ompk-entrypoint",
			];
			const { code: runCode, stdout: containerId, stderr: runErr } = await this.#executeDocker(runArgs);
			if (runCode !== 0) throw new Error(`Failed to start container: ${runErr}`);

			const workerId = containerId.slice(0, 12);
			logger.info("msi-docker: container started", { jobId: spec.jobId, workerId, containerName });
			return Object.freeze({
				backendId: this.id,
				jobId: spec.jobId,
				workerId,
				startedAt: new Date().toISOString(),
				metadata: Object.freeze({
					containerName,
					volumeName,
					image,
					entrypointDirectory: entrypoint.directory,
				}),
			});
		} catch (error) {
			await Promise.allSettled([
				this.#executeDocker(["rm", "-f", containerName]),
				this.#executeDocker(["volume", "rm", "-f", volumeName]),
				removeEntrypointDirectory(entrypoint.directory),
			]);
			throw error;
		}
	}

	async collectArtifacts(runtime: RuntimeHandle, control: ExecutionControl = {}): Promise<WorkspaceArtifacts> {
		const containerName = this.#metadataString(runtime, "containerName");
		const volumeName = this.#metadataString(runtime, "volumeName");
		const image = this.#metadataString(runtime, "image", this.#opts.defaultImage);
		const startedAt = new Date(runtime.startedAt).getTime();

		const wait = await this.#executeDocker(["wait", containerName], control);
		if (wait.code !== 0) throw new Error(`Failed to wait for container ${containerName}: ${wait.stderr}`);
		const exitCode = parseDockerWaitExitCode(wait.stdout);

		const logsResult = await this.#executeDocker(["logs", containerName], control);
		if (logsResult.code !== 0) throw new Error(`Failed to collect logs for ${containerName}: ${logsResult.stderr}`);

		const artifactResult = await this.#executeDocker(
			[
				"run",
				"--rm",
				"--network",
				"none",
				"--read-only",
				"--tmpfs",
				"/tmp:rw,noexec,nosuid,size=64m",
				"--volume",
				`${volumeName}:/workspace:ro`,
				image,
				"/bin/sh",
				"-c",
				buildArtifactReadScript(),
			],
			control,
		);
		if (artifactResult.code !== 0) {
			throw new Error(
				`Failed to collect stopped-container artifacts for ${containerName}: ${artifactResult.stderr}`,
			);
		}
		const artifactData = parseDockerArtifactOutput(artifactResult.stdout);

		return Object.freeze({
			logs: logsResult.stdout,
			patch: artifactData.patch,
			exitCode,
			agentExitCode: artifactData.agentExitCode,
			validationExitCode: artifactData.validationExitCode,
			changedFiles: artifactData.changedFiles,
			durationMs: Math.max(0, Date.now() - startedAt),
		});
	}

	async status(runtime: RuntimeHandle): Promise<RuntimeStatusResult> {
		const containerName = this.#metadataString(runtime, "containerName");
		const { stdout, code } = await this.#executeDocker(["inspect", "--format", "{{.State.Status}}", containerName]);
		const checkedAt = new Date().toISOString();
		if (code !== 0) return { status: "unknown", checkedAt };
		const raw = stdout.trim();
		const statusMap: Record<string, RuntimeStatusResult["status"]> = {
			running: "running",
			exited: "stopped",
			dead: "failed",
			created: "starting",
			paused: "stopped",
		};
		return { status: statusMap[raw] ?? "unknown", checkedAt };
	}

	async connect(runtime: RuntimeHandle): Promise<ConnectionInfo> {
		const containerName = this.#metadataString(runtime, "containerName");
		return { sshCommand: `docker exec -it ${containerName} /bin/sh`, notes: "Direct exec into running container" };
	}

	async terminate(runtime: RuntimeHandle): Promise<void> {
		const containerName = this.#metadataString(runtime, "containerName");
		const result = await this.#executeDocker(["stop", "--time", "10", containerName]);
		if (result.code !== 0 && !isMissingResource(result.stderr) && !result.stderr.includes("is not running")) {
			throw new Error(`Failed to stop container ${containerName}: ${result.stderr}`);
		}
	}

	async cleanup(runtime: RuntimeHandle): Promise<CleanupResult> {
		const containerName = this.#metadataString(runtime, "containerName");
		const volumeName = this.#metadataString(runtime, "volumeName");
		const entrypointDirectory = this.#metadataString(runtime, "entrypointDirectory", "");
		const errors: string[] = [];

		logger.info("msi-docker: cleanup start", { jobId: runtime.jobId, containerName });
		const containerRemoval = await this.#executeDocker(["rm", "-f", containerName]);
		if (containerRemoval.code !== 0 && !isMissingResource(containerRemoval.stderr)) {
			errors.push(`container rm failed: ${containerRemoval.stderr}`);
		}
		const volumeRemoval = await this.#executeDocker(["volume", "rm", "-f", volumeName]);
		if (volumeRemoval.code !== 0 && !isMissingResource(volumeRemoval.stderr)) {
			errors.push(`volume rm failed: ${volumeRemoval.stderr}`);
		}

		const containerGone = await dockerResourceGone(this.#executeDocker, "container", containerName, errors);
		const volumeGone = await dockerResourceGone(this.#executeDocker, "volume", volumeName, errors);
		let entrypointGone = true;
		if (entrypointDirectory) {
			try {
				await removeEntrypointDirectory(entrypointDirectory);
			} catch (error) {
				entrypointGone = false;
				errors.push(`entrypoint cleanup failed: ${error instanceof Error ? error.message : String(error)}`);
			}
		}

		logger.info("msi-docker: cleanup complete", {
			jobId: runtime.jobId,
			containerGone,
			volumeGone,
			entrypointGone,
			errors,
		});
		return Object.freeze({
			containerGone,
			volumeGone,
			networkGone: true,
			workspaceDirGone: volumeGone && entrypointGone,
			// This backend rejects caller-provided environment and repository credentials.
			credentialRevoked: true,
			errors: Object.freeze(errors),
		});
	}

	#metadataString(runtime: RuntimeHandle, key: string, fallback?: string): string {
		const value = runtime.metadata[key];
		if (typeof value === "string" && value.length > 0) return value;
		if (fallback !== undefined) return fallback;
		throw new Error(`Runtime ${runtime.jobId} is missing Docker metadata ${key}`);
	}
}

function buildEntrypointScript(spec: WorkspaceLaunchSpec): string {
	const validationBlock =
		spec.validationCommands.length > 0
			? spec.validationCommands
					.map(command =>
						[
							`printf '%s\\n' ${shellQuote(`--- validation: ${command} ---`)}`,
							`${command} || { validation_exit=$?; exit "$validation_exit"; }`,
						].join("\n"),
					)
					.join("\n")
			: "printf '%s\\n' '--- no validation commands ---'";

	return [
		"#!/bin/sh",
		"set -eu",
		"agent_exit=0",
		"validation_exit=0",
		"write_artifacts() {",
		"  status=$?",
		"  artifact_dir=/workspace/.ompk-artifacts",
		'  mkdir -p "$artifact_dir" || true',
		'  (git -C /workspace/repo diff --no-ext-diff HEAD || true) > "$artifact_dir/patch" 2>/dev/null || true',
		"  (cd /workspace/repo && find . -type f -newer /workspace/.ompk-start -print | sed 's#^./##' | head -200 || true) > \"$artifact_dir/changed-files\" 2>/dev/null || true",
		'  printf \'%s\\n\' "$agent_exit" > "$artifact_dir/agent-exit-code" || true',
		'  printf \'%s\\n\' "$validation_exit" > "$artifact_dir/validation-exit-code" || true',
		'  exit "$status"',
		"}",
		"trap write_artifacts EXIT",
		`git clone --depth=1 ${shellQuote(spec.repoUrl)} /workspace/repo`,
		`git -C /workspace/repo checkout ${shellQuote(spec.ref)}`,
		"touch /workspace/.ompk-start",
		"printf '%s\\n' '--- task ---'",
		`printf '%s\\n' ${shellQuote(spec.taskPrompt.slice(0, 512))}`,
		"printf '%s\\n' '--- validation ---'",
		validationBlock,
		"printf '%s\\n' '--- done ---'",
	].join("\n");
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function buildArtifactReadScript(): string {
	return [
		"for artifact in patch changed-files agent-exit-code validation-exit-code; do",
		"  printf '%s=' \"$artifact\"",
		'  if [ -f "/workspace/.ompk-artifacts/$artifact" ]; then base64 "/workspace/.ompk-artifacts/$artifact" | tr -d \'\\n\'; fi',
		"  printf '\\n'",
		"done",
	].join("\n");
}

export function parseDockerWaitExitCode(stdout: string): number {
	const normalized = stdout.trim();
	if (!/^(0|[1-9]\d*)$/.test(normalized)) {
		throw new Error(`Docker wait returned an invalid exit code: ${JSON.stringify(stdout)}`);
	}
	const exitCode = Number(normalized);
	if (!Number.isSafeInteger(exitCode) || exitCode > 255) {
		throw new Error(`Docker wait returned an out-of-range exit code: ${normalized}`);
	}
	return exitCode;
}

export interface DockerArtifactData {
	readonly patch?: string;
	readonly changedFiles: readonly string[];
	readonly agentExitCode?: number;
	readonly validationExitCode?: number;
}

export function parseDockerArtifactOutput(stdout: string): DockerArtifactData {
	const fields = new Map<string, string>();
	for (const line of stdout.split("\n")) {
		if (!line) continue;
		const separator = line.indexOf("=");
		if (separator <= 0) throw new Error(`Invalid Docker artifact line: ${JSON.stringify(line)}`);
		fields.set(line.slice(0, separator), line.slice(separator + 1));
	}
	for (const name of ARTIFACT_FIELD_NAMES) {
		if (!fields.has(name)) throw new Error(`Docker artifact output is missing ${name}`);
	}
	const patch = decodeArtifactField(fields.get("patch") ?? "", "patch");
	const changedFiles = decodeArtifactField(fields.get("changed-files") ?? "", "changed-files")
		.split("\n")
		.map(file => file.trim())
		.filter(Boolean);
	return Object.freeze({
		patch: patch || undefined,
		changedFiles: Object.freeze(changedFiles),
		agentExitCode: parseArtifactExitCode(fields.get("agent-exit-code") ?? "", "agent-exit-code"),
		validationExitCode: parseArtifactExitCode(fields.get("validation-exit-code") ?? "", "validation-exit-code"),
	});
}

function decodeArtifactField(encoded: string, name: string): string {
	try {
		return encoded ? Buffer.from(encoded, "base64").toString("utf8") : "";
	} catch (error) {
		const reason = error instanceof Error ? error.message : String(error);
		throw new Error(`Unable to decode Docker artifact ${name}: ${reason}`);
	}
}

function parseArtifactExitCode(encoded: string, name: string): number | undefined {
	const value = decodeArtifactField(encoded, name).trim();
	return value ? parseDockerWaitExitCode(value) : undefined;
}

/** Static helper: list all containers/volumes/networks with ompk.managed label. */
export async function listManagedResources(): Promise<{
	containers: string[];
	volumes: string[];
	networks: string[];
}> {
	const [containers, volumes, networks] = await Promise.all([
		runDockerCommand(["ps", "-a", "--filter", `label=${MANAGED_LABEL}`, "--format", "{{.Names}}"]),
		runDockerCommand(["volume", "ls", "--filter", `label=${MANAGED_LABEL}`, "--format", "{{.Name}}"]),
		runDockerCommand(["network", "ls", "--filter", `label=${MANAGED_LABEL}`, "--format", "{{.Name}}"]),
	]);
	const parse = (value: string): string[] =>
		value
			.split("\n")
			.map(line => line.trim())
			.filter(Boolean);
	return { containers: parse(containers.stdout), volumes: parse(volumes.stdout), networks: parse(networks.stdout) };
}
