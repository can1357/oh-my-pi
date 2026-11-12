import { describe, expect, test } from "bun:test";
import * as path from "node:path";
import { isRecord, readJsonl, readLines, TempDir, withTimeout } from "@oh-my-pi/pi-utils";

/**
 * How long the fixture's `session_start` handler blocks in the first case. Real time: the delay is
 * what is measured.
 */
const HANDLER_MS = 8_000;
/**
 * The same delay for the held-type case below, which pays it once per held type. Shorter because
 * that case measures the sign of a difference, not a margin: a frame that is not held is answered
 * in milliseconds, so the handler only has to still be blocking when it would be.
 */
const HELD_HANDLER_MS = 2_500;
/** How long after the ready frame the first answer may take. The first case's handler blocks four times that. */
const ANSWER_BUDGET_MS = 2_000;
/** The line the fixture writes to stderr once its `session_start` handler has returned. */
const HANDLER_RETURNED_PREFIX = "startup-handler-returned ";
/** The line the fixture's `input` handler writes, naming whether it saw that return. */
const INPUT_HANDLER_PREFIX = "input-handler-ran ";
/** The line the fixture writes once its `session_start` handler has requested a deferred shutdown. */
const SHUTDOWN_REQUESTED_PREFIX = "startup-shutdown-requested ";
/**
 * How long the fixture's fake live session takes to connect. Exactly three cases set it and no
 * other code in this file does: the stop that cancels a connect, the mute read while a start
 * connects, and the stdin-close one. Every other agent of this file, the live frames of the
 * held-types case among them, keeps the fixture's instant connect, which is what those rows want:
 * they measure the hold, the read order or the serial queue rather than the connect. Real time: a
 * connect a `live_stop` can cancel, and that a frame behind the stop must not wait out.
 */
const LIVE_CONNECT_MS = 3_000;
/**
 * How long the fixture holds its `session_before_switch` handler in the post-startup live case
 * below, which is how long that case's `new_session` holds the serial queue. Real time: what the
 * case measures is that a `live_stop` behind it does not wait it out.
 */
const SERIAL_COMMAND_MS = 3_000;
/**
 * How long a case that waits for the agent to exit allows. Bounded well under the per-test timeout
 * so a regression fails its case instead of hanging the suite.
 */
const EXIT_BUDGET_MS = HELD_HANDLER_MS + 15_000;

/**
 * Spawn the slow-startup RPC agent in `temp`, with a minimal environment: the child must not read
 * the developer's or the runner's home-rooted plugin and config state, which would make a test
 * machine-dependent.
 */
const spawnSlowStartupAgent = (temp: TempDir, handlerMs: number, extraEnv: Record<string, string> = {}) =>
	Bun.spawn([process.execPath, path.join(import.meta.dir, "fixtures", "slow-startup-rpc-agent.ts")], {
		cwd: temp.path(),
		env: {
			PATH: Bun.env.PATH,
			HOME: temp.join("home"),
			PI_CODING_AGENT_DIR: temp.join("agent"),
			XDG_CONFIG_HOME: temp.join("config"),
			XDG_DATA_HOME: temp.join("data"),
			XDG_CACHE_HOME: temp.join("cache"),
			CI: "true",
			PI_NO_TITLE: "1",
			OMP_STARTUP_HANDLER_MS: String(handlerMs),
			...extraEnv,
		},
		stdin: "pipe",
		stdout: "pipe",
		stderr: "pipe",
	});

describe("RPC startup input dispatch", () => {
	test("a command sent after the ready frame is answered while a slow startup handler still runs", async () => {
		const temp = await TempDir.create("@omp-rpc-startup-dispatch-");
		const child = spawnSlowStartupAgent(temp, HANDLER_MS);
		try {
			const decoder = new TextDecoder();
			// The handler reports its own return on stderr, so both times come from the running agent.
			// One reader serves both markers: a second reader of the same stream would take its lines.
			const handlerReturned = Promise.withResolvers<{ at: number } | undefined>();
			const inputHandlerRan = Promise.withResolvers<string | undefined>();
			void (async () => {
				for await (const line of readLines(child.stderr as ReadableStream<Uint8Array>)) {
					const text = decoder.decode(line);
					if (text.startsWith(HANDLER_RETURNED_PREFIX)) {
						handlerReturned.resolve({ at: Number(text.slice(HANDLER_RETURNED_PREFIX.length).trim()) });
					} else if (text.startsWith(INPUT_HANDLER_PREFIX)) {
						// `<after|before>-session-start <when>`: the first word is what the handler saw.
						inputHandlerRan.resolve(text.slice(INPUT_HANDLER_PREFIX.length).trim().split("-")[0]);
					}
				}
				// Nothing more can arrive once the agent's stderr ends.
				handlerReturned.resolve(undefined);
				inputHandlerRan.resolve(undefined);
			})().catch(() => {
				// A reader that throws (its stream errors when the child is killed) must not reject
				// unobserved: an unhandled rejection here can fail an unrelated later test file.
				handlerReturned.resolve(undefined);
				inputHandlerRan.resolve(undefined);
			});

			let readyAt = 0;
			let answerAt = 0;
			let answer: Record<string, unknown> | undefined;
			const probeAnswered = Promise.withResolvers<void>();
			// The reader keeps draining after the probe: the prompt below makes the agent write a whole
			// turn, and a reader that stopped would leave it writing into a pipe this test has closed.
			void (async () => {
				for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
					if (!isRecord(frame)) continue;
					if (frame.type === "ready") {
						readyAt = Date.now();
						child.stdin.write(`${JSON.stringify({ type: "get_state", id: "probe" })}\n`);
						await child.stdin.flush();
						continue;
					}
					if (frame.id === "probe") {
						answerAt = Date.now();
						answer = frame;
						probeAnswered.resolve();
					}
				}
				// A no-op once the probe was answered; otherwise it is what the await below reports.
				probeAnswered.reject(new Error("the agent closed its output before it answered the probe"));
			})().catch((readError: unknown) => {
				// As above: the rejection is reported through the wait below rather than left unobserved.
				probeAnswered.reject(readError);
			});
			await withTimeout(
				probeAnswered.promise,
				HANDLER_MS + 30_000,
				"the agent answered no frame before the timeout",
			);

			expect(answer).toMatchObject({ id: "probe", command: "get_state", success: true });
			// The point of the fix: the answer does not wait for startup to finish.
			expect(answerAt - readyAt).toBeLessThan(ANSWER_BUDGET_MS);

			// A prompt that arrives while startup still runs must not start its turn before the
			// `session_start` broadcast has finished: a handler registered or a state set in a
			// `session_start` handler would otherwise not be in place for the first turn.
			child.stdin.write(`${JSON.stringify({ type: "prompt", id: "first-turn", message: "hello" })}\n`);
			await child.stdin.flush();

			const returned = await withTimeout(
				handlerReturned.promise,
				HANDLER_MS + 30_000,
				"the startup handler never reported its return",
			);
			expect(returned).toBeDefined();
			expect(answerAt).toBeLessThan(returned!.at);

			const inputOrder = await withTimeout(
				inputHandlerRan.promise,
				HANDLER_MS + 30_000,
				"the input handler never reported what it saw",
			);
			expect(inputOrder).toBe("after");
		} finally {
			child.kill();
			await child.exited;
			await temp.remove();
		}
	}, 120_000);

	/**
	 * Send `get_state` and one held frame right after the ready frame of an agent of this row's own,
	 * and report when each was answered against the time the startup handler reported its return.
	 * `alongside` frames go out with the held frame, so they too are read while startup runs: that is
	 * how a row shows what a second frame sent during startup does to the held one. With `after`, one
	 * more frame is sent once the frame named by `afterFollows` (the held frame by default) has been
	 * answered — so after startup — and its response is returned, which is how a row proves what the
	 * frames sent during startup left behind. A row whose outcome is settled by an `alongside` frame
	 * rather than by the held one names that frame's id, so the probe cannot race it.
	 *
	 * One agent per row, not one agent sent every held frame: `RpcInputDispatcher` runs every
	 * non-background command on a single serial tail, so a second held frame is dequeued only once the
	 * first has waited startup out, and its answer would land after the handler returned whether or
	 * not its own type is held. Only the frame at the head of the tail measures the hold.
	 */
	const measureHeldFrame = async (
		held: Record<string, unknown>,
		options: {
			alongside?: Record<string, unknown>[];
			after?: Record<string, unknown>;
			afterFollows?: string;
		} = {},
	) => {
		const { alongside, after, afterFollows = "held" } = options;
		const temp = await TempDir.create("@omp-rpc-startup-held-");
		const child = spawnSlowStartupAgent(temp, HELD_HANDLER_MS);
		try {
			const decoder = new TextDecoder();
			const handlerReturned = Promise.withResolvers<{ at: number } | undefined>();
			void (async () => {
				for await (const line of readLines(child.stderr as ReadableStream<Uint8Array>)) {
					const text = decoder.decode(line);
					if (text.startsWith(HANDLER_RETURNED_PREFIX)) {
						handlerReturned.resolve({ at: Number(text.slice(HANDLER_RETURNED_PREFIX.length).trim()) });
					}
				}
				handlerReturned.resolve(undefined);
			})().catch(() => {
				// As in the case above: a reader that throws when the child is killed must not reject
				// unobserved, which can fail an unrelated later test file.
				handlerReturned.resolve(undefined);
			});

			let readyAt = 0;
			let stateAt = 0;
			let heldAt = 0;
			let stateAnswer: Record<string, unknown> | undefined;
			let heldAnswer: Record<string, unknown> | undefined;
			let afterAnswer: Record<string, unknown> | undefined;
			let afterSent = false;
			const answered = Promise.withResolvers<void>();
			void (async () => {
				for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
					if (!isRecord(frame)) continue;
					if (frame.type === "ready") {
						readyAt = Date.now();
						// The held frame waits: the hold reads the command type, because each held type
						// starts a turn, changes the session, changes the goal state
						// `goalController.reconcile()` is still settling during startup, or belongs to a
						// live session whose frames must keep their arrival order. `get_state` changes
						// nothing and is answered at once.
						child.stdin.write(`${JSON.stringify({ type: "get_state", id: "state" })}\n`);
						child.stdin.write(`${JSON.stringify({ ...held, id: "held" })}\n`);
						for (const [index, extra] of (alongside ?? []).entries()) {
							child.stdin.write(`${JSON.stringify({ ...extra, id: `alongside-${index}` })}\n`);
						}
						await child.stdin.flush();
						continue;
					}
					if (frame.id === "state") {
						stateAt = Date.now();
						stateAnswer = frame;
					}
					if (frame.id === "held") {
						heldAt = Date.now();
						heldAnswer = frame;
					}
					// Sent only now: the answer it follows means startup is over, so this reads what the
					// frames sent during startup left behind instead of racing them.
					if (after && !afterSent && frame.id === afterFollows) {
						afterSent = true;
						child.stdin.write(`${JSON.stringify({ ...after, id: "after" })}\n`);
						await child.stdin.flush();
					}
					if (frame.id === "after") afterAnswer = frame;
					if (stateAt > 0 && heldAt > 0 && (!after || afterAnswer)) answered.resolve();
				}
				answered.reject(new Error("the agent closed its output before it answered every frame"));
			})().catch((readError: unknown) => {
				answered.reject(readError);
			});
			await withTimeout(
				answered.promise,
				HELD_HANDLER_MS + 30_000,
				"the agent answered no frame before the timeout",
			);

			const returned = await withTimeout(
				handlerReturned.promise,
				HELD_HANDLER_MS + 30_000,
				"the startup handler never reported its return",
			);
			expect(returned).toBeDefined();
			return {
				type: held.type,
				msFromReadyToState: stateAt - readyAt,
				msFromStartupReturnToHeld: heldAt - returned!.at,
				state: stateAnswer,
				held: heldAnswer,
				after: afterAnswer,
			};
		} finally {
			child.kill();
			await child.exited;
			await temp.remove();
		}
	};

	// Seventeen agents, each waiting out one `HELD_HANDLER_MS` startup.
	test("every command the startup hold covers waits for startup, and a get_state sent with it does not", async () => {
		const objective = "ship the release";
		// One frame of each held type. Every member of the hold now has a row that fails when that
		// member alone leaves `STARTUP_HELD_TYPES`: `prompt` through the first case of this file,
		// `new_session` through the withdrawal case below, and every other member here,
		// including the `goal` ops `waitsForStartup` adds to the set. The live rows lock the hold
		// exactly as the others do: with `live_start` taken out of the hold its answer came 2,424 to
		// 2,492 ms before the handler returned, measured at `37dc7037` by the round 3 reviews, each
		// with a fake live controller in its own scratch copy of the fixture, and copied into this
		// file at `d731a4f9`, the commit that added the fixture's own fake. `live_connect` needs its
		// own row because the `live_start` row does not cover it:
		// taken alone out of the hold, every other row still passed. Whether a frame answers with a
		// success or with an error is neither asserted nor relevant: the hold sits in `handleCommand`
		// before `handleCommandImpl`, so a frame waits for startup whatever its payload turns out to
		// mean. That is why so many payloads here are deliberately unusable; a row reads its own
		// answer only where the comment above it says what that answer shows. The live rows drive the
		// fixture's fake live controller, so they depend on neither the machine's audio device nor
		// its realtime credentials.
		// One agent at a time, in order: seventeen slow-startup agents at once would measure the
		// machine.
		const goal = await measureHeldFrame(
			{ type: "goal", op: "create", objective },
			{ after: { type: "goal", op: "get" } },
		);
		const timings = [
			goal,
			// The user-input types but `prompt`, whose row is the first case of this file. These three
			// run against a session with no turn to steer and no turn to follow: three more payloads
			// the hold never reads.
			await measureHeldFrame({ type: "steer", message: "held steer" }),
			await measureHeldFrame({ type: "follow_up", message: "held follow up" }),
			await measureHeldFrame({ type: "abort_and_prompt", message: "held abort and prompt" }),
			// The session-change types but `new_session`, whose row is the withdrawal case below. Every
			// payload here is unusable too: the entry ids name nothing in the session tree, and the
			// two paths are relative, so the agent resolves them against its cwd, which is the temp
			// dir of its own run — a session file that is not there and a session directory that is
			// not there either.
			await measureHeldFrame({ type: "switch_session", sessionPath: "no-such-session.jsonl" }),
			await measureHeldFrame({ type: "branch", entryId: "no-such-entry" }),
			await measureHeldFrame({ type: "fork", entryId: "no-such-entry" }),
			await measureHeldFrame({ type: "open_session", sessionDir: "held-open-session" }),
			await measureHeldFrame({ type: "compact" }),
			await measureHeldFrame({ type: "navigate_tree", entryId: "no-such-entry" }),
			await measureHeldFrame({ type: "handoff" }),
			await measureHeldFrame({ type: "live_start" }),
			await measureHeldFrame({ type: "live_connect", sdpOffer: "v=0 held-offer" }),
		];

		// The `get_state` sent with each held frame does not wait for startup, as in the case above.
		expect(timings.filter(timing => timing.msFromReadyToState >= ANSWER_BUDGET_MS)).toEqual([]);
		// The point of the hold: a command that changes state is answered only once startup is over,
		// whatever its own answer says. Take any one type out of the hold and this is the assertion
		// that fails, naming that type and the milliseconds by which its answer beat the handler's
		// return.
		expect(timings.filter(timing => timing.msFromStartupReturnToHeld <= 0)).toEqual([]);
		// What the hold is for, in the one row with state to show for it: the goal the host created
		// during startup is active when the host reads it back. The hold puts `goal create` after the
		// startup reattach (`goalController.reconcile()`), so no part of startup runs over it.
		expect(goal.after).toMatchObject({ success: true, data: { goal: { objective, status: "active" } } });

		// What divides membership of `ABORT_WITHDRAWN_HELD_TYPES` from the abort that withdraws: a
		// held session change sent with no abort runs, and only an abort read while it waits
		// withdraws it. Three of the four withdrawn types went out above with no abort behind them,
		// and each of the three ran; the rows below send the same three types with the same payloads
		// and an `abort` alongside, and read `{ cancelled: true }`. What these assertions divide is
		// the abort from the hold, not the numbering: without this half, a source that answered every
		// held frame of the withdrawal set as cancelled passes every row of this file. A source that
		// numbered no `navigate_tree` can no longer be written, because `NUMBERED_TYPES` spreads
		// `ABORT_WITHDRAWN_HELD_TYPES`: unnumbering a withdrawn type now means deleting it from that
		// set, which stops it being withdrawn at all, and that coupled edit reddens the type's own
		// withdrawal row in the `test.each` below. Each answer is the one its own unusable payload
		// earns: the relative `sessionPath` names no session file, so the switch makes the session it
		// was pointed at and reports a change that was not cancelled, and the two entry ids name
		// nothing in the session tree.
		const heldAnswerFor = (type: string) => timings.find(timing => timing.type === type)?.held;
		expect(heldAnswerFor("switch_session")).toMatchObject({
			success: true,
			command: "switch_session",
			data: { cancelled: false },
		});
		expect(heldAnswerFor("fork")).toMatchObject({
			success: false,
			command: "fork",
			error: "Invalid entry ID for forking: no-such-entry",
		});
		expect(heldAnswerFor("navigate_tree")).toMatchObject({
			success: false,
			command: "navigate_tree",
			error: "Entry no-such-entry not found",
			code: "entry_not_found",
		});
		// Each of the three is the answer a frame that ran earns, and none of them is the withdrawn
		// shape `{ success: true, data: { cancelled: true } }` the rows below read, where an abort
		// was read while the same payload waited.

		// Why `live_stop` and `live_mute` are held too: a `live_stop` sent during startup must stop
		// the `live_start` sent before it. The hold puts both after startup, all four live types are
		// background-dispatched so each starts its startup wait as it is read and the four resume in
		// the order the host sent them, and the bridge publishes its controller before its first
		// await, so the stop finds it. Answered during startup instead, the stop would find no
		// controller, do nothing and report success, and the held start would then open the
		// microphone after the host asked it to stop. `live_mute`, sent once startup is over, is how
		// the row reads the outcome: it fails only when no live session is running.
		const liveStopped = await measureHeldFrame(
			{ type: "live_start" },
			{ alongside: [{ type: "live_stop" }], after: { type: "live_mute", muted: true } },
		);
		expect(liveStopped.msFromStartupReturnToHeld).toBeGreaterThan(0);
		expect(liveStopped.after).toMatchObject({ success: false, error: "No live session is active" });

		// `live_mute` is held for the same ordering reason, and its loss is louder than the stop's:
		// answered during startup it finds no controller and fails, so the live session the host asked
		// to be muted starts with the microphone open. Measured with `live_mute` out of the hold by the
		// tester at `d731a4f9`, in a scratch worktree of its own: the mute was answered 13 ms after the
		// ready frame with "No live session is active" while the `live_start` behind it still ran 4 s
		// later. Held, the mute applies to the session the start opened, so the toggle this row sends
		// once startup is over turns it off again; unheld, the same toggle turns it on.
		const liveMuted = await measureHeldFrame(
			{ type: "live_start" },
			{ alongside: [{ type: "live_mute", muted: true }], after: { type: "live_mute" } },
		);
		expect(liveMuted.msFromStartupReturnToHeld).toBeGreaterThan(0);
		expect(liveMuted.after).toMatchObject({ success: true, data: { muted: false } });

		// What keeps the four live frames in arrival order: all four are background-dispatched, so
		// each reaches `handleCommand` as it is read and starts its wait on `startupSettled` there,
		// and promise reactions run in registration order. Were `live_stop` and `live_mute` serial
		// instead, they would reach that wait only at the head of the serial tail: with the held
		// `compact` ahead of the pair the stop would reach it only after startup, by which time the
		// backgrounded start has resumed, so the stop would be applied to the session the start
		// opened and the host's last request undone. The probe is sent once the start has been
		// answered, so it reports which request survived: a mute means the `live_start` the host
		// sent last is the request that is honoured and its session is running, while "No live
		// session is active" means the stop was applied after it.
		const liveStartedAfterStop = await measureHeldFrame(
			{ type: "compact" },
			{
				alongside: [{ type: "live_stop" }, { type: "live_start" }],
				after: { type: "live_mute", muted: true },
				afterFollows: "alongside-1",
			},
		);
		expect(liveStartedAfterStop.msFromStartupReturnToHeld).toBeGreaterThan(0);
		expect(liveStartedAfterStop.after).toMatchObject({ success: true, data: { muted: true } });

		// The other side of the same rule, which no row above can show: `goal` with op `get` only
		// reads, so it is answered while startup runs. Hold it and this assertion fails — and a held
		// `goal get` would block every frame the dispatcher serializes behind it for the whole of
		// startup, which is the defect this issue exists for.
		const goalGet = await measureHeldFrame({ type: "goal", op: "get" });
		expect(goalGet.msFromStartupReturnToHeld).toBeLessThan(0);
		expect(goalGet.msFromReadyToState).toBeLessThan(ANSWER_BUDGET_MS);
		// Seventeen agents of 2.5 s each run this case in about 100 s on an idle machine; the budget
		// keeps four times that, so a loaded runner does not turn a slow machine into a failure.
	}, 420_000);

	/**
	 * One agent per member of `ABORT_WITHDRAWN_HELD_TYPES`: an `abort` read while the held frame
	 * waits withdraws it. Both frames are numbered as they are read, so the abort is numbered after
	 * the frame it withdraws even though the dispatcher runs that frame later, and the `isCurrent`
	 * read after the startup wait answers it as cancelled instead of running a change the host no
	 * longer wants.
	 *
	 * Parameterised because the set is kept by hand: take any one of the four types out of it and
	 * that type's row is the one that fails, because the frame then runs — `new_session` opens the
	 * session the host withdrew, `switch_session` reports a change that was not cancelled, and the
	 * other two answer the error their entry id earns, since neither names an entry that exists.
	 * The case above sends the same three payloads with no abort and reads those answers, which is
	 * what makes the abort here the cause rather than membership of the set.
	 */
	test.each([
		["new_session", {}],
		["switch_session", { sessionPath: "no-such-session.jsonl" }],
		["fork", { entryId: "no-such-entry" }],
		["navigate_tree", { entryId: "no-such-entry" }],
	] as const)(
		"an abort read while a held %s waits withdraws it",
		async (type, payload) => {
			const withdrawn = await measureHeldFrame(
				{ type, ...payload },
				{ alongside: [{ type: "abort" }], after: { type: "get_state" } },
			);
			expect(withdrawn.msFromStartupReturnToHeld).toBeGreaterThan(0);
			expect(withdrawn.held).toMatchObject({ success: true, command: type, data: { cancelled: true } });
			// Withdrawn means not run: the session the host had when it sent the frame is still open.
			const stateData = withdrawn.state?.data;
			const sessionBefore = isRecord(stateData) ? stateData.sessionId : undefined;
			expect(typeof sessionBefore).toBe("string");
			expect(withdrawn.after).toMatchObject({ success: true, data: { sessionId: sessionBefore } });
		},
		120_000,
	);

	/**
	 * Drive an agent of this row's own past startup and return every answer it gave, by id.
	 *
	 * The first frame is a held `navigate_tree` whose payload names no entry, so its answer is an
	 * error that means one thing only: startup is over, and every frame sent after it is read after
	 * it. `sendAfter` maps the id of an answer to the frames to write once it arrives — the id of
	 * that first answer is `startup-over` — and writes each entry as one chunk, so the agent reads
	 * those frames in the order they are listed. The run ends once every id in `until` has been
	 * answered. `onAnswer` sees each answer as it is recorded, which is how a row reads the order
	 * two answers arrived in rather than a latency bound.
	 */
	const runAfterStartup = async (options: {
		prefix: string;
		env?: Record<string, string>;
		sendAfter: Record<string, Record<string, unknown>[]>;
		until: string[];
		budgetMs: number;
		onAnswer?: (id: string, answers: ReadonlyMap<string, Record<string, unknown>>) => void;
	}) => {
		const temp = await TempDir.create(options.prefix);
		const child = spawnSlowStartupAgent(temp, HELD_HANDLER_MS, options.env);
		try {
			const answers = new Map<string, Record<string, unknown>>();
			const answered = Promise.withResolvers<void>();
			void (async () => {
				for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
					if (!isRecord(frame)) continue;
					if (frame.type === "ready") {
						child.stdin.write(
							`${JSON.stringify({ type: "navigate_tree", entryId: "no-such-entry", id: "startup-over" })}\n`,
						);
						await child.stdin.flush();
						continue;
					}
					if (typeof frame.id !== "string") continue;
					answers.set(frame.id, frame);
					options.onAnswer?.(frame.id, answers);
					const next = Object.hasOwn(options.sendAfter, frame.id) ? options.sendAfter[frame.id] : undefined;
					if (next) {
						child.stdin.write(`${next.map(frameToSend => JSON.stringify(frameToSend)).join("\n")}\n`);
						await child.stdin.flush();
					}
					if (options.until.every(id => answers.has(id))) answered.resolve();
				}
				answered.reject(new Error("the agent closed its output before it answered every frame"));
			})().catch((readError: unknown) => {
				answered.reject(readError);
			});
			await withTimeout(answered.promise, options.budgetMs, "the agent answered no frame before the timeout");
			return answers;
		} finally {
			child.kill();
			await child.exited;
			await temp.remove();
		}
	};

	/**
	 * The withdrawal covers the frames startup held and nothing sent after them. This case needs
	 * frames the agent reads once startup is over, which `measureHeldFrame` cannot send — every frame
	 * it sends goes out during startup, and its one `after` frame is answered on its own — so this
	 * case drives an agent of its own, through {@link runAfterStartup}.
	 *
	 * The `export_html` ahead of the pair is what makes the frames behind it arrive the way a held
	 * frame's do: it loads the export module and writes a file, so it is still running when the agent
	 * reads the `new_session` and the `abort` sent with it, and the abort is numbered after the change
	 * the dispatcher has not started yet. Read during startup, that pair is answered `cancelled`; read
	 * after it, the change must run, and a withdrawal that reads `startupSettled` instead of the
	 * frames startup held cancels it forever.
	 */
	test("an abort read after startup does not withdraw a session change read after startup", async () => {
		const answers = await runAfterStartup({
			prefix: "@omp-rpc-startup-after-",
			sendAfter: {
				// One write, so the agent reads the four from one chunk while the `export_html` at
				// their head still runs: the `get_state` reports the session the host is in when it
				// sends the change, and the `abort` is read before the change leaves the queue.
				"startup-over": [
					{ type: "export_html", outputPath: "blocker.html", id: "blocker" },
					{ type: "get_state", id: "before" },
					{ type: "new_session", id: "change" },
					{ type: "abort", id: "abort" },
				],
				change: [{ type: "get_state", id: "after" }],
			},
			until: ["after"],
			budgetMs: HELD_HANDLER_MS + 30_000,
		});

		// The change was not held by startup, so the abort behind it does not withdraw it.
		expect(answers.get("change")).toMatchObject({
			success: true,
			command: "new_session",
			data: { cancelled: false },
		});
		// Run, not withdrawn: the host is in a different session than the one it sent the change from.
		const beforeData = answers.get("before")?.data;
		const afterData = answers.get("after")?.data;
		const sessionBefore = isRecord(beforeData) ? beforeData.sessionId : undefined;
		const sessionAfter = isRecord(afterData) ? afterData.sessionId : undefined;
		expect(typeof sessionBefore).toBe("string");
		expect(typeof sessionAfter).toBe("string");
		expect(sessionAfter).not.toBe(sessionBefore);
	}, 120_000);

	/**
	 * A deferred shutdown the extension requests during startup must still end the process when
	 * live frames were read during startup. The request is the extension's own `pi.shutdown()`; no
	 * client frame raises it. `get_state` is answered while startup runs, and its
	 * `afterSerialCommand` finds the request and drains the background tasks before the process
	 * exits — so a live frame that waits on something the drain is holding deadlocks that exit. All
	 * four live types are background-dispatched, so none of them waits on the serial queue.
	 */
	test("a shutdown requested during startup still exits with live frames read during startup", async () => {
		const temp = await TempDir.create("@omp-rpc-startup-shutdown-");
		const child = spawnSlowStartupAgent(temp, HELD_HANDLER_MS, { OMP_SHUTDOWN_DURING_STARTUP: "1" });
		try {
			const decoder = new TextDecoder();
			const shutdownRequested = Promise.withResolvers<boolean>();
			void (async () => {
				for await (const line of readLines(child.stderr as ReadableStream<Uint8Array>)) {
					if (decoder.decode(line).startsWith(SHUTDOWN_REQUESTED_PREFIX)) shutdownRequested.resolve(true);
				}
				shutdownRequested.resolve(false);
			})().catch(() => {
				// As in the cases above: a reader that throws when the child is killed must not reject
				// unobserved, which can fail an unrelated later test file.
				shutdownRequested.resolve(false);
			});

			const answers = new Map<string, Record<string, unknown>>();
			const answered = Promise.withResolvers<void>();
			void (async () => {
				for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
					if (!isRecord(frame) || typeof frame.id !== "string") continue;
					answers.set(frame.id, frame);
					if (answers.has("state") && answers.has("stop") && answers.has("start")) answered.resolve();
				}
				answered.reject(new Error("the agent closed its output before it answered every frame"));
			})().catch((readError: unknown) => {
				answered.reject(readError);
			});

			// Sent once the request is in place, so the `get_state` below is the serial command whose
			// shutdown check drains rather than racing the handler for it.
			const requested = await withTimeout(
				shutdownRequested.promise,
				HELD_HANDLER_MS + 30_000,
				"the fixture never reported the shutdown it requests during startup",
			);
			expect(requested).toBe(true);
			child.stdin.write(
				`${[
					JSON.stringify({ type: "get_state", id: "state" }),
					JSON.stringify({ type: "live_stop", id: "stop" }),
					JSON.stringify({ type: "live_start", id: "start" }),
				].join("\n")}\n`,
			);
			await child.stdin.flush();

			// Every owed response is written before the process exits, whatever each one says: the
			// live frames resume when startup ends, and the shutdown drain waits for them.
			await withTimeout(answered.promise, EXIT_BUDGET_MS, "the agent answered no frame before the timeout");
			expect(answers.get("state")).toMatchObject({ success: true, command: "get_state" });
			expect(answers.get("stop")).toMatchObject({ command: "live_stop" });
			expect(answers.get("start")).toMatchObject({ command: "live_start" });
			const exitCode = await withTimeout(
				child.exited,
				EXIT_BUDGET_MS,
				"the agent did not exit after the shutdown it requested during startup",
			);
			expect(exitCode).toBe(0);
		} finally {
			child.kill();
			await child.exited;
			await temp.remove();
		}
	}, 120_000);

	/**
	 * A `live_stop` read after a `live_start` during startup cancels the connect instead of waiting
	 * it out, and takes no place in the serial queue while it does. The fake controller's connect
	 * takes real time here, which is what makes the difference visible: the start resumes first and
	 * publishes its controller before its first await, so the stop that resumes next finds it.
	 */
	test("a live_stop read after a live_start during startup cancels the connect", async () => {
		const temp = await TempDir.create("@omp-rpc-startup-live-cancel-");
		const child = spawnSlowStartupAgent(temp, HELD_HANDLER_MS, { OMP_LIVE_START_MS: String(LIVE_CONNECT_MS) });
		try {
			let readyAt = 0;
			let probeAt = 0;
			let recording = false;
			const answers = new Map<string, Record<string, unknown>>();
			const answered = Promise.withResolvers<void>();
			void (async () => {
				for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
					if (!isRecord(frame)) continue;
					if (frame.type === "ready") {
						readyAt = Date.now();
						child.stdin.write(
							`${[
								JSON.stringify({ type: "live_start", id: "start" }),
								JSON.stringify({ type: "live_stop", id: "stop" }),
								JSON.stringify({ type: "get_state", id: "probe" }),
							].join("\n")}\n`,
						);
						await child.stdin.flush();
						continue;
					}
					// The phase the controller reaches once the microphone is open.
					if (frame.type === "live_phase" && frame.phase === "listening") recording = true;
					if (typeof frame.id !== "string") continue;
					answers.set(frame.id, frame);
					if (frame.id === "probe") probeAt = Date.now();
					if (answers.has("start") && answers.has("stop") && answers.has("probe")) answered.resolve();
				}
				answered.reject(new Error("the agent closed its output before it answered every frame"));
			})().catch((readError: unknown) => {
				answered.reject(readError);
			});
			await withTimeout(
				answered.promise,
				HELD_HANDLER_MS + LIVE_CONNECT_MS + 30_000,
				"the agent answered no frame before the timeout",
			);

			expect(answers.get("start")).toMatchObject({
				success: false,
				command: "live_start",
				error: "The live session stopped while connecting.",
			});
			// Cancelled, not stopped afterwards: the host microphone never opened.
			expect(recording).toBe(false);
			expect(answers.get("stop")).toMatchObject({ success: true, command: "live_stop" });
			// The stop takes no place in the serial queue, so the probe behind it is answered while
			// startup still runs rather than behind the connect the stop cancels.
			expect(probeAt - readyAt).toBeLessThan(ANSWER_BUDGET_MS);
		} finally {
			child.kill();
			await child.exited;
			await temp.remove();
		}
	}, 120_000);

	/**
	 * The same background dispatch after startup, which is where a host spends its session: a
	 * `live_stop` sent behind a serial command that takes real time must take effect while that
	 * command still runs, not once it answers. The serial command is a `new_session` whose
	 * `session_before_switch` handler the fixture holds for `SERIAL_COMMAND_MS`, so the row owns its
	 * duration; the handler runs before `newSession` touches the session, so the live session the
	 * `live_start` opened is still running while it blocks.
	 *
	 * Read by what the host sees rather than by a latency bound: the stop and the `live_mute` probe
	 * behind it are both answered before the `new_session` is, and the probe reports no live session,
	 * so the stop reached the session while the serial command had not yet answered. With `live_stop`
	 * and `live_mute` taken out of `BACKGROUND_COMMANDS` both answers arrive behind the
	 * `new_session`, and the two order assertions fail.
	 */
	test("a live_stop sent behind a slow serial command stops the live session before it answers", async () => {
		let stopSawBlocker = true;
		let probeSawBlocker = true;
		const answers = await runAfterStartup({
			prefix: "@omp-rpc-startup-live-serial-",
			env: { OMP_SESSION_CHANGE_MS: String(SERIAL_COMMAND_MS) },
			sendAfter: {
				"startup-over": [{ type: "live_start", id: "start" }],
				// One write, so the agent reads the three in this order: the `new_session` takes
				// the serial tail and blocks it for `SERIAL_COMMAND_MS`, and the two behind it
				// are dispatched as they are read.
				start: [
					{ type: "new_session", id: "blocker" },
					{ type: "live_stop", id: "stop" },
					{ type: "live_mute", muted: true, id: "probe" },
				],
			},
			until: ["blocker", "stop", "probe"],
			budgetMs: HELD_HANDLER_MS + SERIAL_COMMAND_MS + 30_000,
			onAnswer: (id, seen) => {
				if (id === "stop") stopSawBlocker = seen.has("blocker");
				if (id === "probe") probeSawBlocker = seen.has("blocker");
			},
		});

		// The session the stop has to reach: the start was answered before the three went out.
		expect(answers.get("start")).toMatchObject({ success: true, command: "live_start" });
		expect(answers.get("stop")).toMatchObject({ success: true, command: "live_stop" });
		expect(stopSawBlocker).toBe(false);
		// What the host sees: the live session is gone while the serial command still has not
		// answered, so the stop took effect without waiting for it.
		expect(answers.get("probe")).toMatchObject({
			success: false,
			command: "live_mute",
			error: "No live session is active",
		});
		expect(probeSawBlocker).toBe(false);
		// The serial command still answers: nothing above cancels it.
		expect(answers.get("blocker")).toMatchObject({ success: true, command: "new_session" });
	}, 120_000);

	/**
	 * The live race no row above reads: a `live_mute` read while a `live_start` is still connecting
	 * must act on that connect, as the `live_stop` of the cancel-the-connect case above does (the
	 * case just above stops a session that is already listening). The mute is read from the same
	 * chunk as the start, so it is dispatched while the fake controller's connect is still sleeping
	 * for `LIVE_CONNECT_MS`, and `RpcLiveBridge.start` publishes its controller before that first
	 * await, so the mute finds the session the start is opening.
	 *
	 * Read by what the host sees: the mute is answered `muted: true` before the start is answered at
	 * all, and the toggle sent once the start has been answered reports `muted: false`, so the
	 * session that came up is the one the mute muted. A bridge that published its controller only
	 * once connected answers the mute "No live session is active" and opens the microphone unmuted,
	 * which both `muted` assertions below catch.
	 *
	 * What this row does not guard: no single removal of this change reddens it. Deleting `live_mute`
	 * from `LIVE_STARTUP_TYPES`, which takes it out of the startup hold and out of
	 * `BACKGROUND_COMMANDS` at once, leaves this row green, measured at `00c37bff` in a scratch
	 * workspace of the implementer's own, because the row runs after startup, where the serial tail
	 * is free and the mute reaches the connect either way. It reads a race the live family had no row
	 * for, and what it locks is the bridge publishing its controller
	 * before its first await; the background move is locked by the shutdown case, the
	 * stop-during-connect case and the order row of the held-types case.
	 */
	test("a live_mute read while a live_start connects mutes the session that comes up", async () => {
		let muteSawStart = true;
		const answers = await runAfterStartup({
			prefix: "@omp-rpc-startup-live-mute-",
			env: { OMP_LIVE_START_MS: String(LIVE_CONNECT_MS) },
			sendAfter: {
				// One write, so the mute is read while the start is still connecting.
				"startup-over": [
					{ type: "live_start", id: "start" },
					{ type: "live_mute", muted: true, id: "mute" },
				],
				// Sent once the connect is over, so it reads the session the start opened.
				start: [{ type: "live_mute", id: "probe" }],
			},
			until: ["start", "mute", "probe"],
			budgetMs: HELD_HANDLER_MS + LIVE_CONNECT_MS + 30_000,
			onAnswer: (id, seen) => {
				if (id === "mute") muteSawStart = seen.has("start");
			},
		});

		// The mute reached the connecting session: it was answered, with the microphone muted, before
		// the connect it raced had answered at all.
		expect(answers.get("mute")).toMatchObject({ success: true, command: "live_mute", data: { muted: true } });
		expect(muteSawStart).toBe(false);
		// The mute did not cancel the connect, as a stop would: the session came up.
		expect(answers.get("start")).toMatchObject({ success: true, command: "live_start" });
		// What the host sees: the toggle turns the microphone back on, so the session that came up
		// was muted. Had the mute missed the connect, the same toggle would answer `muted: true`.
		expect(answers.get("probe")).toMatchObject({ success: true, command: "live_mute", data: { muted: false } });
	}, 120_000);

	/**
	 * Stdin closing behind a `live_start` read during startup must leave no live session running:
	 * the EOF path stops the bridge, and a start that resumes later would open the microphone after
	 * the client is gone. What this row guards is that resume order against the EOF path, not the
	 * background dispatch of `live_stop` and `live_mute`: with those two taken out of
	 * `BACKGROUND_COMMANDS` it still passes, because the held `live_start` resumes before the EOF
	 * path that follows `await inputRead`. The background move is locked by the shutdown case, the
	 * stop-during-connect case and the order row of the held-types case.
	 */
	test("a live_start read during startup leaves no live session running when stdin closes", async () => {
		const temp = await TempDir.create("@omp-rpc-startup-live-eof-");
		const child = spawnSlowStartupAgent(temp, HELD_HANDLER_MS, { OMP_LIVE_START_MS: String(LIVE_CONNECT_MS) });
		try {
			let recording = false;
			const answers = new Map<string, Record<string, unknown>>();
			const outputEnded = Promise.withResolvers<void>();
			void (async () => {
				for await (const frame of readJsonl<unknown>(child.stdout as ReadableStream<Uint8Array>)) {
					if (!isRecord(frame)) continue;
					if (frame.type === "ready") {
						child.stdin.write(
							`${[
								JSON.stringify({ type: "compact", id: "compact" }),
								JSON.stringify({ type: "live_stop", id: "stop" }),
								JSON.stringify({ type: "live_start", id: "start" }),
							].join("\n")}\n`,
						);
						await child.stdin.flush();
						// Closed behind the three: the agent reads them during startup and runs its EOF
						// path once startup is over.
						child.stdin.end();
						continue;
					}
					if (frame.type === "live_phase" && frame.phase === "listening") recording = true;
					if (typeof frame.id === "string") answers.set(frame.id, frame);
				}
				outputEnded.resolve();
			})().catch((readError: unknown) => {
				outputEnded.reject(readError);
			});
			await withTimeout(
				outputEnded.promise,
				EXIT_BUDGET_MS,
				"the agent did not close its output after stdin closed",
			);
			const exitCode = await withTimeout(child.exited, EXIT_BUDGET_MS, "the agent did not exit after stdin closed");
			expect(exitCode).toBe(0);

			// The EOF path stopped the bridge after the start had published its controller, so the
			// start was cancelled while connecting and no microphone opened.
			expect(recording).toBe(false);
			expect(answers.get("start")).toMatchObject({
				success: false,
				command: "live_start",
				error: "The live session stopped while connecting.",
			});
		} finally {
			child.kill();
			await child.exited;
			await temp.remove();
		}
	}, 120_000);
});
