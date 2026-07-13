#!/usr/bin/env bun

/**
 * ompk-remote CLI — Phase 1 Docker jobs + environments-cloud (pkscloudenvs) handoff.
 *
 * Usage:
 *   ompk-remote doctor              check backend readiness
 *   ompk-remote run <repo> <ref>    submit + run a job to completion
 *   ompk-remote status [jobId]      show job(s) state
 *   ompk-remote cancel <jobId>      cancel a queued/running job
 *   ompk-remote list                list all jobs
 *   ompk-remote environments        resolve MSI environments-cloud (pkscloudenvs) routes
 *   ompk-remote environments skill <name>
 *   ompk-remote environments handoff <entrypoint> [args...]
 *   ompk-remote cloud               alias for environments
 */

import * as os from "node:os";
import * as path from "node:path";
import { MsiDockerBackend } from "./backend/msi-docker";
import {
	ENVIRONMENTS_CLOUD_ROOT_ENV,
	resolveEnvironmentsCloudSkill,
	resolveMeshHandoff,
	summarizeEnvironmentsCloudRoute,
} from "./environments-cloud";
import { RemoteWorkspaceOrchestrator } from "./orchestrator";

const DB_PATH = process.env.OMPK_REMOTE_DB ?? path.join(os.homedir(), ".omp", "remote-jobs.sqlite");

function makeOrchestrator(): RemoteWorkspaceOrchestrator {
	const backend = new MsiDockerBackend();
	return new RemoteWorkspaceOrchestrator({ dbPath: DB_PATH, backend });
}

const [, , cmd, ...args] = process.argv;

switch (cmd) {
	case "doctor":
		await runDoctor();
		break;
	case "run":
		await runJob(args);
		break;
	case "status":
		await runStatus(args[0]);
		break;
	case "cancel":
		await runCancel(args[0]);
		break;
	case "list":
		await runList();
		break;
	case "environments":
	case "cloud":
		await runEnvironments(args);
		break;
	default:
		printUsage();
		process.exit(0);
}

async function runDoctor(): Promise<void> {
	const backend = new MsiDockerBackend();
	const readiness = await backend.probe();
	const icon = readiness.status === "ready" ? "✓" : readiness.status === "degraded" ? "⚠" : "✗";
	console.log(`${icon} backend: ${readiness.backendId}  status: ${readiness.status}`);
	if (readiness.issues.length > 0) {
		for (const issue of readiness.issues) {
			console.log(`  - ${issue}`);
		}
	} else {
		console.log("  No issues detected.");
	}
}

async function runJob(args: string[]): Promise<void> {
	const [repoUrl, ref = "HEAD", ...promptParts] = args;
	if (!repoUrl) {
		console.error("Usage: ompk-remote run <repoUrl> [ref] [prompt...]");
		process.exit(1);
	}
	const prompt = promptParts.join(" ") || "Run the default test suite and report results.";
	const orc = makeOrchestrator();
	try {
		const job = orc.submit({
			source: { repoUrl, ref },
			task: { prompt, validationCommands: ["echo ok"], resultMode: "none" },
		});
		console.log(`Job submitted: ${job.id}`);
		const summary = await orc.run(job.id);
		console.log(`\nJob ${summary.jobId}  state=${summary.state}  exit=${summary.exitCode ?? "-"}`);
		if (summary.patch) {
			console.log("\n--- patch ---");
			console.log(summary.patch.slice(0, 4096));
		}
		if (summary.logs) {
			console.log("\n--- logs ---");
			console.log(summary.logs.slice(0, 8192));
		}
		if (summary.cleanupProof) {
			const p = summary.cleanupProof;
			const allGone = p.containerGone && p.volumeGone && p.networkGone;
			console.log(`\n--- cleanup proof ---`);
			console.log(`  container: ${p.containerGone ? "gone ✓" : "PRESENT ✗"}`);
			console.log(`  volume:    ${p.volumeGone ? "gone ✓" : "PRESENT ✗"}`);
			console.log(`  network:   ${p.networkGone ? "gone ✓" : "PRESENT ✗"}`);
			console.log(`  all clean: ${allGone ? "yes ✓" : "NO ✗"}`);
			if (p.notes) console.log(`  notes: ${p.notes}`);
		}
	} finally {
		orc.close();
	}
}

async function runStatus(jobId: string | undefined): Promise<void> {
	const orc = makeOrchestrator();
	try {
		if (jobId) {
			const job = orc.getJob(jobId);
			if (!job) {
				console.error(`Job ${jobId} not found`);
				process.exit(1);
			}
			printJobRow(job);
			if (job.transitions.length > 0) {
				console.log("\nTransitions:");
				for (const t of job.transitions) {
					console.log(`  ${t.timestamp}  ${t.from} → ${t.to}  [${t.actor}] ${t.reason}`);
				}
			}
		} else {
			const jobs = orc.listJobs();
			if (jobs.length === 0) {
				console.log("No jobs.");
			} else {
				for (const j of jobs) printJobRow(j);
			}
		}
	} finally {
		orc.close();
	}
}

async function runCancel(jobId: string | undefined): Promise<void> {
	if (!jobId) {
		console.error("Usage: ompk-remote cancel <jobId>");
		process.exit(1);
	}
	const orc = makeOrchestrator();
	try {
		const ok = await orc.cancel(jobId);
		console.log(ok ? `Job ${jobId} cancelled.` : `Could not cancel job ${jobId} (not found or already terminal).`);
	} finally {
		orc.close();
	}
}

async function runList(): Promise<void> {
	return runStatus(undefined);
}

async function runEnvironments(args: string[]): Promise<void> {
	const [sub, ...rest] = args;
	if (!sub || sub === "route" || sub === "summary") {
		printEnvironmentsSummary();
		return;
	}
	if (sub === "skill") {
		const skillName = rest[0];
		if (!skillName) {
			console.error("Usage: ompk-remote environments skill <name>");
			process.exit(1);
		}
		const route = resolveEnvironmentsCloudSkill(skillName);
		console.log(JSON.stringify(route, null, 2));
		return;
	}
	if (sub === "handoff") {
		const entrypoint = rest[0];
		if (!entrypoint) {
			console.error(
				"Usage: ompk-remote environments handoff <mesh|mesh-run|cloud|mesh-sync|mesh-ci|colab|colab-kill-all> [args...]",
			);
			process.exit(1);
		}
		const handoff = resolveMeshHandoff(entrypoint, rest.slice(1));
		console.log(JSON.stringify(handoff, null, 2));
		return;
	}
	console.error(`Unknown environments subcommand: ${sub}`);
	console.error("Usage: ompk-remote environments [route|skill <name>|handoff <entrypoint> [args...]]");
	process.exit(1);
}

function printEnvironmentsSummary(): void {
	const summary = summarizeEnvironmentsCloudRoute();
	console.log("environments-cloud / pkscloudenvs routing");
	console.log(`  SoT:        ${summary.sot.github}`);
	console.log(`  MSI root:   ${summary.root}`);
	console.log(`  override:   ${ENVIRONMENTS_CLOUD_ROOT_ENV} (or PKS_ENVIRONMENTS_CLOUD_ROOT)`);
	console.log(`  skills:     ${summary.skillsRoot}`);
	console.log(`  bins:       ${summary.binRoot}`);
	console.log("");
	console.log("Session skill routing (skills.customDirectories + auto-discovery):");
	for (const dir of summary.skillCustomDirectories) {
		console.log(`  - ${dir}`);
	}
	console.log("");
	console.log("Known skills:");
	for (const skill of summary.skills) {
		console.log(`  - ${skill.skillName} → ${skill.skillMd}`);
	}
	console.log("");
	console.log("Mesh/cloud handoff entrypoints (invoke from SoT, not ompk-remote Docker):");
	for (const name of summary.entrypoints) {
		const handoff = resolveMeshHandoff(name, []);
		console.log(`  - ${name}: ${handoff.binPath}`);
		console.log(`      ${handoff.purpose}`);
	}
	console.log("");
	console.log(summary.localSandboxNote);
}

function printJobRow(job: {
	id: string;
	state: string;
	createdAt: string;
	source: { repoUrl: string; ref: string };
}): void {
	console.log(`${job.id}  ${job.state.padEnd(20)}  ${job.source.repoUrl}@${job.source.ref}  ${job.createdAt}`);
}

function printUsage(): void {
	console.log(`ompk-remote — ephemeral remote workspace runner

Commands:
  doctor              check backend readiness (local Docker phase-1)
  run <repo> <ref>    submit + run a job to completion
  status [jobId]      show job(s) state
  cancel <jobId>      cancel a queued/running job
  list                list all jobs
  environments        resolve MSI environments-cloud (pkscloudenvs) routes
  environments skill <name>
  environments handoff <entrypoint> [args...]
  cloud               alias for environments

Mesh/cloud/auth/launch SoT is C:\\dev\\desktop-infra\\environments-cloud
(github.com/kingkillery/pkscloudenvs), not the phase-1 Docker backend.
`);
}
