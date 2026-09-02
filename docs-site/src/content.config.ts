import { defineCollection, z } from 'astro:content';
import { docsLoader } from '@astrojs/starlight/loaders';
import { docsSchema } from '@astrojs/starlight/schema';

export const collections = {
	docs: defineCollection({
		loader: docsLoader(),
		schema: docsSchema({
			extend: z.object({
				/** Documentation coverage ranking: A high, B medium, C low. Rendered as a badge by the PageTitle override. */
				coverage: z.enum(['A', 'B', 'C']).optional(),
			}),
		}),
	}),
};
