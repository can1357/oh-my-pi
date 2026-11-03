/** Consumer exports must emit declarations without private omptype type names. */
import { type } from "@oh-my-pi/omptype";
import { type as arkType } from "@oh-my-pi/omptype/ark";
import { type as subpathType } from "@oh-my-pi/omptype/type";
import { Type as TypeBox } from "@oh-my-pi/omptype/typebox";
import { z } from "@oh-my-pi/omptype/zod";

export const stringSchema = type("string");
export const user = type({ id: "number", name: "string" });
export const keys = user.keyof();
export function makeSchema() {
	return type("boolean");
}

// Callable members and tuple elements also become part of inferred public APIs.
export const pipe = stringSchema.pipe;
export const optional = stringSchema.optional();
export const keyofMethod = user.keyof;
export const fnFactory = type.fn("string");
export const arkSchema = arkType({ id: "number" });
export const subpathSchema = subpathType({ id: "number" });
export const typeboxSchema = TypeBox.Object({ id: TypeBox.Number() });
export const zodSchema = z.object({ id: z.number() });
export const zodOptional = z.string().optional();
export const zodRefine = zodSchema.refine;
