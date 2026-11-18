//! The speech synthesizer of the embedding application, as `say` reaches it.
//!
//! A host that has text-to-speech of its own hands an implementation to
//! [`Invocation::speech`](crate::extras::Invocation::speech); `say` then
//! speaks through it and falls back to the system synthesizer only when the
//! host reports none configured.

use std::{fmt, io};

use futures::future::BoxFuture;

/// One utterance for [`SpeechHost::speak`].
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SpeechRequest {
	/// The text to speak.
	pub text:     String,
	/// The voice asked for (`say -v`), verbatim; the host maps it onto one of
	/// its own and ignores a name it does not know.
	pub voice:    Option<String>,
	/// The speaking rate asked for, in words per minute (`say -r`).
	pub rate:     Option<u32>,
	/// Return the audio ([`SpeechOutcome::Captured`]) instead of playing it.
	pub capture:  bool,
	/// Synthesize even when the host has no synthesizer configured: nothing
	/// else on the machine can speak.
	pub required: bool,
}

/// Mono audio a [`SpeechHost`] synthesized.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct SpeechAudio {
	/// Samples in `-1.0..=1.0`.
	pub samples:     Vec<f32>,
	/// Samples per second.
	pub sample_rate: u32,
}

/// How a [`SpeechHost::speak`] call ended.
#[derive(Clone, Debug, PartialEq)]
pub enum SpeechOutcome {
	/// The host has no synthesizer configured and the request did not
	/// require one; nothing was spoken.
	Unconfigured,
	/// The text was played to its end.
	Spoken,
	/// The audio of a [`SpeechRequest::capture`] request.
	Captured(SpeechAudio),
}

/// One voice of a [`SpeechHost`], as `say -v '?'` lists it.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SpeechVoice {
	/// The name `say -v` selects it by.
	pub name:   String,
	/// Its locale, `en_US` style.
	pub locale: String,
	/// A line describing it.
	pub sample: String,
}

/// The embedding application's speech synthesizer.
pub trait SpeechHost: fmt::Debug + Send + Sync {
	/// The voices the host speaks with; `None` when it has no synthesizer
	/// configured and `required` is false.
	fn voices(&self, required: bool) -> BoxFuture<'static, io::Result<Option<Vec<SpeechVoice>>>>;

	/// Speaks (or captures) `request`, resolving once playback ended.
	/// Dropping the future stops the speech.
	fn speak(&self, request: SpeechRequest) -> BoxFuture<'static, io::Result<SpeechOutcome>>;
}
