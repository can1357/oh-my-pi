import {
	type ByteOffset,
	byteOffset,
	type FactId,
	factId,
	type NonZeroExitCode,
	nonZeroExitCode,
	type StreamId,
	streamId,
	type ToolExecutionId,
	toolExecutionId,
} from "@oh-my-pi/pi-agent-core/presentation";
import { z } from "zod";

/**
 * Zod schemas that mint the branded identities in
 * `@oh-my-pi/pi-agent-core/presentation`'s `brands.ts` from persisted/external
 * input.
 *
 * Each brand symbol there is module-private, so this file cannot forge a
 * `StreamId`/`ByteOffset`/`FactId`/`ToolExecutionId`/`NonZeroExitCode` by
 * casting — every schema below validates the precondition the real constructor
 * enforces and then calls that constructor, so an invalid persisted value fails
 * `safeParse` instead of throwing past it (the constructors throw on a bad
 * input, which a bare `.transform(streamId)` would let escape as an unhandled
 * exception instead of a parse failure).
 */

export const streamIdSchema = z
	.string()
	.min(1)
	.transform((value): StreamId => streamId(value));

export const byteOffsetSchema = z
	.number()
	.int()
	.nonnegative()
	.transform((value): ByteOffset => byteOffset(value));

export const factIdSchema = z
	.string()
	.min(1)
	.transform((value): FactId => factId(value));

export const toolExecutionIdSchema = z
	.string()
	.min(1)
	.transform((value): ToolExecutionId => toolExecutionId(value));

export const nonZeroExitCodeSchema = z
	.number()
	.int()
	.refine((value): value is number => value !== 0, "exit code must not be 0")
	.transform((value): NonZeroExitCode => nonZeroExitCode(value));
