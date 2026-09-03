/**
 * Arktype schema for the `edit` tool's hashline mode payload. The schema is
 * deliberately permissive (allows extra keys) so providers can attach extra
 * keys without rejection; only `input` is required.
 */
import { type } from "@oh-my-pi/omptype";

export const hashlineEditParamsSchema = type({
	input: "string",
});

export type HashlineParams = typeof hashlineEditParamsSchema.infer;
