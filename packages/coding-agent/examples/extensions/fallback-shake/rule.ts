interface ModelIdentity {
	provider: string;
	id: string;
}

interface FallbackObservation {
	agentKind: "main" | "sub";
	target?: "advisor";
	from: ModelIdentity | undefined;
	to: ModelIdentity | undefined;
	current: ModelIdentity | undefined;
}

/** Effort and upstream routing are not model identity changes. */
export function shouldShakeFallback(observation: FallbackObservation): boolean {
	const { agentKind, target, from, to, current } = observation;
	return (
		agentKind === "main" &&
		target !== "advisor" &&
		from !== undefined &&
		to !== undefined &&
		current !== undefined &&
		(to.provider !== from.provider || to.id !== from.id) &&
		to.provider === current.provider &&
		to.id === current.id
	);
}
