//! Validation and casing reconciliation for local generated titles.

use std::sync::LazyLock;

use omp_core::Str;
use regex::{Captures, Regex};

use super::message_preproc::{
	is_preformatted_chat_context, preprocess_tiny_message, strip_chat_scaffolding,
};

/// Sentinel meaning that title generation should be deferred.
pub const NO_TITLE_SENTINEL: &str = "none";
const MAX_TITLE_CHARS: usize = 80;
const MAX_TITLE_WORDS: usize = 12;

static WORD: LazyLock<Regex> =
	LazyLock::new(|| Regex::new(r"[\p{L}\p{N}]+").expect("title-word regex"));

/// True when a first message is only greeting, acknowledgement, punctuation,
/// or bare numbers and should not be sent to a small title model.
pub fn is_low_signal_title_input(message: &str) -> bool {
	let cleaned = if is_preformatted_chat_context(message) {
		strip_chat_scaffolding(message)
	} else {
		preprocess_tiny_message(message).as_str().to_owned()
	};
	let mut tokens = WORD.find_iter(&cleaned).peekable();
	if tokens.peek().is_none() {
		return true;
	}
	tokens.all(|word| {
		let token = word.as_str().to_ascii_lowercase();
		token.bytes().all(|byte| byte.is_ascii_digit()) || filler(&token)
	})
}

/// Removes title envelopes/quotes/terminal punctuation, rejects sentinels and
/// out-of-contract output, and reconciles casing against the source message.
pub fn normalize_generated_title(value: Option<&str>, source_text: Option<&str>) -> Option<Str> {
	let first = value?.trim().lines().next()?.trim();
	let mut title = first.trim_matches(['"', '\'']).trim();
	if title.eq_ignore_ascii_case("<title/>") || title.eq_ignore_ascii_case("<title />") {
		return None;
	}
	if title
		.get(..7)
		.is_some_and(|prefix| prefix.eq_ignore_ascii_case("<title>"))
	{
		title = &title[7..];
	}
	if title
		.get(title.len().saturating_sub(8)..)
		.is_some_and(|suffix| suffix.eq_ignore_ascii_case("</title>"))
	{
		title = &title[..title.len() - 8];
	}
	title = title
		.trim_matches(['"', '\''])
		.trim_end_matches(['.', '!', '?'])
		.trim();
	let words = WORD.find_iter(title).count();
	if title.is_empty()
		|| title.eq_ignore_ascii_case(NO_TITLE_SENTINEL)
		|| words == 0
		|| words > MAX_TITLE_WORDS
		|| title.chars().count() > MAX_TITLE_CHARS
	{
		return None;
	}
	Some(Str::from(
		source_text.map_or_else(|| title.to_owned(), |source| reconcile_casing(title, source)),
	))
}

fn reconcile_casing(title: &str, source: &str) -> String {
	let source_tokens: Vec<&str> = WORD.find_iter(source).map(|word| word.as_str()).collect();
	let shouty = source_tokens
		.windows(2)
		.any(|pair| pair.iter().all(|token| is_all_caps_word(token)));
	WORD
		.replace_all(title, |captures: &Captures<'_>| {
			let token = captures.get(0).map_or("", |matched| matched.as_str());
			if source_tokens.contains(&token) {
				return token.to_owned();
			}
			let lower = token.to_lowercase();
			if let Some(source) = source_tokens
				.iter()
				.find(|source| source.to_lowercase() == lower && distinctive_case(source))
			{
				return (*source).to_owned();
			}
			if !shouty
				&& title_case_artifact(token)
				&& let Some(source) = source_tokens
					.iter()
					.find(|source| source.to_lowercase() == lower && all_caps_acronym(source))
			{
				return (*source).to_owned();
			}
			if token.chars().next().is_some_and(char::is_lowercase)
				&& token.chars().skip(1).any(char::is_uppercase)
			{
				lower
			} else {
				token.to_owned()
			}
		})
		.into_owned()
}

fn filler(token: &str) -> bool {
	matches!(
		token,
		"hi"
			| "hii"
			| "hiii"
			| "hiya"
			| "hey"
			| "heya"
			| "hello"
			| "helo"
			| "hullo"
			| "yo" | "sup"
			| "wassup"
			| "whatsup"
			| "howdy"
			| "greetings"
			| "hola"
			| "ciao"
			| "aloha"
			| "gm" | "gn"
			| "good"
			| "morning"
			| "afternoon"
			| "evening"
			| "night"
			| "day"
			| "thanks"
			| "thank"
			| "thx"
			| "ty" | "tysm"
			| "cheers"
			| "please"
			| "pls"
			| "plz"
			| "ok" | "okay"
			| "okey"
			| "k" | "kk"
			| "yep"
			| "yes"
			| "yeah"
			| "yup"
			| "nope"
			| "no" | "nah"
			| "sure"
			| "cool"
			| "nice"
			| "great"
			| "awesome"
			| "perfect"
			| "lol"
			| "lmao"
			| "haha"
			| "hehe"
			| "test"
			| "tests"
			| "testing"
			| "ping"
			| "pong"
			| "there"
			| "you"
			| "u" | "hmm"
			| "hmmm"
			| "um" | "uh"
			| "so" | "well"
			| "anyway"
	)
}

fn distinctive_case(token: &str) -> bool {
	token.chars().any(char::is_lowercase) && token.chars().skip(1).any(char::is_uppercase)
}

fn is_all_caps_word(token: &str) -> bool {
	let letters = token.chars().filter(|ch| ch.is_alphabetic()).count();
	letters >= 2 && token.chars().any(char::is_uppercase) && !token.chars().any(char::is_lowercase)
}

fn all_caps_acronym(token: &str) -> bool {
	if !is_all_caps_word(token) {
		return false;
	}
	const COMMON: &[&str] = &[
		"API", "CLI", "CPU", "CRUD", "CSS", "DNS", "ETL", "GPU", "HTML", "HTTP", "HTTPS", "ID",
		"JSON", "LLM", "REST", "SDK", "SSH", "TCP", "TLS", "TUI", "UI", "URI", "URL", "UX", "XML",
		"YAML",
	];
	COMMON.contains(&token)
		|| token.chars().any(|ch| ch.is_ascii_digit())
		|| !token
			.chars()
			.any(|ch| matches!(ch, 'A' | 'E' | 'I' | 'O' | 'U'))
}

fn title_case_artifact(token: &str) -> bool {
	token.chars().next().is_some_and(char::is_uppercase)
		&& token.chars().skip(1).any(char::is_lowercase)
		&& !token.chars().skip(1).any(char::is_uppercase)
}
