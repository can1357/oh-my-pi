export type QueryIntentCategory = "temporal" | "factual" | "entity" | "preference" | "procedural" | "general";

export interface QueryIntent {
	readonly category: QueryIntentCategory;
	readonly confidence: number;
	readonly signals: QueryIntentCategory[];
	readonly vec_bias: number;
	readonly fts_bias: number;
	readonly importance_bias: number;
}

export interface IntentWeights {
	readonly vec_bias: number;
	readonly fts_bias: number;
	readonly importance_bias: number;
}

type IntentPatternGroup = readonly [QueryIntentCategory, readonly RegExp[]];

export const INTENT_PATTERNS: readonly IntentPatternGroup[] = [
	[
		"temporal",
		[
			/\b(when|last|yesterday|today|tomorrow|ago|before|after|since|until|during|recently|lately)\b/,
			/\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
			/\b(january|february|march|april|may|june|july|august|september|october|november|december)\b/,
			/\b\d{4}-\d{2}-\d{2}\b/,
			/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/,
			/\b(this|next|last)\s+(week|month|year|monday|tuesday|wednesday|thursday|friday|saturday|sunday)\b/,
			/\b\d+\s+(day|week|month|year|hour|minute)s?\s+(ago|from now|later|earlier)\b/,
		],
	],
	[
		"factual",
		[
			/\bwhat\s+is\b/,
			/\bwho\s+is\b/,
			/\bwhere\s+is\b/,
			/\b(definition|define|explain|meaning)\b/,
			/\bhow\s+(many|much|long|far)\b/,
		],
	],
	[
		"entity",
		[
			/\b(tell\s+me\s+about|what\s+do\s+you\s+know\s+about)\b/,
			/\b(who\s+is|what\s+does)\s+[a-z]+\b/,
			/\b(about|regarding|concerning)\s+[a-z]+\b/,
		],
	],
	[
		"preference",
		[
			/\b(prefer|like|dislike|want|hate|love|enjoy|favorite|best|worst)\b/,
			/\b(should\s+i|would\s+you|do\s+you\s+recommend)\b/,
			/\b(choose|pick|select|option|choice|decide)\b/,
		],
	],
	[
		"procedural",
		[
			/\bhow\s+(to|do|can|should|would)\b/,
			/\b(step|process|procedure|workflow|guide|tutorial)\b/,
			/\b(setup|install|configure|build|deploy|run|execute|start|stop)\b/,
		],
	],
] as const;

export const INTENT_WEIGHTS: Record<QueryIntentCategory, IntentWeights> = {
	temporal: { vec_bias: 0.6, fts_bias: 1.5, importance_bias: 0.8 },
	factual: { vec_bias: 1.0, fts_bias: 1.2, importance_bias: 0.9 },
	entity: { vec_bias: 1.1, fts_bias: 1.0, importance_bias: 1.3 },
	preference: { vec_bias: 0.9, fts_bias: 0.8, importance_bias: 1.5 },
	procedural: { vec_bias: 1.3, fts_bias: 0.9, importance_bias: 0.7 },
	general: { vec_bias: 1.0, fts_bias: 1.0, importance_bias: 1.0 },
};

export function classifyIntent(query: string): QueryIntent {
	const queryLower = query.toLowerCase();
	let bestIntent: QueryIntentCategory = "general";
	let bestScore = 0.0;
	const signals: QueryIntentCategory[] = [];

	for (const [category, patterns] of INTENT_PATTERNS) {
		let matches = 0;
		for (const pattern of patterns) {
			if (pattern.test(queryLower)) {
				matches += 1;
				signals.push(category);
			}
		}

		if (matches > 0) {
			const score = Math.min(0.3 + matches * 0.15, 1.0);
			if (score > bestScore) {
				bestScore = score;
				bestIntent = category;
			}
		}
	}

	const weights = INTENT_WEIGHTS[bestIntent];
	return {
		category: bestIntent,
		confidence: bestScore,
		signals,
		vec_bias: weights.vec_bias,
		fts_bias: weights.fts_bias,
		importance_bias: weights.importance_bias,
	};
}

export function adjustWeights(
	baseVec = 0.5,
	baseFts = 0.3,
	baseImportance = 0.2,
	intent: QueryIntent | null = null,
): [number, number, number] {
	const resolvedIntent = intent ?? {
		category: "general",
		confidence: 0.0,
		signals: [],
		vec_bias: 1.0,
		fts_bias: 1.0,
		importance_bias: 1.0,
	};
	let vecWeight = baseVec * resolvedIntent.vec_bias;
	let ftsWeight = baseFts * resolvedIntent.fts_bias;
	let importanceWeight = baseImportance * resolvedIntent.importance_bias;

	const total = vecWeight + ftsWeight + importanceWeight;
	if (total > 0) {
		vecWeight /= total;
		ftsWeight /= total;
		importanceWeight /= total;
	}

	return [vecWeight, ftsWeight, importanceWeight];
}
