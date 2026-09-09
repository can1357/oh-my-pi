/**
 * Image limits test suite
 *
 * Tests provider-specific image limitations:
 * - Maximum number of images in a context (with small 100x100 images)
 * - Maximum image size (bytes)
 * - Maximum image dimensions
 * - Maximum payload (realistic large images stress test)
 *
 * ============================================================================
 * DISCOVERED LIMITS (Dec 2025):
 * ============================================================================
 *
 * BASIC LIMITS (small images):
 * | Provider    | Model              | Max Images | Max Size | Max Dim  |
 * |-------------|--------------------|------------|----------|----------|
 * | Anthropic   | claude-haiku-4-5   | 100        | 5MB      | 8000px   |
 * | OpenAI      | gpt-4o-mini        | 500        | ≥25MB    | ≥20000px |
 * | Gemini      | gemini-2.5-flash   | ~2000*     | ≥40MB    | 8000px   |
 * | Mistral     | pixtral-12b        | 8          | ~15MB    | 8000px   |
 * | xAI         | grok-2-vision      | ≥100       | 25MB     | 8000px   |
 * | Groq        | llama-4-scout-17b  | 5          | ~5MB     | ~5760px**|
 * | zAI         | glm-4.5v           | ***        | ≥20MB    | 8000px   |
 * | OpenRouter  | z-ai/glm-4.5v      | ***        | ~10MB    | ≥20000px |
 *
 * REALISTIC PAYLOAD LIMITS (large images):
 * | Provider    | Image Size | Max Count | Total Payload | Limit Hit          |
 * |-------------|------------|-----------|---------------|---------------------|
 * | Anthropic   | ~3MB       | 6         | ~18MB         | Request too large   |
 * | OpenAI      | ~15MB      | 2         | ~30MB         | Generic error       |
 * | Gemini      | ~20MB      | 10        | ~200MB        | String length       |
 * | Mistral     | ~10MB      | 4         | ~40MB         | 413 Payload too large|
 * | xAI         | ~20MB      | 1         | ~20MB         | 413 Entity too large|
 * | Groq        | 5760px     | 5         | N/A           | 5 image limit       |
 * | zAI         | ~15MB      | 2         | ~30MB         | 50MB request limit  |
 * | OpenRouter  | ~5MB       | 2         | ~10MB         | Provider error      |
 *
 * Notes:
 * - Anthropic: 100 image hard limit, 5MB per image, but ~18MB total request
 *   limit in practice (32MB documented but hit limit at ~24MB).
 * - OpenAI: 500 image limit but total payload limited to ~30-45MB.
 * - Gemini: * Very permissive. 10 x 20MB = 200MB worked!
 * - Mistral: 8 images max, ~40MB total payload.
 * - xAI: 25MB per image but strict request size limit (~20MB total).
 * - Groq: ** Most restrictive. 5 images max, 33177600 pixels max (≈5760x5760).
 * - zAI: 50MB request limit (explicit in error message).
 * - OpenRouter: *** Context-window limited (65536 tokens).
 *
 * ============================================================================
 * PRACTICAL RECOMMENDATIONS FOR CODING AGENTS:
 * ============================================================================
 *
 * Conservative cross-provider safe limits:
 * - Max 2 images per request at ~5MB each (~10MB total)
 * - Max 5760px dimension (for Groq pixel limit)
 *
 * If excluding Groq:
 * - Max 4 images per request at ~5MB each (~20MB total)
 * - Max 8000px dimension
 *
 * For Anthropic-only (most common case):
 * - Max 6 images at ~3MB each OR 100 images at <200KB each
 * - Max 5MB per image
 * - Max 8000px dimension
 * - Stay under ~18MB total request size
 *
 * ============================================================================
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { complete } from "@oh-my-pi/pi-ai/stream";
import type { Api, Context, ImageContent, Model, OptionsForApi, UserMessage } from "@oh-my-pi/pi-ai/types";
import { getBundledModel } from "@oh-my-pi/pi-catalog/models";
import { $which, removeSyncWithRetries } from "@oh-my-pi/pi-utils";
import { e2eApiKey } from "./oauth";

const TEMP_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "omp-temp-images-"));

/**
 * Generate a valid PNG image of specified dimensions using ImageMagick
 */
async function generateImage(width: number, height: number, filename: string): Promise<string> {
	const filepath = path.join(TEMP_DIR, filename);
	execSync(`magick -size ${width}x${height} xc:red "${filepath}"`, { stdio: "ignore" });
	const buffer = await fs.promises.readFile(filepath);
	return buffer.toBase64();
}

/**
 * Generate a valid PNG image of approximately the specified size in bytes
 */
async function generateImageWithSize(targetBytes: number, filename: string): Promise<string> {
	const filepath = path.join(TEMP_DIR, filename);
	// Use uncompressed PNG to get predictable sizes
	// Each pixel is 3 bytes (RGB), plus PNG overhead (~100 bytes)
	// For a square image: side = sqrt(targetBytes / 3)
	const side = Math.ceil(Math.sqrt(targetBytes / 3));
	// Use noise pattern to prevent compression from shrinking the file
	execSync(`magick -size ${side}x${side} xc: +noise Random -depth 8 PNG24:"${filepath}"`, { stdio: "ignore" });

	// Check actual size and adjust if needed
	const { size } = await Bun.file(filepath).stat();
	if (size < targetBytes * 0.8) {
		// If too small, increase dimensions
		const newSide = Math.ceil(side * Math.sqrt(targetBytes / size));
		execSync(`magick -size ${newSide}x${newSide} xc: +noise Random -depth 8 PNG24:"${filepath}"`, {
			stdio: "ignore",
		});
	}

	const buffer = await fs.promises.readFile(filepath);
	return buffer.toBase64();
}

/**
 * Create a user message with multiple images
 */
function createMultiImageMessage(imageCount: number, imageBase64: string): UserMessage {
	const content: (ImageContent | { type: "text"; text: string })[] = [
		{ type: "text", text: `I am sending you ${imageCount} images. Just reply with "received ${imageCount}".` },
	];

	for (let i = 0; i < imageCount; i++) {
		content.push({
			type: "image",
			data: imageBase64,
			mimeType: "image/png",
		});
	}

	return {
		role: "user",
		content,
		timestamp: Date.now(),
	};
}

/**
 * Test sending a specific number of images to a model
 */
async function testImageCount<TApi extends Api>(
	model: Model<TApi>,
	imageCount: number,
	imageBase64: string,
	options?: OptionsForApi<TApi>,
): Promise<{ success: boolean; error?: string }> {
	const context: Context = {
		messages: [createMultiImageMessage(imageCount, imageBase64)],
	};

	try {
		const response = await complete(model, context, options);
		if (response.stopReason === "error") {
			return { success: false, error: response.errorMessage };
		}
		return { success: true };
	} catch (e) {
		return { success: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * Test sending a single image (used for both size and dimension tests)
 */
async function testSingleImage<TApi extends Api>(
	model: Model<TApi>,
	imageBase64: string,
	options?: OptionsForApi<TApi>,
): Promise<{ success: boolean; error?: string }> {
	const context: Context = {
		messages: [
			{
				role: "user",
				content: [
					{ type: "text", text: "I am sending you an image. Just reply with 'received'." },
					{ type: "image", data: imageBase64, mimeType: "image/png" },
				],
				timestamp: Date.now(),
			},
		],
	};

	try {
		const response = await complete(model, context, options);
		if (response.stopReason === "error") {
			return { success: false, error: response.errorMessage };
		}
		return { success: true };
	} catch (e) {
		return { success: false, error: e instanceof Error ? e.message : String(e) };
	}
}

/**
 * Find the maximum value that succeeds using linear search
 */
async function findLimit(
	testFn: (value: number) => Promise<{ success: boolean; error?: string }>,
	min: number,
	max: number,
	step: number,
): Promise<{ limit: number; lastError?: string }> {
	let lastSuccess = min;
	let lastError: string | undefined;

	for (let value = min; value <= max; value += step) {
		console.log(`  Testing value: ${value}...`);
		const result = await testFn(value);
		if (result.success) {
			lastSuccess = value;
			console.log(`    SUCCESS`);
		} else {
			lastError = result.error;
			console.log(`    FAILED: ${result.error?.substring(0, 100)}`);
			break;
		}
	}

	return { limit: lastSuccess, lastError };
}

// =============================================================================
// Provider-specific test suites
// =============================================================================

describe("Image Limits E2E Tests", () => {
	let smallImage: string; // 100x100 for count tests

	beforeAll(async () => {
		if (!$which("magick")) return;

		// Generate small test image for count tests
		smallImage = await generateImage(100, 100, "small.png");
	});

	afterAll(() => {
		// Clean up temp directory
		removeSyncWithRetries(TEMP_DIR);
	});

	// -------------------------------------------------------------------------
	// Anthropic (claude-haiku-4-5-20251001)
	// Limits: 100 images, 5MB per image, 8000px max dimension
	// -------------------------------------------------------------------------
	describe.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))("Anthropic (claude-haiku-4-5-20251001)", () => {
		const model = getBundledModel("anthropic", "claude-haiku-4-5-20251001");

		it("should accept a small number of images (5)", async () => {
			const result = await testImageCount(model, 5, smallImage);
			expect(result.success, result.error).toBe(true);
		});

		it(
			"should find maximum image count limit",
			async () => {
				// Known limit: 100 images
				const { limit, lastError } = await findLimit(
					count => testImageCount(model, count, smallImage),
					20,
					120,
					20,
				);
				console.log(`\n  Anthropic max images: ~${limit} (last error: ${lastError})`);
				expect(limit).toBeGreaterThanOrEqual(80);
				expect(limit).toBeLessThanOrEqual(100);
			},
			{ timeout: 600000 },
		);

		it(
			"should find maximum image size limit",
			async () => {
				const MB = 1024 * 1024;
				// Known limit: 5MB per image
				const sizes = [1, 2, 3, 4, 5, 6];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const sizeMB of sizes) {
					console.log(`  Testing size: ${sizeMB}MB...`);
					const imageBase64 = await generateImageWithSize(sizeMB * MB, `size-${sizeMB}mb.png`);
					const result = await testSingleImage(model, imageBase64);
					if (result.success) {
						lastSuccess = sizeMB;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 100)}`);
						break;
					}
				}

				console.log(`\n  Anthropic max image size: ~${lastSuccess}MB (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(1);
			},
			{ timeout: 600000 },
		);

		it(
			"should find maximum image dimension limit",
			async () => {
				// Known limit: 8000px
				const dimensions = [1000, 2000, 4000, 6000, 8000, 10000];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const dim of dimensions) {
					console.log(`  Testing dimension: ${dim}x${dim}...`);
					const imageBase64 = await generateImage(dim, dim, `dim-${dim}.png`);
					const result = await testSingleImage(model, imageBase64);
					if (result.success) {
						lastSuccess = dim;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 100)}`);
						break;
					}
				}

				console.log(`\n  Anthropic max dimension: ~${lastSuccess}px (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(6000);
				expect(lastSuccess).toBeLessThanOrEqual(8000);
			},
			{ timeout: 600000 },
		);
	});

	// -------------------------------------------------------------------------
	// OpenAI (gpt-4o-mini via openai-completions)
	// Limits: 500 images, ~20MB per image (documented)
	// -------------------------------------------------------------------------
	describe.skipIf(!e2eApiKey("OPENAI_API_KEY"))("OpenAI (gpt-4o-mini)", () => {
		const model: Model<"openai-completions"> = {
			...getBundledModel("openai", "gpt-4o-mini"),
			api: "openai-completions",
		};

		it("should accept a small number of images (5)", async () => {
			const result = await testImageCount(model, 5, smallImage);
			expect(result.success, result.error).toBe(true);
		});

		it(
			"should find maximum image count limit",
			async () => {
				// Known limit: 500 images
				const { limit, lastError } = await findLimit(
					count => testImageCount(model, count, smallImage),
					100,
					600,
					100,
				);
				console.log(`\n  OpenAI max images: ~${limit} (last error: ${lastError})`);
				expect(limit).toBeGreaterThanOrEqual(400);
				expect(limit).toBeLessThanOrEqual(500);
			},
			{ timeout: 600000 },
		);

		it(
			"should find maximum image size limit",
			async () => {
				const MB = 1024 * 1024;
				// Documented limit: 20MB
				const sizes = [5, 10, 15, 20, 25];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const sizeMB of sizes) {
					console.log(`  Testing size: ${sizeMB}MB...`);
					const imageBase64 = await generateImageWithSize(sizeMB * MB, `size-${sizeMB}mb.png`);
					const result = await testSingleImage(model, imageBase64);
					if (result.success) {
						lastSuccess = sizeMB;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 100)}`);
						break;
					}
				}

				console.log(`\n  OpenAI max image size: ~${lastSuccess}MB (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(15);
			},
			{ timeout: 600000 },
		);

		it(
			"should find maximum image dimension limit",
			async () => {
				const dimensions = [2000, 4000, 8000, 16000, 20000];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const dim of dimensions) {
					console.log(`  Testing dimension: ${dim}x${dim}...`);
					const imageBase64 = await generateImage(dim, dim, `dim-${dim}.png`);
					const result = await testSingleImage(model, imageBase64);
					if (result.success) {
						lastSuccess = dim;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 100)}`);
						break;
					}
				}

				console.log(`\n  OpenAI max dimension: ~${lastSuccess}px (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(2000);
			},
			{ timeout: 600000 },
		);
	});

	// -------------------------------------------------------------------------
	// Google Gemini (gemini-2.5-flash)
	// Limits: Very high (~2500 images), large size support
	// -------------------------------------------------------------------------
	describe.skipIf(!e2eApiKey("GEMINI_API_KEY"))("Gemini (gemini-2.5-flash)", () => {
		const model = getBundledModel("google", "gemini-2.5-flash");

		it("should accept a small number of images (5)", async () => {
			const result = await testImageCount(model, 5, smallImage);
			expect(result.success, result.error).toBe(true);
		});

		it(
			"should find maximum image count limit",
			async () => {
				// Known to work up to ~2500, hits errors around 3000
				const { limit, lastError } = await findLimit(
					count => testImageCount(model, count, smallImage),
					500,
					3000,
					500,
				);
				console.log(`\n  Gemini max images: ~${limit} (last error: ${lastError})`);
				expect(limit).toBeGreaterThanOrEqual(500);
			},
			{ timeout: 900000 },
		);

		it(
			"should find maximum image size limit",
			async () => {
				const MB = 1024 * 1024;
				// Very permissive, tested up to 60MB successfully
				const sizes = [10, 20, 30, 40];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const sizeMB of sizes) {
					console.log(`  Testing size: ${sizeMB}MB...`);
					const imageBase64 = await generateImageWithSize(sizeMB * MB, `size-${sizeMB}mb.png`);
					const result = await testSingleImage(model, imageBase64);
					if (result.success) {
						lastSuccess = sizeMB;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 100)}`);
						break;
					}
				}

				console.log(`\n  Gemini max image size: ~${lastSuccess}MB (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(20);
			},
			{ timeout: 600000 },
		);

		it(
			"should find maximum image dimension limit",
			async () => {
				const dimensions = [2000, 4000, 8000, 16000, 20000];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const dim of dimensions) {
					console.log(`  Testing dimension: ${dim}x${dim}...`);
					const imageBase64 = await generateImage(dim, dim, `dim-${dim}.png`);
					const result = await testSingleImage(model, imageBase64);
					if (result.success) {
						lastSuccess = dim;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 100)}`);
						break;
					}
				}

				console.log(`\n  Gemini max dimension: ~${lastSuccess}px (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(2000);
			},
			{ timeout: 600000 },
		);
	});

	// -------------------------------------------------------------------------
	// Mistral (pixtral-12b)
	// Limits: ~8 images, ~15MB per image
	// -------------------------------------------------------------------------
	describe.skipIf(!e2eApiKey("MISTRAL_API_KEY"))("Mistral (pixtral-12b)", () => {
		const model = getBundledModel("mistral", "pixtral-12b");

		it("should accept a small number of images (5)", async () => {
			const result = await testImageCount(model, 5, smallImage);
			expect(result.success, result.error).toBe(true);
		});

		it(
			"should find maximum image count limit",
			async () => {
				// Known to fail around 9 images
				const { limit, lastError } = await findLimit(count => testImageCount(model, count, smallImage), 5, 15, 1);
				console.log(`\n  Mistral max images: ~${limit} (last error: ${lastError})`);
				expect(limit).toBeGreaterThanOrEqual(5);
			},
			{ timeout: 600000 },
		);

		it(
			"should find maximum image size limit",
			async () => {
				const MB = 1024 * 1024;
				const sizes = [5, 10, 15, 20];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const sizeMB of sizes) {
					console.log(`  Testing size: ${sizeMB}MB...`);
					const imageBase64 = await generateImageWithSize(sizeMB * MB, `size-${sizeMB}mb.png`);
					const result = await testSingleImage(model, imageBase64);
					if (result.success) {
						lastSuccess = sizeMB;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 100)}`);
						break;
					}
				}

				console.log(`\n  Mistral max image size: ~${lastSuccess}MB (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(5);
			},
			{ timeout: 600000 },
		);

		it(
			"should find maximum image dimension limit",
			async () => {
				const dimensions = [2000, 4000, 8000, 16000, 20000];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const dim of dimensions) {
					console.log(`  Testing dimension: ${dim}x${dim}...`);
					const imageBase64 = await generateImage(dim, dim, `dim-${dim}.png`);
					const result = await testSingleImage(model, imageBase64);
					if (result.success) {
						lastSuccess = dim;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 100)}`);
						break;
					}
				}

				console.log(`\n  Mistral max dimension: ~${lastSuccess}px (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(2000);
			},
			{ timeout: 600000 },
		);
	});

	// -------------------------------------------------------------------------
	// OpenRouter (z-ai/glm-4.5v)
	// Limits: Context-window limited (~45 images at 100x100), ~15MB per image
	// -------------------------------------------------------------------------
	describe.skipIf(!e2eApiKey("OPENROUTER_API_KEY"))("OpenRouter (z-ai/glm-4.5v)", () => {
		const model = getBundledModel("openrouter", "z-ai/glm-4.5v");

		it("should accept a small number of images (5)", async () => {
			const result = await testImageCount(model, 5, smallImage);
			expect(result.success, result.error).toBe(true);
		});

		it(
			"should find maximum image count limit",
			async () => {
				// Limited by context window, not explicit image limit
				const { limit, lastError } = await findLimit(count => testImageCount(model, count, smallImage), 10, 60, 10);
				console.log(`\n  OpenRouter max images: ~${limit} (last error: ${lastError})`);
				expect(limit).toBeGreaterThanOrEqual(10);
			},
			{ timeout: 600000 },
		);

		it(
			"should find maximum image size limit",
			async () => {
				const MB = 1024 * 1024;
				const sizes = [5, 10, 15, 20];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const sizeMB of sizes) {
					console.log(`  Testing size: ${sizeMB}MB...`);
					const imageBase64 = await generateImageWithSize(sizeMB * MB, `size-${sizeMB}mb.png`);
					const result = await testSingleImage(model, imageBase64);
					if (result.success) {
						lastSuccess = sizeMB;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 100)}`);
						break;
					}
				}

				console.log(`\n  OpenRouter max image size: ~${lastSuccess}MB (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(5);
			},
			{ timeout: 600000 },
		);

		it(
			"should find maximum image dimension limit",
			async () => {
				const dimensions = [2000, 4000, 8000, 16000, 20000];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const dim of dimensions) {
					console.log(`  Testing dimension: ${dim}x${dim}...`);
					const imageBase64 = await generateImage(dim, dim, `dim-${dim}.png`);
					const result = await testSingleImage(model, imageBase64);
					if (result.success) {
						lastSuccess = dim;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 100)}`);
						break;
					}
				}

				console.log(`\n  OpenRouter max dimension: ~${lastSuccess}px (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(2000);
			},
			{ timeout: 600000 },
		);
	});

	// -------------------------------------------------------------------------
	// xAI (grok-2-vision)
	// -------------------------------------------------------------------------
	describe.skipIf(!e2eApiKey("XAI_API_KEY"))("xAI (grok-2-vision)", () => {
		const model = getBundledModel("xai", "grok-2-vision");

		it("should accept a small number of images (5)", async () => {
			const result = await testImageCount(model, 5, smallImage);
			expect(result.success, result.error).toBe(true);
		});

		it(
			"should find maximum image count limit",
			async () => {
				const { limit, lastError } = await findLimit(
					count => testImageCount(model, count, smallImage),
					10,
					100,
					10,
				);
				console.log(`\n  xAI max images: ~${limit} (last error: ${lastError})`);
				expect(limit).toBeGreaterThanOrEqual(5);
			},
			{ timeout: 600000 },
		);

		it(
			"should find maximum image size limit",
			async () => {
				const MB = 1024 * 1024;
				const sizes = [5, 10, 15, 20, 25];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const sizeMB of sizes) {
					console.log(`  Testing size: ${sizeMB}MB...`);
					const imageBase64 = await generateImageWithSize(sizeMB * MB, `size-${sizeMB}mb.png`);
					const result = await testSingleImage(model, imageBase64);
					if (result.success) {
						lastSuccess = sizeMB;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 100)}`);
						break;
					}
				}

				console.log(`\n  xAI max image size: ~${lastSuccess}MB (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(5);
			},
			{ timeout: 600000 },
		);

		it(
			"should find maximum image dimension limit",
			async () => {
				const dimensions = [2000, 4000, 8000, 16000, 20000];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const dim of dimensions) {
					console.log(`  Testing dimension: ${dim}x${dim}...`);
					const imageBase64 = await generateImage(dim, dim, `dim-${dim}.png`);
					const result = await testSingleImage(model, imageBase64);
					if (result.success) {
						lastSuccess = dim;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 100)}`);
						break;
					}
				}

				console.log(`\n  xAI max dimension: ~${lastSuccess}px (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(2000);
			},
			{ timeout: 600000 },
		);
	});

	// -------------------------------------------------------------------------
	// Groq (llama-4-scout-17b)
	// -------------------------------------------------------------------------
	describe.skipIf(!e2eApiKey("GROQ_API_KEY"))("Groq (llama-4-scout-17b)", () => {
		const model = getBundledModel("groq", "meta-llama/llama-4-scout-17b-16e-instruct");

		it("should accept a small number of images (5)", async () => {
			const result = await testImageCount(model, 5, smallImage);
			expect(result.success, result.error).toBe(true);
		});

		it(
			"should find maximum image count limit",
			async () => {
				const { limit, lastError } = await findLimit(count => testImageCount(model, count, smallImage), 5, 50, 5);
				console.log(`\n  Groq max images: ~${limit} (last error: ${lastError})`);
				expect(limit).toBeGreaterThanOrEqual(5);
			},
			{ timeout: 600000 },
		);

		it(
			"should find maximum image size limit",
			async () => {
				const MB = 1024 * 1024;
				const sizes = [1, 5, 10, 15, 20];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const sizeMB of sizes) {
					console.log(`  Testing size: ${sizeMB}MB...`);
					const imageBase64 = await generateImageWithSize(sizeMB * MB, `size-${sizeMB}mb.png`);
					const result = await testSingleImage(model, imageBase64);
					if (result.success) {
						lastSuccess = sizeMB;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 100)}`);
						break;
					}
				}

				console.log(`\n  Groq max image size: ~${lastSuccess}MB (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(1);
			},
			{ timeout: 600000 },
		);

		it(
			"should find maximum image dimension limit",
			async () => {
				const dimensions = [2000, 4000, 8000, 16000, 20000];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const dim of dimensions) {
					console.log(`  Testing dimension: ${dim}x${dim}...`);
					const imageBase64 = await generateImage(dim, dim, `dim-${dim}.png`);
					const result = await testSingleImage(model, imageBase64);
					if (result.success) {
						lastSuccess = dim;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 100)}`);
						break;
					}
				}

				console.log(`\n  Groq max dimension: ~${lastSuccess}px (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(2000);
			},
			{ timeout: 600000 },
		);
	});

	// -------------------------------------------------------------------------
	// zAI (glm-4.5v)
	// -------------------------------------------------------------------------
	describe.skipIf(!e2eApiKey("ZAI_API_KEY"))("zAI (glm-4.5v)", () => {
		const model = getBundledModel("zai", "glm-4.5v");

		it("should accept a small number of images (5)", async () => {
			const result = await testImageCount(model, 5, smallImage);
			expect(result.success, result.error).toBe(true);
		});

		it(
			"should find maximum image count limit",
			async () => {
				const { limit, lastError } = await findLimit(
					count => testImageCount(model, count, smallImage),
					10,
					100,
					10,
				);
				console.log(`\n  zAI max images: ~${limit} (last error: ${lastError})`);
				expect(limit).toBeGreaterThanOrEqual(5);
			},
			{ timeout: 600000 },
		);

		it(
			"should find maximum image size limit",
			async () => {
				const MB = 1024 * 1024;
				const sizes = [5, 10, 15, 20];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const sizeMB of sizes) {
					console.log(`  Testing size: ${sizeMB}MB...`);
					const imageBase64 = await generateImageWithSize(sizeMB * MB, `size-${sizeMB}mb.png`);
					const result = await testSingleImage(model, imageBase64);
					if (result.success) {
						lastSuccess = sizeMB;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 100)}`);
						break;
					}
				}

				console.log(`\n  zAI max image size: ~${lastSuccess}MB (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(5);
			},
			{ timeout: 600000 },
		);

		it(
			"should find maximum image dimension limit",
			async () => {
				const dimensions = [2000, 4000, 8000, 16000, 20000];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const dim of dimensions) {
					console.log(`  Testing dimension: ${dim}x${dim}...`);
					const imageBase64 = await generateImage(dim, dim, `dim-${dim}.png`);
					const result = await testSingleImage(model, imageBase64);
					if (result.success) {
						lastSuccess = dim;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 100)}`);
						break;
					}
				}

				console.log(`\n  zAI max dimension: ~${lastSuccess}px (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(2000);
			},
			{ timeout: 600000 },
		);
	});

	// =========================================================================
	// MAX SIZE IMAGES TEST
	// =========================================================================
	// Tests how many images at (or near) max allowed size each provider can handle.
	// This tests realistic payload limits, not just image count with tiny files.
	//
	// Note: A real 8kx8k noise PNG is ~183MB (exceeds all provider limits).
	// So we test with images sized near each provider's actual size limit.
	// =========================================================================

	describe("Max Size Images (realistic payload stress test)", () => {
		// Generate images at specific sizes for each provider's limit
		const imageCache: Map<number, string> = new Map();

		async function getImageAtSize(targetMB: number): Promise<string> {
			if (imageCache.has(targetMB)) {
				return imageCache.get(targetMB)!;
			}
			console.log(`  Generating ~${targetMB}MB noise image...`);
			const imageBase64 = await generateImageWithSize(targetMB * 1024 * 1024, `stress-${targetMB}mb.png`);
			const actualSize = Buffer.from(imageBase64, "base64").length;
			console.log(`    Actual size: ${(actualSize / 1024 / 1024).toFixed(2)}MB`);
			imageCache.set(targetMB, imageBase64);
			return imageBase64;
		}

		// Anthropic - 5MB per image limit, 32MB total request, 100 image count
		// Using 3MB to stay under 5MB limit (generateImageWithSize has overhead)
		it.skipIf(!e2eApiKey("ANTHROPIC_API_KEY"))(
			"Anthropic: max ~3MB images before rejection",
			async () => {
				const model = getBundledModel("anthropic", "claude-haiku-4-5-20251001");
				const image3mb = await getImageAtSize(3);
				// 32MB total limit / ~4MB actual = ~8 images
				const counts = [1, 2, 4, 6, 8, 10, 12];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const count of counts) {
					console.log(`  Testing ${count} x ~3MB images...`);
					const result = await testImageCount(model, count, image3mb);
					if (result.success) {
						lastSuccess = count;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 150)}`);
						break;
					}
				}

				console.log(`\n  Anthropic max ~3MB images: ${lastSuccess} (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(1);
			},
			{ timeout: 900000 },
		);

		// OpenAI - 20MB per image documented, we found ≥25MB works
		// Test with 15MB images to stay safely under limit
		it.skipIf(!e2eApiKey("OPENAI_API_KEY"))(
			"OpenAI: max ~15MB images before rejection",
			async () => {
				const model = getBundledModel("openai", "gpt-4o-mini");
				const image15mb = await getImageAtSize(15);
				// Test progressively
				const counts = [1, 2, 5, 10, 20];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const count of counts) {
					console.log(`  Testing ${count} x ~15MB images...`);
					const result = await testImageCount(model, count, image15mb);
					if (result.success) {
						lastSuccess = count;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 150)}`);
						break;
					}
				}

				console.log(`\n  OpenAI max ~15MB images: ${lastSuccess} (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(1);
			},
			{ timeout: 1800000 },
		);

		// Gemini - very permissive, ≥40MB per image works
		// Test with 20MB images
		it.skipIf(!e2eApiKey("GEMINI_API_KEY"))(
			"Gemini: max ~20MB images before rejection",
			async () => {
				const model = getBundledModel("google", "gemini-2.5-flash");
				const image20mb = await getImageAtSize(20);
				// Test progressively
				const counts = [1, 2, 5, 10, 20, 50];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const count of counts) {
					console.log(`  Testing ${count} x ~20MB images...`);
					const result = await testImageCount(model, count, image20mb);
					if (result.success) {
						lastSuccess = count;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 150)}`);
						break;
					}
				}

				console.log(`\n  Gemini max ~20MB images: ${lastSuccess} (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(1);
			},
			{ timeout: 1800000 },
		);

		// Mistral - 8 image limit, ~15MB per image
		// Test with 10MB images (safely under limit)
		it.skipIf(!e2eApiKey("MISTRAL_API_KEY"))(
			"Mistral: max ~10MB images before rejection",
			async () => {
				const model = getBundledModel("mistral", "pixtral-12b");
				const image10mb = await getImageAtSize(10);
				// Known limit is 8 images
				const counts = [1, 2, 4, 6, 8, 9];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const count of counts) {
					console.log(`  Testing ${count} x ~10MB images...`);
					const result = await testImageCount(model, count, image10mb);
					if (result.success) {
						lastSuccess = count;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 150)}`);
						break;
					}
				}

				console.log(`\n  Mistral max ~10MB images: ${lastSuccess} (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(1);
			},
			{ timeout: 600000 },
		);

		// xAI - 25MB per image limit (26214400 bytes exact)
		// Test with 20MB images (safely under limit)
		it.skipIf(!e2eApiKey("XAI_API_KEY"))(
			"xAI: max ~20MB images before rejection",
			async () => {
				const model = getBundledModel("xai", "grok-2-vision");
				const image20mb = await getImageAtSize(20);
				// Test progressively
				const counts = [1, 2, 5, 10, 20];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const count of counts) {
					console.log(`  Testing ${count} x ~20MB images...`);
					const result = await testImageCount(model, count, image20mb);
					if (result.success) {
						lastSuccess = count;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 150)}`);
						break;
					}
				}

				console.log(`\n  xAI max ~20MB images: ${lastSuccess} (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(1);
			},
			{ timeout: 1200000 },
		);

		// Groq - very limited (5 images, ~5760px max due to 33M pixel limit)
		// 8k images (64M pixels) exceed limit, so test with 5760px images instead
		it.skipIf(!e2eApiKey("GROQ_API_KEY"))(
			"Groq: max 5760px images before rejection",
			async () => {
				const model = getBundledModel("groq", "meta-llama/llama-4-scout-17b-16e-instruct");
				// Generate 5760x5760 image (33177600 pixels = Groq's limit)
				console.log("  Generating 5760x5760 test image for Groq...");
				const image5760 = await generateImage(5760, 5760, "stress-5760.png");

				// Known limit is 5 images
				const counts = [1, 2, 3, 4, 5, 6];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const count of counts) {
					console.log(`  Testing ${count} x 5760px images...`);
					const result = await testImageCount(model, count, image5760);
					if (result.success) {
						lastSuccess = count;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 150)}`);
						break;
					}
				}

				console.log(`\n  Groq max 5760px images: ${lastSuccess} (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(1);
			},
			{ timeout: 600000 },
		);

		// zAI - ≥20MB per image, context-window limited (65k tokens)
		// Test with 15MB images
		it.skipIf(!e2eApiKey("ZAI_API_KEY"))(
			"zAI: max ~15MB images before rejection",
			async () => {
				const model = getBundledModel("zai", "glm-4.5v");
				const image15mb = await getImageAtSize(15);
				// Context-limited, test progressively
				const counts = [1, 2, 5, 10, 20];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const count of counts) {
					console.log(`  Testing ${count} x ~15MB images...`);
					const result = await testImageCount(model, count, image15mb);
					if (result.success) {
						lastSuccess = count;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 150)}`);
						break;
					}
				}

				console.log(`\n  zAI max ~15MB images: ${lastSuccess} (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(1);
			},
			{ timeout: 1200000 },
		);

		// OpenRouter - ~10MB per image, context-window limited (65k tokens)
		// Test with 5MB images (safer size)
		it.skipIf(!e2eApiKey("OPENROUTER_API_KEY"))(
			"OpenRouter: max ~5MB images before rejection",
			async () => {
				const model = getBundledModel("openrouter", "z-ai/glm-4.5v");
				const image5mb = await getImageAtSize(5);
				// Context-limited, test progressively
				const counts = [1, 2, 5, 10, 20];

				let lastSuccess = 0;
				let lastError: string | undefined;

				for (const count of counts) {
					console.log(`  Testing ${count} x ~5MB images...`);
					const result = await testImageCount(model, count, image5mb);
					if (result.success) {
						lastSuccess = count;
						console.log(`    SUCCESS`);
					} else {
						lastError = result.error;
						console.log(`    FAILED: ${result.error?.substring(0, 150)}`);
						break;
					}
				}

				console.log(`\n  OpenRouter max ~5MB images: ${lastSuccess} (last error: ${lastError})`);
				expect(lastSuccess).toBeGreaterThanOrEqual(1);
			},
			{ timeout: 900000 },
		);
	});
});
