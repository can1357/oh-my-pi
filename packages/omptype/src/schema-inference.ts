/** Inference-only slot for a schema's possible structural keys. */
export declare const schemaKeys: unique symbol;

/** Inference-only slot for facts retained by a concrete schema. */
export declare const schemaFacts: unique symbol;

declare const acceptance: unique symbol;

/** Invariant evidence of a complete, statically representable validator domain. */
export interface SchemaAcceptance<in out value> {
	readonly [acceptance]: (value: value) => value;
}

/** Covariant concrete-schema facts that an ordinary schema annotation can erase. */
export interface SchemaFacts<
	out requiredOut = unknown,
	out requiredIn = unknown,
	out outKeys extends PropertyKey = PropertyKey,
	out accepted = unknown,
	out outRequired = requiredOut,
> {
	readonly requiredOut: requiredOut;
	readonly requiredIn: requiredIn;
	readonly outKeys: outKeys;
	readonly accepted: accepted;
	readonly outRequired: outRequired;
}
