/**
 * Two nominally distinct views of one tool call's arguments.
 *
 * A host may transform validated arguments before execution — `coding-agent`
 * clamps `timeout` and, load-bearingly, **deobfuscates secret placeholders** so
 * the process actually receives the credential the model never saw. That
 * transformed object is the one the tool executes with and the one route
 * selection must judge, because a transform can flip `pty`/`async`/`timeout`
 * and thereby change the route.
 *
 * It is also the object that must never reach a client surface. The legacy
 * `tool_execution_start` event already publishes the *pre-transform* arguments;
 * the presentation adapter's `start()` used to receive the transformed ones and
 * bash copied `params.command` straight into `title` and `rawInput`, so a
 * `$$SECRET$$` placeholder the model wrote came back out of the ACP wire as
 * plaintext.
 *
 * Redacting one field in one tool would leave the next adapter free to repeat
 * it, so the distinction is nominal rather than documentary: the two aliases
 * carry disjoint brands, both erase to the plain input type, and neither is
 * assignable to the other. An adapter's `start()` can only ever be handed
 * {@link PublicToolArguments}; there is no in-scope value it could accidentally
 * read the deobfuscated command from.
 *
 * ## Ownership model
 *
 * Public and execution views never share a mutable object graph. The agent loop
 * deep-clones the validated arguments before branding them as execution
 * arguments, so a `selects()` or transform that mutates `params.nested.value`
 * corrupts only its own copy — never the public object that `start()`,
 * `tool_execution_start`, and `tool_execution_update` all read. The clone uses
 * `structuredClone`, not JSON parse/stringify, because arguments are
 * model-authored JSON values (no functions, Dates, or other non-JSON types).
 *
 * Both brands are deeply readonly at the type level: a `selects()` or `start()`
 * implementation cannot assign `params.command` or `params.nested.value` without
 * a `ts-expect-error`. The mutable copy reaches only `execute()`, which owns it.
 */

declare const publicToolArgumentsBrand: unique symbol;
declare const executionToolArgumentsBrand: unique symbol;

/**
 * Recursively freeze every property of `T` at the type level.
 *
 * Arrays become `ReadonlyArray`, objects get `readonly` keys, and primitives
 * pass through unchanged. The brand property is already `readonly` and is
 * intersected separately, so this never touches it.
 */
export type DeepReadonly<T> =
	T extends ReadonlyArray<infer U>
		? ReadonlyArray<DeepReadonly<U>>
		: T extends object
			? { readonly [K in keyof T]: DeepReadonly<T[K]> }
			: T;

/**
 * Arguments safe to publish to any client surface: the validated arguments as
 * the model wrote them, before any host transform. Deeply readonly: an adapter
 * that only inspects arguments (like {@link ToolPresentationAdapter.start})
 * cannot mutate them at the type level.
 */
export type PublicToolArguments<TInput> = DeepReadonly<TInput> & { readonly [publicToolArgumentsBrand]: true };

/**
 * Arguments the tool actually runs with: post-transform, and therefore possibly
 * carrying deobfuscated secrets. Route selection and `execute` use these; no
 * display, title, echo or `rawInput` may. Deeply readonly when handed to an
 * adapter that only inspects arguments (like {@link ToolPresentationAdapter.selects}).
 */
export type ExecutionToolArguments<TInput> = DeepReadonly<TInput> & { readonly [executionToolArgumentsBrand]: true };

/**
 * Mint public arguments. The agent loop is the only legitimate caller, and only
 * from the arguments it holds *before* applying `transformToolCallArguments`.
 */
export function publicToolArguments<TInput>(args: TInput): PublicToolArguments<TInput> {
	return args as PublicToolArguments<TInput>;
}

/**
 * Mint execution arguments. The agent loop is the only legitimate caller, and
 * only from the arguments it is about to pass to `selects` or `execute`.
 */
export function executionToolArguments<TInput>(args: TInput): ExecutionToolArguments<TInput> {
	return args as ExecutionToolArguments<TInput>;
}
