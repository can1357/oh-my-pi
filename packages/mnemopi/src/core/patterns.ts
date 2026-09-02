const UTF8_ENCODER = new TextEncoder();

export interface CompressionStatsInit {
	readonly originalSize?: number;
	readonly compressedSize?: number;
	readonly ratio?: number;
	readonly method?: string;
	readonly patternsFound?: number;
	readonly memoriesCompressed?: number;
}

export class CompressionStats {
	originalSize: number;
	compressedSize: number;
	ratio: number;
	method: string;
	patternsFound: number;
	memoriesCompressed: number;

	constructor(init: CompressionStatsInit = {}) {
		this.originalSize = init.originalSize ?? 0;
		this.compressedSize = init.compressedSize ?? 0;
		this.ratio = init.ratio ?? 0.0;
		this.method = init.method ?? "";
		this.patternsFound = init.patternsFound ?? 0;
		this.memoriesCompressed = init.memoriesCompressed ?? 0;
	}

	get savingsPercent(): number {
		if (this.originalSize === 0) return 0.0;
		return (1.0 - this.compressedSize / this.originalSize) * 100;
	}
}

export type MemoryRecord = Record<string, unknown> & {
	content?: string;
	timestamp?: string;
	created_at?: string;
	source?: string;
};

function utf8Size(value: string): number {
	return UTF8_ENCODER.encode(value).byteLength;
}

export class MemoryCompressor {
	readonly dictionary: Readonly<Record<string, string>>;

	constructor(dictionary?: Readonly<Record<string, string>>) {
		this.dictionary = dictionary ?? MemoryCompressor.buildDefaultDict();
	}

	static buildDefaultDict(): Record<string, string> {
		return {
			"remember that ": "",
			"the user said ": "",
			"the user asked ": "",
			"the user wants ": "",
			"conversation about ": "",
			"please note that ": "",
			"important: ": "",
			"user preference: ": "",
			"project context: ": "\t",
			"api key ": "\n",
			"token ": "\v",
			"session ": "\f",
			"mnemopi ": "\r",
		};
	}
	compress(content: string, method = "dict"): readonly [string, CompressionStats] {
		const originalSize = utf8Size(content);
		if (method === "auto") {
			let [compressed, stats] = this.dictCompress(content);
			if (stats.savingsPercent < 5) [compressed, stats] = this.rleCompress(content);
			return [compressed, stats];
		}

		if (method === "dict") return this.dictCompress(content);
		if (method === "rle") return this.rleCompress(content);
		if (method === "semantic") return this.semanticCompressSingle(content);
		return [
			content,
			new CompressionStats({
				originalSize,
				compressedSize: originalSize,
				ratio: 1.0,
				method: "none",
			}),
		];
	}

	private dictCompress(content: string): readonly [string, CompressionStats] {
		const originalSize = utf8Size(content);
		let compressed = content;
		for (const phrase in this.dictionary) {
			const token = this.dictionary[phrase];
			if (token === undefined) continue;
			compressed = compressed.replaceAll(phrase, token);
		}
		const compressedSize = utf8Size(compressed);
		const ratio = originalSize > 0 ? compressedSize / originalSize : 1.0;
		return [compressed, new CompressionStats({ originalSize, compressedSize, ratio, method: "dict" })];
	}

	private rleCompress(content: string): readonly [string, CompressionStats] {
		const originalSize = utf8Size(content);
		if (content.length === 0) {
			return [content, new CompressionStats({ originalSize: 0, compressedSize: 0, ratio: 1.0, method: "rle" })];
		}

		const compressed: string[] = [];
		let count = 1;
		for (let i = 1; i < content.length; i++) {
			if (content[i] === content[i - 1] && count < 255) {
				count++;
			} else {
				const prev = content[i - 1] ?? "";
				compressed.push(count > 3 ? `[${prev}*${count}]` : content.slice(i - count, i));
				count = 1;
			}
		}
		const last = content[content.length - 1] ?? "";
		compressed.push(count > 3 ? `[${last}*${count}]` : content.slice(content.length - count));
		const compressedString = compressed.join("");
		const compressedSize = utf8Size(compressedString);
		const ratio = originalSize > 0 ? compressedSize / originalSize : 1.0;
		return [compressedString, new CompressionStats({ originalSize, compressedSize, ratio, method: "rle" })];
	}

	private semanticCompressSingle(content: string): readonly [string, CompressionStats] {
		const originalSize = utf8Size(content);
		const compressed = originalSize > 500 ? `${content.slice(0, 250)} [...] ${content.slice(-100)}` : content;
		const compressedSize = utf8Size(compressed);
		const ratio = originalSize > 0 ? compressedSize / originalSize : 1.0;
		return [compressed, new CompressionStats({ originalSize, compressedSize, ratio, method: "semantic" })];
	}

	compressBatch(memories: readonly MemoryRecord[], method = "auto"): readonly [MemoryRecord[], CompressionStats] {
		let totalOriginal = 0;
		let totalCompressed = 0;
		const compressedMemories: MemoryRecord[] = [];
		for (const mem of memories) {
			const content = typeof mem.content === "string" ? mem.content : "";
			const [compressed, stats] = this.compress(content, method);
			totalOriginal += stats.originalSize;
			totalCompressed += stats.compressedSize;
			compressedMemories.push({
				...mem,
				content: compressed,
				_compressed: true,
				_compression_method: stats.method,
			});
		}
		const ratio = totalOriginal > 0 ? totalCompressed / totalOriginal : 1.0;
		return [
			compressedMemories,
			new CompressionStats({
				originalSize: totalOriginal,
				compressedSize: totalCompressed,
				ratio,
				method,
				memoriesCompressed: memories.length,
			}),
		];
	}
	decompress(content: string, method = "dict"): string {
		if (method === "dict") {
			let decompressed = content;
			for (const phrase in this.dictionary) {
				const token = this.dictionary[phrase];
				if (token === undefined || token.length === 0) continue;
				decompressed = decompressed.replaceAll(token, phrase);
			}
			return decompressed;
		}
		if (method === "rle") {
			return content.replace(/\[(.)\*(\d+)\]/g, (_match, char: string, count: string) =>
				char.repeat(Number.parseInt(count, 10)),
			);
		}
		return content;
	}
}

export interface DetectedPatternInit {
	readonly patternType?: string;
	readonly pattern_type?: string;
	readonly description: string;
	readonly confidence: number;
	readonly samples?: readonly string[];
	readonly metadata?: Record<string, unknown>;
}

export class DetectedPattern {
	patternType: string;
	description: string;
	confidence: number;
	samples: string[];
	metadata: Record<string, unknown>;

	constructor(init: DetectedPatternInit) {
		this.patternType = init.patternType ?? init.pattern_type ?? "";
		this.description = init.description;
		this.confidence = init.confidence;
		this.samples = [...(init.samples ?? [])];
		this.metadata = { ...init.metadata };
	}

	toDict(): Record<string, unknown> {
		return {
			pattern_type: this.patternType,
			description: this.description,
			confidence: this.confidence,
			samples: [...this.samples],
			metadata: { ...this.metadata },
		};
	}
}

function increment<K>(counter: Map<K, number>, key: K): void {
	counter.set(key, (counter.get(key) ?? 0) + 1);
}

function mostCommon<K>(counter: Map<K, number>, limit: number): Array<readonly [K, number]> {
	return Array.from(counter.entries())
		.sort((left, right) => right[1] - left[1])
		.slice(0, limit);
}

const CONTENT_STOPWORDS = new Set([
	"about",
	"after",
	"before",
	"being",
	"could",
	"doing",
	"every",
	"having",
	"might",
	"other",
	"should",
	"their",
	"there",
	"these",
	"those",
	"through",
	"under",
	"where",
	"which",
	"while",
	"would",
	"mnemopi",
	"memory",
	"memories",
]);

function contentOf(memory: MemoryRecord): string {
	return typeof memory.content === "string" ? memory.content : "";
}

function sourceOf(memory: MemoryRecord): string {
	return typeof memory.source === "string" ? memory.source : "unknown";
}

function timestampOf(memory: MemoryRecord): string | undefined {
	if (typeof memory.timestamp === "string" && memory.timestamp.length > 0) return memory.timestamp;
	if (typeof memory.created_at === "string" && memory.created_at.length > 0) return memory.created_at;
	return undefined;
}

function isoSample(date: Date): string {
	return date.toISOString();
}

export class PatternDetector {
	readonly minConfidence: number;

	constructor(minConfidence = 0.6) {
		this.minConfidence = minConfidence;
	}

	detectTemporal(memories: readonly MemoryRecord[]): DetectedPattern[] {
		const patterns: DetectedPattern[] = [];
		const timestamps: Date[] = [];
		for (const mem of memories) {
			const ts = timestampOf(mem);
			if (ts === undefined) continue;
			const date = new Date(ts.replace("Z", "+00:00"));
			if (!Number.isNaN(date.getTime())) timestamps.push(date);
		}
		if (timestamps.length < 3) return patterns;

		const hourCounts = new Map<number, number>();
		for (const timestamp of timestamps) increment(hourCounts, timestamp.getHours());
		const total = timestamps.length;
		for (const [hour, count] of mostCommon(hourCounts, 3)) {
			const confidence = count / total;
			if (confidence >= this.minConfidence) {
				patterns.push(
					new DetectedPattern({
						patternType: "temporal",
						description: `Memories frequently created at ${hour.toString().padStart(2, "0")}:00 (${count}/${total} times)`,
						confidence,
						samples: timestamps
							.filter(timestamp => timestamp.getHours() === hour)
							.slice(0, 3)
							.map(isoSample),
						metadata: { hour, count, total },
					}),
				);
			}
		}

		const dayNames = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;
		const dayCounts = new Map<number, number>();
		for (const timestamp of timestamps) increment(dayCounts, (timestamp.getDay() + 6) % 7);
		for (const [day, count] of mostCommon(dayCounts, 2)) {
			const confidence = count / total;
			const dayName = dayNames[day];
			if (dayName !== undefined && confidence >= this.minConfidence) {
				patterns.push(
					new DetectedPattern({
						patternType: "temporal",
						description: `Memories frequently created on ${dayName} (${count}/${total} times)`,
						confidence,
						samples: timestamps
							.filter(timestamp => (timestamp.getDay() + 6) % 7 === day)
							.slice(0, 3)
							.map(isoSample),
						metadata: { day: dayName, count, total },
					}),
				);
			}
		}
		return patterns;
	}
	detectContent(memories: readonly MemoryRecord[]): DetectedPattern[] {
		const patterns: DetectedPattern[] = [];
		const allText = memories.map(contentOf).join(" ");
		const words = Array.from(allText.toLowerCase().matchAll(/\b[a-zA-Z]{5,}\b/g), match => match[0]).filter(
			word => !CONTENT_STOPWORDS.has(word),
		);
		const wordCounts = new Map<string, number>();
		for (const word of words) increment(wordCounts, word);
		const totalWords = words.length;
		for (const [word, count] of mostCommon(wordCounts, 5)) {
			const confidence = Math.min(1.0, count / Math.max(3, totalWords * 0.05));
			if (count >= 2 && confidence >= this.minConfidence) {
				patterns.push(
					new DetectedPattern({
						patternType: "content",
						description: `Frequent topic: '${word}' appears ${count} times`,
						confidence,
						samples: memories
							.filter(mem => contentOf(mem).toLowerCase().includes(word))
							.slice(0, 3)
							.map(contentOf),
						metadata: { word, count },
					}),
				);
			}
		}

		if (memories.length >= 3) {
			const cooccurrence = new Map<string, number>();
			const pairWords = new Map<string, readonly [string, string]>();
			for (const mem of memories) {
				const memWords = new Set(
					Array.from(
						contentOf(mem)
							.toLowerCase()
							.matchAll(/\b[a-zA-Z]{5,}\b/g),
						match => match[0],
					).filter(word => !CONTENT_STOPWORDS.has(word)),
				);
				for (const w1 of memWords) {
					for (const w2 of memWords) {
						if (w1 >= w2) continue;
						const key = `${w1}\u0000${w2}`;
						pairWords.set(key, [w1, w2]);
						increment(cooccurrence, key);
					}
				}
			}
			for (const [key, count] of mostCommon(cooccurrence, 3)) {
				const pair = pairWords.get(key);
				if (pair === undefined) continue;
				const [w1, w2] = pair;
				const confidence = Math.min(1.0, count / memories.length);
				if (count >= 2 && confidence >= this.minConfidence) {
					patterns.push(
						new DetectedPattern({
							patternType: "content",
							description: `Co-occurring topics: '${w1}' + '${w2}' appear together ${count} times`,
							confidence,
							samples: memories
								.filter(mem => {
									const content = contentOf(mem).toLowerCase();
									return content.includes(w1) && content.includes(w2);
								})
								.slice(0, 3)
								.map(contentOf),
							metadata: { word1: w1, word2: w2, count },
						}),
					);
				}
			}
		}
		return patterns;
	}
	detectSequence(memories: readonly MemoryRecord[]): DetectedPattern[] {
		const patterns: DetectedPattern[] = [];
		if (memories.length < 3) return patterns;
		const sortedMems = memories
			.filter(mem => typeof mem.timestamp === "string" && mem.timestamp.length > 0)
			.sort((left, right) => String(left.timestamp).localeCompare(String(right.timestamp)));
		const sources = sortedMems.map(sourceOf);
		const pairCounts = new Map<string, number>();
		const pairSources = new Map<string, readonly [string, string]>();
		for (let i = 0; i < sources.length - 1; i++) {
			const s1 = sources[i];
			const s2 = sources[i + 1];
			if (s1 === undefined || s2 === undefined) continue;
			const key = `${s1}\u0000${s2}`;
			pairSources.set(key, [s1, s2]);
			increment(pairCounts, key);
		}
		for (const [key, count] of mostCommon(pairCounts, 3)) {
			const pair = pairSources.get(key);
			if (pair === undefined) continue;
			const [s1, s2] = pair;
			const confidence = Math.min(1.0, count / Math.max(2, sources.length - 1));
			if (count >= 2 && confidence >= this.minConfidence) {
				const samples: string[] = [];
				for (let i = 0; i < sources.length - 1; i++) {
					if (sources[i] === s1 && sources[i + 1] === s2) {
						const first = sortedMems[i];
						const second = sortedMems[i + 1];
						if (first !== undefined && second !== undefined) {
							samples.push(`${contentOf(first).slice(0, 50)}... -> ${contentOf(second).slice(0, 50)}...`);
						}
						if (samples.length >= 2) break;
					}
				}
				patterns.push(
					new DetectedPattern({
						patternType: "sequence",
						description: `Sequence pattern: '${s1}' often followed by '${s2}' (${count} times)`,
						confidence,
						samples,
						metadata: { source1: s1, source2: s2, count },
					}),
				);
			}
		}
		return patterns;
	}
	detectAll(memories: readonly MemoryRecord[]): DetectedPattern[] {
		const patterns = [
			...this.detectTemporal(memories),
			...this.detectContent(memories),
			...this.detectSequence(memories),
		];
		patterns.sort((left, right) => right.confidence - left.confidence);
		return patterns;
	}
	summarizePatterns(memories: readonly MemoryRecord[]): Record<string, unknown> {
		const patterns = this.detectAll(memories);
		return {
			total_memories: memories.length,
			patterns_found: patterns.length,
			temporal_patterns: patterns
				.filter(pattern => pattern.patternType === "temporal")
				.map(pattern => pattern.toDict()),
			content_patterns: patterns
				.filter(pattern => pattern.patternType === "content")
				.map(pattern => pattern.toDict()),
			sequence_patterns: patterns
				.filter(pattern => pattern.patternType === "sequence")
				.map(pattern => pattern.toDict()),
			top_pattern: patterns[0]?.toDict() ?? null,
		};
	}
}
