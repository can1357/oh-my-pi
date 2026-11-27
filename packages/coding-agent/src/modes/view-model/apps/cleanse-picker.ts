/** Selected checker scope or free-form repair request. */
export type CleanseTargetChoice =
	| { kind: "all" }
	| { kind: "checker"; id: string }
	| { kind: "request"; request: string }
	| { kind: "cancel" };
