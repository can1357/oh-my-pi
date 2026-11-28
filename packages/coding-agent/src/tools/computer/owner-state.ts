import type { ComputerController } from "./supervisor";

const ownedSupervisors = new Map<string, Set<ComputerController>>();
/** Per owner with agent turns: the turn in flight, or between turns the one that ended last, counted from 1. */
const ownerTurns = new Map<string, { turn: number; inFlight: boolean }>();

/** Registers a controller for owner-scoped session cleanup. */
export function registerComputerController(ownerId: string | undefined, controller: ComputerController): () => void {
	if (!ownerId) return () => {};
	const controllers = ownedSupervisors.get(ownerId) ?? new Set<ComputerController>();
	controllers.add(controller);
	ownedSupervisors.set(ownerId, controllers);
	return () => {
		controllers.delete(controller);
		if (controllers.size === 0) ownedSupervisors.delete(ownerId);
	};
}

/** Revoke task-scoped foreground ownership without resetting frames or the worker. */
export async function revokeComputerControlForOwner(ownerId: string | undefined): Promise<void> {
	if (!ownerId) return;
	await Promise.allSettled(
		Array.from(ownedSupervisors.get(ownerId) ?? [], controller => controller.revokeControl?.()),
	);
}

/**
 * An agent session's turn began, or went on after the user answered a dialog: computer runs keep the display awake
 * until {@link endComputerTurnForOwner}.
 */
export function beginComputerTurnForOwner(ownerId: string | undefined): void {
	if (!ownerId) return;
	const state = ownerTurns.get(ownerId);
	ownerTurns.set(ownerId, { turn: (state?.turn ?? 0) + 1, inFlight: true });
}

/**
 * The turn ended or stopped to wait for the user's answer: let the display sleep now instead of a grace period later.
 * Nothing else ends with the turn; its next computer request after the answer, or the next turn's first, holds the
 * display again.
 */
export function endComputerTurnForOwner(ownerId: string | undefined): void {
	const state = ownerId ? ownerTurns.get(ownerId) : undefined;
	if (!ownerId || !state?.inFlight) return;
	state.inFlight = false;
	for (const controller of ownedSupervisors.get(ownerId) ?? []) controller.releaseDisplay?.(state.turn);
}

/**
 * The turn went on after the dialog that ended it settled: later runs hold the display until the turn ends, and so
 * does a run of the turn that is still active, such as one whose control confirmation the dialog was.
 */
export function resumeComputerTurnForOwner(ownerId: string | undefined): void {
	const state = ownerId ? ownerTurns.get(ownerId) : undefined;
	if (!ownerId || !state || state.inFlight) return;
	const from = state.turn;
	state.turn = from + 1;
	state.inFlight = true;
	for (const controller of ownedSupervisors.get(ownerId) ?? []) controller.resumeDisplay?.(from, state.turn);
}

/**
 * The owner's agent turn in flight, if any. Without one (between turns, while a dialog waits for the user, in a
 * subagent, or SDK and eval use with no agent session), a computer run keeps the native grace period.
 */
export function computerTurnInFlight(ownerId: string | undefined): number | undefined {
	const state = ownerId ? ownerTurns.get(ownerId) : undefined;
	return state?.inFlight ? state.turn : undefined;
}

/** The user's next message lifts the refusal their Escape set on an agent session's computer use. */
export function resumeComputerUseForOwner(ownerId: string | undefined): void {
	if (!ownerId) return;
	for (const controller of ownedSupervisors.get(ownerId) ?? []) controller.resumeAfterEscape?.();
}

/** Closes every computer session owned by an agent session. */
export async function releaseComputerSessionsForOwner(ownerId: string | undefined): Promise<void> {
	if (!ownerId) return;
	ownerTurns.delete(ownerId);
	const controllers = ownedSupervisors.get(ownerId);
	if (!controllers) return;
	ownedSupervisors.delete(ownerId);
	await Promise.allSettled(Array.from(controllers, controller => controller.close()));
}
