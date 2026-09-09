//! Consent-ready, prompt-free behavioral counters derived from user prose.
//!
//! The analyzer returns only counts. Callers must discard the input after this
//! function and persist the result only when local analytics consent is active.

use std::sync::LazyLock;

use regex::Regex;

/// Derived counters for one user message. No source text is retained.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct UserSentimentMetrics {
	/// Trimmed Unicode scalar count.
	pub chars:      u64,
	/// Whitespace-delimited word count.
	pub words:      u64,
	/// Multi-run uppercase sentences.
	pub yelling:    u64,
	/// Word-bounded profanity hits.
	pub profanity:  u64,
	/// Exasperation punctuation, interjections, and sad emoticons.
	pub anguish:    u64,
	/// Corrective negation directed at the prior response.
	pub negation:   u64,
	/// Explicit statements that the user is repeating an instruction.
	pub repetition: u64,
	/// Direct second-person reproach.
	pub blame:      u64,
}

static FENCED: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?s)```.*?```").expect("regex"));
static TAG_PAIR: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(r"(?s)<[A-Za-z][A-Za-z0-9_-]*\b[^>]*>.*?</[A-Za-z][A-Za-z0-9_-]*>").expect("regex")
});
static TAG: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"</?[A-Za-z][A-Za-z0-9_-]*\b[^>]*/?>").expect("regex"));
static INLINE_CODE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"`[^`\n]*`").expect("regex"));
static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\bhttps?://\S+").expect("regex"));
static FILE_MENTION: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"(?:^|\s)@[A-Za-z0-9_./-]+").expect("regex"));
static DOTTED_TOKEN: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"\b[A-Za-z0-9_-]+(?:\.[A-Za-z0-9_-]+)+\b").expect("regex"));
static IMAGE_MARKER: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"\[Image #[0-9]+\]").expect("regex"));
static ANSI: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"\x1b\[[0-9;]*[A-Za-z]").expect("regex"));
static PROFANITY: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(concat!(
		r"(?i)\b(?:fuck(?:s|ed|ing|in|er|ers|up|ups|head|heads|face|wit|wits|tard|ery|off)?|",
		r"motherfuck(?:er|ers|ing)|clusterfuck|fck(?:s|ing|in|er)?|fuk(?:ing|in)?|",
		r"eff(?:s|ed|ing)?|frick(?:s|ed|ing|in)?|freak(?:ing|in|ed)?|",
		r"shit(?:s|ty|tier|tiest|e|ting|ter|ters|head|heads|show|storm|load|bag|post|posting)?|",
		r"bullshit(?:s|ting|ter)?|horseshit|batshit|dogshit|dipshit|jackshit|dumbshit|",
		r"damn(?:s|ed|ing|it)?|goddamn(?:ed|it)?|darn(?:s|ed|it)?|dang(?:ed|it)?|",
		r"hell|heck(?:s|in)?|bloody|bollocks|crap(?:s|py|pier|piest|ped|ping|load|ola)?|",
		r"piss(?:es|ed|ing|er|poor|take|head)?|ass(?:es|hole|holes|hat|hats|wipe|wipes|clown|bag)?|",
		r"dumbass(?:es)?|jackass(?:es)?|arse(?:d|hole|holes|wipe)?|bitch(?:es|ed|ing|y|ier|iest)?|",
		r"cunt(?:s|y|ish)?|twat(?:s|ty)?|bastard(?:s)?|dick(?:s|head|heads|ish|wad|wads|face|bag)?|",
		r"prick(?:s|ish)?|wanker(?:s|y)?|tosser(?:s)?|douche(?:s|bag|bags|y)?|scumbag(?:s)?|",
		r"idiot(?:s|ic|cy)?|stupid(?:er|est|ity)?|moron(?:s|ic)?|imbecile(?:s)?|",
		r"dumb(?:er|est|o)?|fool(?:s|ish|ery)?|clown(?:s|ish)?|jerk(?:s|face|off|offs)?|",
		r"suck(?:s|ed|ing|y|age)?|jesus|christ|jeez(?:us)?|sheesh|wtf|wth|wtaf|stfu|gtfo|",
		r"omfg|omg|ffs|jfc|fml|smh|smdh|smfh|idgaf|idfc|lmfao|fubar|snafu)\b",
	))
	.expect("regex")
});
static DRAMA: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[!?][!?1]{2,}").expect("regex"));
static ANGUISH: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"(?i)\b(?:no{3,}|a+h{2,}|u+r?g+h+|a+r+g+h+|g+r{2,}|st+o{3,}p+|w+h+y{3,}|f+u{3,}c*k*|wtf{3,}|o+m+g{2,}|ye+s{3,}|g+o+d{3,}|br+u+h{2,}|dude)\b",
	)
	.expect("regex")
});
static SAD: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"(?:^|[\s.!?])[:;]-?\(+").expect("regex"));
static NEGATION_LEAD: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"(?i)^\s*(?:(?:nope|nah|nvm|wrong|incorrect)\b|no(?:\s*(?:[,\.!?;:]|$)|\s+(?:i|im|you|we|it|that|this|they|wait|dont|not|stop|just|again|please|but|actually|seriously|sorry|never|nothing|wtf|why|what|wrong)\b))",
	)
	.expect("regex")
});
static NEGATION_PHRASE: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"(?i)\b(?:that['’]?s\s+not\s+(?:what|right|it)|not\s+what\s+i\s+(?:meant|asked|said|wanted)|makes\s+(?:no|zero)\s+sense)\b",
	)
	.expect("regex")
});
static REPETITION: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"(?i)\b(?:(?:like|as)\s+i\s+(?:said|told\s+you|asked)|i\s+(?:meant|said|told\s+you|asked\s+you|already\s+(?:said|told|did|asked|wrote))|still\s+(?:doesn['’]?t|doesnt|isn['’]?t|isnt|not|broken|wrong|fails|failing|the\s+same|same))\b",
	)
	.expect("regex")
});
static BLAME: LazyLock<Regex> = LazyLock::new(|| {
	Regex::new(
		r"(?i)\b(?:you\s+(?:didn['’]?t|did\s+not|broke|missed|forgot|keep|always|never|still|ignored)|why\s+(?:would|did)\s+(?:you|u))\b",
	)
	.expect("regex")
});
static BLAME_STOP: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"(?i)^\s*stop\s+[A-Za-z]+ing\b").expect("regex"));

/// Computes prompt-free local counters for one message.
pub fn analyze_user_sentiment(text: &str) -> UserSentimentMetrics {
	let text = text.trim();
	if text.is_empty() {
		return UserSentimentMetrics::default();
	}
	let chars = text.chars().count() as u64;
	let words = text.split_whitespace().count() as u64;
	let prose = strip_structured(text);
	let prose = prose.trim();
	if prose.is_empty() || prose.lines().filter(|line| !line.trim().is_empty()).count() >= 3 {
		return UserSentimentMetrics { chars, words, ..UserSentimentMetrics::default() };
	}
	let anguish = matches(&DRAMA, prose) + matches(&ANGUISH, prose) + matches(&SAD, prose);
	let negation = matches(&NEGATION_LEAD, prose) + matches(&NEGATION_PHRASE, prose);
	let repetition = matches(&REPETITION, prose);
	let blame = matches(&BLAME, prose)
		+ prose
			.split(['.', '!', '?', '\n'])
			.filter(|sentence| BLAME_STOP.is_match(sentence))
			.count() as u64;
	UserSentimentMetrics {
		chars,
		words,
		yelling: count_yelling(prose),
		profanity: matches(&PROFANITY, prose),
		anguish,
		negation,
		repetition,
		blame,
	}
}

fn matches(regex: &Regex, text: &str) -> u64 {
	regex.find_iter(text).count() as u64
}

fn strip_structured(text: &str) -> String {
	let mut prose = FENCED.replace_all(text, "\n").into_owned();
	prose = TAG_PAIR.replace_all(&prose, "\n").into_owned();
	for regex in
		[&*TAG, &*INLINE_CODE, &*URL, &*FILE_MENTION, &*DOTTED_TOKEN, &*IMAGE_MARKER, &*ANSI]
	{
		prose = regex.replace_all(&prose, " ").into_owned();
	}
	prose
		.lines()
		.filter(|line| !line.trim_start().starts_with('>'))
		.collect::<Vec<_>>()
		.join("\n")
}

fn count_yelling(text: &str) -> u64 {
	text
		.split(['.', '!', '?', '\n'])
		.filter(|sentence| {
			let letters = sentence
				.chars()
				.filter(|value| value.is_alphabetic())
				.count();
			if letters < 4 {
				return false;
			}
			let upper = sentence
				.chars()
				.filter(|value| value.is_uppercase())
				.count();
			if upper * 2 <= letters {
				return false;
			}
			let runs = uppercase_runs(sentence);
			runs >= 2 || has_tripled_uppercase(sentence)
		})
		.count() as u64
}

fn uppercase_runs(text: &str) -> usize {
	let mut runs = 0;
	let mut length = 0;
	for character in text.chars().chain([' ']) {
		if character.is_uppercase() {
			length += 1;
		} else {
			if length >= 2 {
				runs += 1;
			}
			length = 0;
		}
	}
	runs
}

fn has_tripled_uppercase(text: &str) -> bool {
	let mut prior = None;
	let mut run = 0;
	for character in text.chars().filter(|value| value.is_uppercase()) {
		if prior == Some(character) {
			run += 1;
		} else {
			prior = Some(character);
			run = 1;
		}
		if run >= 3 {
			return true;
		}
	}
	false
}
