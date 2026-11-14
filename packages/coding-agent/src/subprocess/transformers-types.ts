/** Download and model-readiness notifications emitted by Transformers.js. */
export type ProgressInfo =
	| { status: "initiate" | "download" | "done"; name: string; file: string }
	| { status: "progress"; name: string; file: string; progress: number; loaded: number; total: number }
	| {
			status: "progress_total";
			name: string;
			progress: number;
			loaded: number;
			total: number;
			files: Record<string, { loaded: number; total: number }>;
	  }
	| { status: "ready"; task: string; model: string };

/** Decoded Whisper transcription surface used by the speech worker. */
export interface AutomaticSpeechRecognitionOutput {
	text: string;
}

/** Audio-only Whisper pipeline surface used by the speech worker. */
export interface AutomaticSpeechRecognitionPipeline {
	(audio: Float32Array, options: Record<string, unknown>): Promise<AutomaticSpeechRecognitionOutput>;
}

/** Token decoding and chat-template rendering used by tiny text generation. */
export interface TextTokenizer {
	decode(tokens: number[], options: { skip_special_tokens: boolean; clean_up_tokenization_spaces: boolean }): string;
	get_chat_template(): string;
	apply_chat_template(
		messages: { role: string; content: string }[],
		options: {
			chat_template?: string;
			add_generation_prompt: boolean;
			tokenize: false;
			enable_thinking: boolean;
		},
	): string;
}

/** Batch stopping predicate implemented by the tiny worker's stop-text matcher. */
export interface StoppingCriteria {
	_call(inputIds: number[][], scores: number[][]): boolean[];
}

/** Text-only pipeline output used by tiny chat requests. */
export type TextGenerationStringOutput = { generated_text: string }[];

/** Text-generation pipeline surface used by the tiny worker. */
export interface TextGenerationPipeline {
	(text: string, options: Record<string, unknown>): Promise<TextGenerationStringOutput>;
	tokenizer: TextTokenizer;
}

/** PCM audio and sample rate returned by Kokoro synthesis. */
export interface RawAudio {
	audio: Float32Array | Float32Array[];
	sampling_rate: number;
}
