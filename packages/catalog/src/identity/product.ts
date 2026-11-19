/**
 * Product identity: the catalog's class, family and revision, refined by the
 * product words of the id a provider is sent, so one model keeps one key across
 * providers while different products of one revision keep their own.
 */
import { once } from "@oh-my-pi/pi-utils";
import { collapseVocabulary, discoveryVocabulary, routingVariantPlain, stripEffortLane } from "../compat/taxonomy";
import type { Model } from "../types";
import { bareModelId } from "./id";

/** A route word, and the classes where it names a route. */
export interface ModelRouteWord {
	/** The route word; one made of several id words (`non-reasoning`) matches them in that order. */
	word: string;
	/** The only classes where the word names a route; absent for every class. */
	classes?: readonly string[];
	/** The classes where the word names a product of its own instead of a route. */
	exceptClasses?: readonly string[];
}

/**
 * Words that name a route of one model, not another product: a provider sells
 * the same model in a batch, flex or priority tier, at a discount, on a fast,
 * high-speed or turbo serving, with its thinking off (`nothinking`,
 * `non-reasoning`), or under a `latest` alias, and adds the word to the model's
 * id. A word names a route in every class unless its entry limits it: xAI's
 * Grok 4 Fast is a model of its own, and `turbo` names a route only for Qwen,
 * while OpenAI's `gpt-4-turbo` is a product.
 */
export const MODEL_ROUTE_WORDS: readonly ModelRouteWord[] = [
	{ word: "batch" },
	{ word: "flex" },
	{ word: "priority" },
	{ word: "discounted" },
	{ word: "cheaper" },
	{ word: "latest" },
	{ word: "highspeed" },
	{ word: "nothinking" },
	{ word: "non-reasoning" },
	{ word: "fast", exceptClasses: ["xai"] },
	{ word: "turbo", classes: ["qwen"] },
];

/** A variant word of the catalog, and the classes where it names a product of its own. */
export interface ModelProductVariantWord {
	/** The variant word, one id word. */
	word: string;
	/** The classes where the word names a product of its own; it is a variant word in every other class. */
	classes: readonly string[];
}

/**
 * Variant words of the catalog that name a product of their own in some classes: a word on this list is a product
 * word in the classes its entry names and a variant word elsewhere. Each is one id word. The catalog strips `max`
 * as an effort or mode word, as in Cursor's `claude-opus-4-8-max` (Claude Opus 4.8 in Max mode), but GPT-5.1 Codex
 * Max is another model than GPT-5.1 Codex: providers send it upstream as `gpt-5.1-codex-max`.
 */
export const MODEL_PRODUCT_VARIANT_WORDS: readonly ModelProductVariantWord[] = [{ word: "max", classes: ["openai"] }];

const WORD_PATTERN = /[a-z0-9]+/g;
const NUMBER_WORD_PATTERN = /^v?[0-9]+$/;
const TRAILING_DIGITS_PATTERN = /[0-9]+$/;

/** A route word split into id words, with its entry. */
interface RouteWordRule {
	words: readonly string[];
	entry: ModelRouteWord;
}

interface ProductKeyVocabulary {
	/** Variant words the catalog strips from every id. */
	variantWords: Set<string>;
	/**
	 * Variant words that come only from suffix rules with an exception, by word, with the exceptions' prefixes: the
	 * catalog does not strip the word from an id whose bare part starts with every one of them (`max` in a `qwen` id).
	 */
	exceptedVariantWords: Map<string, string[]>;
	/** {@link MODEL_PRODUCT_VARIANT_WORDS} by word. */
	productVariantWords: Map<string, ModelProductVariantWord>;
	/** Vendor-lineage words: the catalog's canonical family tokens (`claude`, `qwen`). */
	lineageWords: Set<string>;
	/** Route words by their first id word, the longest first. */
	routeWords: Map<string, RouteWordRule[]>;
}

/** The lowercase words of `text`: it splits at every character that is not an ASCII letter or digit. */
function wordsOf(text: string): readonly string[] {
	return text.toLowerCase().match(WORD_PATTERN) ?? [];
}

function addWords(target: Set<string>, text: string): void {
	for (const word of wordsOf(text)) target.add(word);
}

const getProductKeyVocabulary = once((): ProductKeyVocabulary => {
	const discovery = discoveryVocabulary();
	const collapse = collapseVocabulary();
	const variantWords = new Set<string>();
	for (const marker of discovery.trailingMarkers) addWords(variantWords, marker);
	for (const suffix of discovery.billingVariantSuffixes) addWords(variantWords, suffix);
	for (const rule of collapse.suffixes) {
		if (rule.exceptBarePrefix === undefined) addWords(variantWords, rule.suffix);
	}
	for (const token of collapse.pairTokens) addWords(variantWords, token);
	const exceptedVariantWords = new Map<string, string[]>();
	for (const rule of collapse.suffixes) {
		if (rule.exceptBarePrefix === undefined) continue;
		for (const word of wordsOf(rule.suffix)) {
			// A word that another source strips without an exception stays a variant word in every id.
			if (variantWords.has(word)) continue;
			const prefixes = exceptedVariantWords.get(word);
			if (prefixes === undefined) exceptedVariantWords.set(word, [rule.exceptBarePrefix]);
			else prefixes.push(rule.exceptBarePrefix);
		}
	}
	const productVariantWords = new Map<string, ModelProductVariantWord>();
	for (const entry of MODEL_PRODUCT_VARIANT_WORDS) productVariantWords.set(entry.word, entry);
	const lineageWords = new Set<string>();
	for (const token of discovery.canonicalFamilyTokens) addWords(lineageWords, token);
	const routeWords = new Map<string, RouteWordRule[]>();
	for (const entry of MODEL_ROUTE_WORDS) {
		const words = wordsOf(entry.word);
		if (words.length === 0) continue;
		const rules = routeWords.get(words[0]);
		if (rules === undefined) routeWords.set(words[0], [{ words, entry }]);
		else rules.push({ words, entry });
	}
	for (const rules of routeWords.values()) rules.sort((left, right) => right.words.length - left.words.length);
	return { variantWords, exceptedVariantWords, productVariantWords, lineageWords, routeWords };
});

// Cache keyed by class and family id (a bounded set from the catalog's rules), so no eviction is needed.
const nameWordsCache = new Map<string, readonly string[]>();
function nameWords(name: string): readonly string[] {
	let words = nameWordsCache.get(name);
	if (words === undefined) {
		words = wordsOf(name);
		nameWordsCache.set(name, words);
	}
	return words;
}

/** How many of `words` from `start` on make a route word for class `cls`, the longest first; 0 when none does. */
function routeWordLength(
	routeWords: ReadonlyMap<string, readonly RouteWordRule[]>,
	words: readonly string[],
	start: number,
	cls: string,
): number {
	const rules = routeWords.get(words[start]);
	if (rules === undefined) return 0;
	for (const rule of rules) {
		if (rule.entry.classes?.includes(cls) === false || rule.entry.exceptClasses?.includes(cls)) continue;
		let length = 0;
		while (length < rule.words.length && words[start + length] === rule.words[length]) length++;
		if (length === rule.words.length) return length;
	}
	return 0;
}

/**
 * Whether `word` names the model, not a product of it: a word of its class or family, or a vendor-lineage word.
 * A vendor-lineage word is one of `lineageWords`, or such a word or a class word followed by digits (`qwen3`).
 */
function isNameWord(
	word: string,
	classWords: readonly string[],
	familyWords: readonly string[],
	lineageWords: ReadonlySet<string>,
): boolean {
	if (classWords.includes(word) || familyWords.includes(word) || lineageWords.has(word)) return true;
	const stem = word.replace(TRAILING_DIGITS_PATTERN, "");
	return stem !== word && (lineageWords.has(stem) || classWords.includes(stem));
}

/** Whether `word` is on {@link MODEL_PRODUCT_VARIANT_WORDS} for class `cls`. */
function isProductVariantWord(
	productVariantWords: ReadonlyMap<string, ModelProductVariantWord>,
	word: string,
	cls: string,
): boolean {
	return productVariantWords.get(word)?.classes.includes(cls) === true;
}

/**
 * Whether the catalog strips `word` from an id whose lowercase bare part is `lowerBare`. A word that comes only from
 * suffix rules with an exception is not a variant word in an id that starts with every one of their prefixes.
 */
function isVariantWord(
	variantWords: ReadonlySet<string>,
	exceptedVariantWords: ReadonlyMap<string, readonly string[]>,
	word: string,
	lowerBare: string,
): boolean {
	if (variantWords.has(word)) return true;
	const prefixes = exceptedVariantWords.get(word);
	return prefixes !== undefined && prefixes.some(prefix => !lowerBare.startsWith(prefix));
}

/**
 * The key of one model product. One model keeps one key across the providers
 * that serve it, the spellings they give its id and the routes they sell it on
 * (`anthropic/claude-opus-4-8`, `amazon-bedrock/us.anthropic.claude-opus-4-8`,
 * `openrouter/anthropic/claude-opus-4.8:batch`). Different products that share
 * the catalog's class, family and revision get separate keys (`openai/gpt-5.6`
 * and `openai/gpt-5.6-sol`).
 *
 * The key is `class/family/revision/` followed by the product words of the
 * served id, the id the provider is sent (`requestModelId`, else `id`). The
 * catalog's logical id is not read: it drops variant words such as `max`,
 * which name a product in some classes. A provider's lane or routing-variant
 * suffix is removed from the end of the served id first, as the catalog
 * removes it (`-fast` from `cursor/grok-4.7-fast`, `-wm` from
 * `openai-codex/gpt-5.6-luna-wm`); the same word in another place stays
 * (`fast` in `cursor/grok-code-fast-1`). The product words start at the first
 * class, family or vendor-lineage word of the served id (`anthropic` in
 * `us-gov.anthropic.claude-opus-4-8`, or `qwen3` in `qwen3-coder`), so a vendor
 * or region prefix (`us-gov.`) is left out; when no word qualifies, they start
 * at the first word. They are the words from there on without numbers, class,
 * family and lineage words, the catalog's variant words, and
 * {@link MODEL_ROUTE_WORDS}. A variant word is a product word in the classes of
 * its {@link MODEL_PRODUCT_VARIANT_WORDS} entry, and in the ids that the
 * catalog's suffix rule exempts (`max` in an id that starts with `qwen`, as in
 * Qwen Max). A product word that comes before the family's last word counts too
 * (`live` in `gemini-live-2.5-flash`). A word on no list counts as a product
 * word: keeping a word that only names a route costs one more refused request,
 * but dropping a word that names another product would pass over that product
 * and can end a turn early.
 *
 * Undefined when the identity names no one model: class `unknown`, or no
 * family, or no revision.
 */
export function productIdentityKey(
	model: Pick<Model, "provider" | "id" | "identity" | "requestModelId">,
): string | undefined {
	const { identity } = model;
	if (!identity || identity.class === "unknown" || identity.family === undefined || identity.revision === undefined) {
		return undefined;
	}
	const served = bareModelId(model.requestModelId ?? model.id);
	const at = served.indexOf("@");
	const bare = at === -1 ? served : served.slice(0, at);
	const laneless = stripEffortLane(model.provider, bare);
	const plain = routingVariantPlain(model.provider, laneless) ?? laneless;
	const lowerBare = bare.toLowerCase();
	const { variantWords, exceptedVariantWords, productVariantWords, lineageWords, routeWords } =
		getProductKeyVocabulary();
	const classWords = nameWords(identity.class);
	const familyWords = nameWords(identity.family);
	const words = wordsOf(plain);
	const kept: string[] = [];
	// The words before the first class, family or lineage word are a vendor or region prefix (`us-gov.` in
	// `us-gov.anthropic.claude-opus-4-8`).
	let index = Math.max(
		0,
		words.findIndex(word => isNameWord(word, classWords, familyWords, lineageWords)),
	);
	while (index < words.length) {
		const routeLength = routeWordLength(routeWords, words, index, identity.class);
		if (routeLength > 0) {
			index += routeLength;
			continue;
		}
		const word = words[index];
		index++;
		if (
			NUMBER_WORD_PATTERN.test(word) ||
			isNameWord(word, classWords, familyWords, lineageWords) ||
			(isVariantWord(variantWords, exceptedVariantWords, word, lowerBare) &&
				!isProductVariantWord(productVariantWords, word, identity.class))
		) {
			continue;
		}
		kept.push(word);
	}
	return `${identity.class}/${identity.family}/${identity.revision}/${kept.join("-")}`;
}

/**
 * The product keys of a model row: the key of the served id ({@link productIdentityKey}) and the key of the row's own
 * catalog id (`id`), each when it is defined, with no key twice. Empty when neither key is defined.
 *
 * A row needs both keys. A provider that sends another id for a row serves the model of that id: OpenAI sends
 * `gpt-5.6-luna-pro` as `gpt-5.6-luna`. Other providers name the same model by the row's id:
 * `openrouter/openai/gpt-5.6-luna-pro`. The catalog's logical id gives no key, because it drops variant words that
 * name a product: the logical id of `gpt-5.1-codex-max` is `gpt-5.1-codex`, so its key would put GPT-5.1 Codex Max on
 * the key of GPT-5.1 Codex.
 */
export function productIdentityKeys(
	model: Pick<Model, "provider" | "id" | "identity" | "requestModelId">,
): readonly string[] {
	const keys: string[] = [];
	const served = productIdentityKey(model);
	if (served !== undefined) keys.push(served);
	if (model.requestModelId === undefined) return keys;
	const own = productIdentityKey({ provider: model.provider, id: model.id, identity: model.identity });
	if (own !== undefined && own !== served) keys.push(own);
	return keys;
}
