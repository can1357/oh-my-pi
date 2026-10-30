export type ShadowOrigin =
	| { kind: "provider_literal" }
	| { kind: "persistent_state" }
	| { kind: "local_read"; resource: string };

export interface ShadowValue {
	readonly value: unknown;
	readonly origins: readonly ShadowOrigin[];
}

export type ShadowExpression =
	| { kind: "literal"; value: unknown }
	| { kind: "snapshot"; name: string }
	| { kind: "operation_result"; operationId: string }
	| { kind: "property"; target: ShadowExpression; property: string | number }
	| { kind: "array"; items: readonly ShadowExpression[] }
	| { kind: "object"; entries: ReadonlyArray<{ key: string; value: ShadowExpression }> }
	| { kind: "concat"; items: readonly ShadowExpression[] }
	| {
			kind: "transform";
			name: "String" | "JSON.stringify" | "Array.join" | "Python.str";
			input: ShadowExpression;
			argument?: ShadowExpression;
	  };

export interface ShadowSourceSpan {
	readonly start: number;
	readonly end: number;
}

export interface ShadowToolCall {
	readonly id: string;
	readonly siteId: string;
	readonly dynamicPath: readonly string[];
	readonly occurrence: number;
	readonly name: "read";
	readonly args: ShadowExpression;
	readonly dependencies: readonly string[];
	readonly controlDependencies: readonly string[];
	readonly sourceOrder: number;
	readonly span: ShadowSourceSpan;
}

export interface ShadowBarrier {
	readonly kind: "barrier";
	readonly reason: string;
	readonly span?: ShadowSourceSpan;
}

export interface ShadowOperation {
	readonly kind: "tool";
	readonly call: ShadowToolCall;
}

export interface ShadowJoin {
	readonly kind: "join";
	readonly id: string;
	readonly operationIds: readonly string[];
	readonly failureOrder: readonly string[];
	readonly span: ShadowSourceSpan;
}

export interface ShadowConditional {
	readonly kind: "conditional";
	readonly id: string;
	readonly test: ShadowExpression;
	readonly consequentPath: string;
	readonly alternatePath: string;
	readonly span: ShadowSourceSpan;
}

export interface ShadowLoop {
	readonly kind: "loop";
	readonly id: string;
	readonly iterable: ShadowExpression;
	readonly iterations: number;
	readonly span: ShadowSourceSpan;
}

export type ShadowControlNode = ShadowJoin | ShadowConditional | ShadowLoop;

export interface ShadowPlan {
	readonly operations: readonly ShadowOperation[];
	readonly controls?: readonly ShadowControlNode[];
	readonly barrier?: ShadowBarrier;
}

export interface ShadowEvaluationContext {
	readonly snapshot: Readonly<Record<string, ShadowValue | unknown>>;
	readonly results: ReadonlyMap<string, ShadowValue>;
}
