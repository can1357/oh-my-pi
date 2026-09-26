use std::path::PathBuf;

use crate::{Config, Method, Predictor, Query};

/// A private state directory, removed on drop.
struct StateDir(PathBuf);

impl StateDir {
	fn new(name: &str) -> Self {
		let dir =
			std::env::temp_dir().join(format!("pi-predict-ngram-{}-{name}", std::process::id()));
		let _ = std::fs::remove_dir_all(&dir);
		Self(dir)
	}

	fn open(&self) -> anyhow::Result<Box<dyn Predictor>> {
		crate::open(Method::Ngram, &Config { state_dir: self.0.clone(), ..Config::default() })
	}
}

impl Drop for StateDir {
	fn drop(&mut self) {
		let _ = std::fs::remove_dir_all(&self.0);
	}
}

fn suffix(engine: &mut dyn Predictor, before: &str, prefix: &str) -> Option<String> {
	engine
		.complete(&Query { before, prefix })
		.map(|hint| hint.suffix)
}

fn observe_times(engine: &mut dyn Predictor, prompt: &str, times: usize) {
	for _ in 0..times {
		engine.observe(prompt);
	}
}

#[test]
fn finished_word_holds_its_own_mass() {
	let dir = StateDir::new("finished");
	let mut engine = dir.open().unwrap();
	assert_eq!(suffix(engine.as_mut(), "", "th").as_deref(), Some("e"));
	// `the` is itself the likeliest word, so no longer word clears the gate.
	assert_eq!(suffix(engine.as_mut(), "", "the"), None);
}

#[test]
fn typed_past_word_is_not_offered_again() {
	let dir = StateDir::new("typed-past");
	let mut engine = dir.open().unwrap();
	observe_times(engine.as_mut(), "can you refactor the parser module", 20);
	observe_times(engine.as_mut(), "the refactoring went well overall", 8);
	assert_eq!(suffix(engine.as_mut(), "can you ", "re").as_deref(), Some("factor"));
	// Having typed past `refactor` at `re`, the user wants something else.
	assert_eq!(suffix(engine.as_mut(), "can you ", "ref").as_deref(), Some("actoring"));
}

#[test]
fn one_off_typos_are_never_offered() {
	let dir = StateDir::new("hygiene");
	let mut engine = dir.open().unwrap();
	engine.observe("please check the iterastion count and the zqorbit value");
	let typo = "iterastion";
	for k in 2..typo.len() {
		assert_ne!(suffix(engine.as_mut(), "check the ", &typo[..k]).as_deref(), Some(&typo[k..]));
	}
	assert_ne!(suffix(engine.as_mut(), "the ", "zq").as_deref(), Some("orbit"));
	// Jargon the user keeps typing graduates.
	observe_times(engine.as_mut(), "please check the zqorbit value", 2);
	assert_eq!(suffix(engine.as_mut(), "the ", "zq").as_deref(), Some("orbit"));
}

#[test]
fn learned_casing_beats_the_allcaps_rule() {
	let dir = StateDir::new("casing");
	let mut engine = dir.open().unwrap();
	observe_times(engine.as_mut(), "log in with OAuth and open the PRs page", 4);
	assert_eq!(suffix(engine.as_mut(), "log in with ", "OA").as_deref(), Some("uth"));
	assert_eq!(suffix(engine.as_mut(), "open the ", "PR").as_deref(), Some("s"));
	assert_eq!(suffix(engine.as_mut(), "log in with ", "oa").as_deref(), Some("uth"));
}

#[test]
fn snapshot_round_trips_and_rejects_unknown_versions() {
	let dir = StateDir::new("snapshot");
	let queries = [
		("can you ", "ref"),
		("log in with ", "OA"),
		("", "th"),
		("please check the ", "zq"),
		("the ", "par"),
	];
	let mut engine = dir.open().unwrap();
	observe_times(engine.as_mut(), "can you refactor the parser module", 5);
	observe_times(engine.as_mut(), "log in with OAuth then check the zqorbit value", 3);
	let expected: Vec<_> = queries
		.iter()
		.map(|&(before, prefix)| engine.complete(&Query { before, prefix }))
		.collect();
	engine.persist().unwrap();
	drop(engine);

	let mut restored = dir.open().unwrap();
	let actual: Vec<_> = queries
		.iter()
		.map(|&(before, prefix)| restored.complete(&Query { before, prefix }))
		.collect();
	assert_eq!(actual, expected);
	assert!(actual.iter().filter(|hint| hint.is_some()).count() >= 4);

	let path = dir.0.join("ngram.snapshot");
	let bytes = std::fs::read(&path).unwrap();
	let mut future = bytes.clone();
	future[8] = future[8].wrapping_add(1);
	std::fs::write(&path, &future).unwrap();
	assert!(dir.open().is_err());
	std::fs::write(&path, &bytes[..bytes.len() - 7]).unwrap();
	assert!(dir.open().is_err());
}

#[test]
fn single_letters_complete_from_context_but_finished_words_stay_bare() {
	let dir = StateDir::new("single-letter");
	let mut engine = dir.open().unwrap();
	observe_times(engine.as_mut(), "can you help me figure out why the build fails", 3);
	observe_times(engine.as_mut(), "I need to figure out the release notes", 2);
	assert_eq!(suffix(engine.as_mut(), "Can you help me figure ", "o").as_deref(), Some("ut"));
	// Typing on past the single-letter ghost rules `out` out.
	assert_ne!(suffix(engine.as_mut(), "Can you help me figure ", "ou").as_deref(), Some("t"));
	// `a` is a word of its own: no ghost after the single letter.
	assert_eq!(suffix(engine.as_mut(), "can you give me ", "a"), None);
	assert_eq!(suffix(engine.as_mut(), "", "I"), None);
}
