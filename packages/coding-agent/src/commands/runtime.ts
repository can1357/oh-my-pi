/**
 * Durable operational runtime management (`omp runtime ...`).
 */
import { APP_NAME } from "@pk-nerdsaver-ai/pi-utils";
import { Args, Command, Flags, renderCommandHelp } from "@pk-nerdsaver-ai/pi-utils/cli";
import {
	parseRuntimeAction,
	RUNTIME_ACTIONS,
	type RuntimeAction,
	type RuntimeCommandArgs,
	runRuntimeCommand,
} from "../cli/operational-cli";

export default class Runtime extends Command {
	static description = "Manage the durable operational store and headless OMP worker";

	static args = {
		action: Args.string({
			description: "Runtime action",
			required: false,
			options: [...RUNTIME_ACTIONS],
		}),
		id: Args.string({
			description: "Job id (show/pause/resume/cancel/events/correct)",
			required: false,
		}),
	};

	static flags = {
		db: Flags.string({ description: "Operational SQLite database path" }),
		prompt: Flags.string({ description: "Prompt for enqueue / schedule-add" }),
		cwd: Flags.string({ description: "Working directory for omp jobs" }),
		model: Flags.string({ description: "Model override for omp jobs" }),
		"approval-mode": Flags.string({
			description: "tools.approvalMode override (always-ask|write|yolo)",
			options: ["always-ask", "write", "yolo"],
		}),
		cron: Flags.string({ description: "5-field cron expression for schedule-add" }),
		name: Flags.string({ description: "Schedule name for schedule-add" }),
		"notify-file": Flags.string({ description: "Append-only JSONL notification sink path" }),
		"webhook-url": Flags.string({
			description: "Webhook notification URL (startup-only; never persisted)",
		}),
		once: Flags.boolean({ description: "For run: execute at most one job then exit", default: false }),
		"poll-ms": Flags.integer({ description: "Worker poll interval milliseconds" }),
		project: Flags.string({
			description: "Project scope path for state-* (required for project scope)",
		}),
		key: Flags.string({ description: "State key" }),
		value: Flags.string({ description: "State value (JSON or string)" }),
		query: Flags.string({ description: "Episode search query" }),
		rating: Flags.integer({ description: "Human correction rating" }),
		summary: Flags.string({ description: "Bounded non-secret human correction summary" }),
		category: Flags.string({ description: "Human correction category" }),
		json: Flags.boolean({ description: "Emit JSON", default: false }),
	};

	static examples = [
		`# Enqueue a headless omp job\n  ${APP_NAME} runtime enqueue --prompt "summarize README" --cwd . --approval-mode write`,
		`# Run one queued job then exit\n  ${APP_NAME} runtime run --once --db ./operational.db`,
		`# Run the durable worker until signal\n  ${APP_NAME} runtime run --notify-file ./notify.jsonl --webhook-url https://example.test/hook`,
		`# List jobs / show one\n  ${APP_NAME} runtime list\n  ${APP_NAME} runtime show <job-id>`,
		`# Pause / resume / cancel\n  ${APP_NAME} runtime pause <job-id>`,
		`# Add a cron schedule\n  ${APP_NAME} runtime schedule-add --name nightly --cron "0 3 * * *" --prompt "triage" --cwd .`,
		`# Project-scoped KV\n  ${APP_NAME} runtime state-set --project . --key theme --value dark`,
		`# Search episode history\n  ${APP_NAME} runtime history-search --query refactor`,
		`# Record a human correction\n  ${APP_NAME} runtime correct <job-id> --summary "prefer smaller diffs" --rating 4`,
	];

	async run(): Promise<void> {
		const { args, flags } = await this.parse(Runtime);
		if (!args.action) {
			renderCommandHelp(APP_NAME, "runtime", Runtime);
			return;
		}

		const action = parseRuntimeAction(args.action) as RuntimeAction;
		const cmd: RuntimeCommandArgs = {
			action,
			id: args.id,
			flags: {
				db: flags.db,
				prompt: flags.prompt,
				cwd: flags.cwd,
				model: flags.model,
				approvalMode: flags["approval-mode"],
				cron: flags.cron,
				name: flags.name,
				notifyFile: flags["notify-file"],
				webhookUrl: flags["webhook-url"],
				once: flags.once,
				pollMs: flags["poll-ms"],
				project: flags.project,
				key: flags.key,
				value: flags.value,
				query: flags.query,
				rating: flags.rating,
				summary: flags.summary,
				category: flags.category,
				json: flags.json,
			},
		};

		try {
			await runRuntimeCommand(cmd);
		} catch (error) {
			const message = (error instanceof Error ? error.message : String(error))
				.replace(/[\t\r\n]+/g, " ")
				.slice(0, 500);
			process.stderr.write(`${message}\n`);
			process.exitCode = 1;
		}
	}
}
