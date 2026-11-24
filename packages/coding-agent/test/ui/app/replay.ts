/**
 * Replays one app-corpus case on the real interactive mode and prints what the
 * terminal showed at every stage, as JSON on stdout:
 * `bun test/ui/app/replay.ts <case.json> <size>` → `{ stages: [{ rows, scrollback, cursor, size, alt }] }`.
 *
 * A process of its own: the capture environment (pinned clock and randomness,
 * scrubbed env, fixed HOME and cwd, no network) is process-wide and must not
 * leak into other tests.
 */
import "./support/pin-env";
import "./support/env";
import { App, type AppOptions, type GridSnapshot } from "./harness";

type Size = "80x24" | "120x40";

interface AppEvent {
	readonly type: string;
	readonly data?: string;
	readonly text?: string;
	readonly ms?: number;
	readonly bySize?: Record<Size, [number, number]>;
	readonly delta?: string;
	readonly id?: string;
	readonly name?: string;
	readonly args?: unknown;
	readonly hold?: boolean;
	readonly usage?: { input?: number; output?: number; cacheRead?: number };
	readonly message?: string;
	readonly call?: string;
	readonly channel?: string;
	readonly payload?: unknown;
}

interface CaseFile {
	readonly theme: "dark" | "light";
	readonly inputs: {
		readonly setup: Omit<AppOptions, "cols" | "rows" | "theme">;
		readonly stages: readonly { readonly label: string; readonly events: readonly AppEvent[] }[];
	};
}

export interface ReplayedStage extends GridSnapshot {
	readonly size: string;
}

const TURN_TIMEOUT_MS = 5_000;

async function takeTurn(app: App) {
	const { promise, reject } = Promise.withResolvers<never>();
	const timer = setTimeout(
		() => reject(new Error("scenario expected a model request, but the agent made none")),
		TURN_TIMEOUT_MS,
	);
	try {
		return await Promise.race([app.nextTurn(), promise]);
	} finally {
		clearTimeout(timer);
	}
}

async function currentTurn(app: App) {
	if (app.turn && !app.turn.ended) return app.turn;
	return takeTurn(app);
}

export async function applyEvent(app: App, event: AppEvent, size: Size): Promise<void> {
	switch (event.type) {
		case "key":
			app.term.feed(event.data!);
			return;
		case "text":
			app.term.feed(event.text!);
			return;
		case "clock":
			app.advance(event.ms!);
			return;
		case "resize": {
			const [cols, rows] = event.bySize![size];
			app.resize(cols, rows);
			return;
		}
		case "model.request":
			await takeTurn(app);
			return;
		case "model.thinking":
			(await currentTurn(app)).thinking(event.delta!);
			return;
		case "model.text":
			(await currentTurn(app)).text(event.delta!);
			return;
		case "model.toolCall":
			if (event.hold) app.gates.holdIds.add(event.id!);
			(await currentTurn(app)).toolCall(event.id!, event.name!, event.args as Record<string, unknown>);
			return;
		case "model.done":
			(await currentTurn(app)).done(event.usage);
			return;
		case "model.error":
			(await currentTurn(app)).error(event.message!);
			return;
		case "tool.release":
			app.gates.release(event.id!);
			return;
		case "app": {
			const args = (event.args ?? []) as unknown[];
			const mode = app.mode;
			switch (event.call) {
				case "showStatus":
					mode.showStatus(String(args[0]));
					return;
				case "showWarning":
					mode.showWarning(String(args[0]));
					return;
				case "showError":
					mode.showError(String(args[0]));
					return;
				case "setHookWidget":
					mode.setHookWidget(
						String(args[0]),
						(args[1] ?? undefined) as Parameters<typeof mode.setHookWidget>[1],
						args[2] as Parameters<typeof mode.setHookWidget>[2],
					);
					return;
			}
			throw new Error(`unknown app call ${event.call}`);
		}
		case "bus":
			app.eventBus.emit(event.channel!, event.payload);
			return;
	}
	throw new Error(`unknown event ${event.type}`);
}

async function replay(file: CaseFile, size: Size): Promise<ReplayedStage[]> {
	const [cols, rows] = size.split("x").map(Number) as [number, number];
	const app = await App.create({ ...file.inputs.setup, cols, rows, theme: file.theme });
	const stages: ReplayedStage[] = [];
	try {
		for (const stage of file.inputs.stages) {
			for (const event of stage.events) {
				try {
					await applyEvent(app, event, size);
				} catch (error) {
					const viewport = app
						.snapshot()
						.viewport.map(row => Bun.stripANSI(row))
						.join("\n");
					throw new Error(
						`stage ${stages.length} (${stage.label}), ${JSON.stringify(event)}: ${error}\n${viewport}`,
					);
				}
				await app.settle();
			}
			stages.push({ ...app.snapshot(), size: `${app.columns}x${app.rows}` });
		}
	} finally {
		await app.dispose();
	}
	return stages;
}

if (import.meta.main) {
	const [casePath, size] = process.argv.slice(2) as [string, Size];
	const file = (await Bun.file(casePath).json()) as CaseFile;
	try {
		const stages = await replay(file, size);
		process.stdout.write(JSON.stringify({ stages }));
	} catch (error) {
		process.stdout.write(
			JSON.stringify({ error: error instanceof Error ? (error.stack ?? error.message) : String(error) }),
		);
	}
	process.exit(0);
}
