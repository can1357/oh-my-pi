import { z } from "zod";

/**
 * Runtime schemas for the two content-block shapes a tool result may carry.
 *
 * Deliberately mirrors `TextContent`/`ImageContent` from `@oh-my-pi/pi-ai`
 * *structurally* rather than importing them: this module is inside the strict
 * presentation project, whose whole value is that its import graph is the owned
 * boundary and nothing else. `test/presentation-schemas.test.ts` pins the
 * structural parity in both directions, so a rename upstream fails the type
 * check instead of silently drifting.
 */

export const textContentSchema = z.strictObject({
	type: z.literal("text"),
	text: z.string(),
	textSignature: z.string().optional(),
});

export const imageContentSchema = z.strictObject({
	type: z.literal("image"),
	data: z.string(),
	mimeType: z.string(),
	detail: z.enum(["auto", "low", "high", "original"]).optional(),
});

export const toolContentBlockSchema = z.union([textContentSchema, imageContentSchema]);

export type PresentationTextContent = z.infer<typeof textContentSchema>;
export type PresentationImageContent = z.infer<typeof imageContentSchema>;
export type PresentationContentBlock = z.infer<typeof toolContentBlockSchema>;
