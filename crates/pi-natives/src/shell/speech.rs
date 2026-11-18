//! Host speech synthesis for the shell's `say`.
//!
//! JavaScript passes one async handler that serves the application's
//! text-to-speech; this module adapts it to [`SpeechHost`], which `say`
//! speaks through before falling back to the system synthesizer.
//!
//! # Bridge
//! - Every request is one handler round trip, awaited without blocking a
//!   thread: `voices` lists the voices, `speak` resolves once playback ended
//!   (or with the audio of a capture request), `cancel` stops the `speak`
//!   carrying the same `id`.
//! - A response with `configured: false` means the application has no
//!   synthesizer set up, and `say` uses the system's.
//! - A `speak` whose future is dropped (the shell cancelled `say`) queues a
//!   `cancel`, so playback never outlives the command.

use std::{
	fmt, io,
	sync::{
		Arc,
		atomic::{AtomicU32, Ordering},
	},
};

use futures::future::BoxFuture;
use napi::{
	Env, Status,
	bindgen_prelude::{Float32Array, Promise},
	threadsafe_function::{ThreadsafeFunction, ThreadsafeFunctionCallMode},
};
use napi_derive::napi;
use pi_shell::{SpeechAudio, SpeechHost, SpeechOutcome, SpeechRequest, SpeechVoice};

/// What a [`ShellSpeechRequest`] asks of the handler.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[napi(string_enum)]
pub enum ShellSpeechOp {
	/// List the synthesizer's voices.
	#[napi(value = "voices")]
	Voices,
	/// Speak `text`, or synthesize it when `capture` is set.
	#[napi(value = "speak")]
	Speak,
	/// Stop the `speak` request with this `id`.
	#[napi(value = "cancel")]
	Cancel,
}

/// One speech request. Only the fields documented for `op` are set.
#[napi(object, object_from_js = false)]
pub struct ShellSpeechRequest {
	pub op:       ShellSpeechOp,
	/// Identifies a `speak` request to a later `cancel`.
	pub id:       Option<u32>,
	/// `speak`: the text.
	pub text:     Option<String>,
	/// `speak`: the voice asked for (`say -v`), verbatim.
	pub voice:    Option<String>,
	/// `speak`: the rate asked for, in words per minute (`say -r`).
	pub rate:     Option<u32>,
	/// `speak`: return the audio as `samples` instead of playing it.
	pub capture:  Option<bool>,
	/// `voices`, `speak`: answer even when no synthesizer is configured,
	/// because the system has none either.
	pub required: Option<bool>,
}

/// One voice of the application's synthesizer.
#[napi(object, object_to_js = false)]
pub struct ShellSpeechVoice {
	/// The name `say -v` selects it by.
	pub name:   String,
	/// Its locale, `en_US` style.
	pub locale: String,
	/// A line describing it.
	pub sample: String,
}

/// Handler answer.
#[napi(object, object_to_js = false)]
pub struct ShellSpeechResponse {
	/// False when the application has no synthesizer configured and the
	/// request did not require one; nothing was spoken.
	pub configured:  bool,
	/// `voices`: the voices.
	pub voices:      Option<Vec<ShellSpeechVoice>>,
	/// `speak` with `capture`: mono samples in `-1..=1`.
	pub samples:     Option<Float32Array>,
	/// `speak` with `capture`: samples per second.
	pub sample_rate: Option<u32>,
	/// Why the request failed.
	pub error:       Option<String>,
}

/// Weak so an idle session never keeps the event loop alive: every call
/// happens while a shell run's pending promise holds the loop open.
type ShellSpeechHandler = ThreadsafeFunction<
	ShellSpeechRequest,
	Promise<ShellSpeechResponse>,
	ShellSpeechRequest,
	Status,
	true,
	true,
>;

/// The application's speech synthesizer, injected into a shell run.
#[napi(object, object_to_js = false)]
pub struct ShellSpeech {
	/// Serves every request; failures are returned as `error` data rather
	/// than thrown.
	#[napi(ts_type = "(error: Error | null, request: ShellSpeechRequest) => \
	                  Promise<ShellSpeechResponse>")]
	pub handler: ShellSpeechHandler,
}

impl ShellSpeech {
	/// The [`SpeechHost`] backed by this handler.
	pub fn into_host(self) -> Arc<dyn SpeechHost> {
		Arc::new(JsSpeech { handler: Arc::new(self.handler), next_id: AtomicU32::new(1) })
	}
}

struct JsSpeech {
	handler: Arc<ShellSpeechHandler>,
	next_id: AtomicU32,
}

impl fmt::Debug for JsSpeech {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		f.debug_struct("JsSpeech").finish_non_exhaustive()
	}
}

impl ShellSpeechRequest {
	const fn new(op: ShellSpeechOp) -> Self {
		Self { op, id: None, text: None, voice: None, rate: None, capture: None, required: None }
	}
}

fn handler_failure(err: &napi::Error) -> io::Error {
	io::Error::other(format!("speech handler failed: {}", err.reason))
}

/// One handler round trip; an `error` answer becomes an [`io::Error`].
async fn call(
	handler: &ShellSpeechHandler,
	request: ShellSpeechRequest,
) -> io::Result<ShellSpeechResponse> {
	let promise = handler
		.call_async(Ok(request))
		.await
		.map_err(|err| handler_failure(&err))?;
	let mut response = promise.await.map_err(|err| handler_failure(&err))?;
	match response.error.take() {
		Some(error) => Err(io::Error::other(error)),
		None => Ok(response),
	}
}

/// Queues `cancel` for a `speak` whose future was dropped before it ended.
struct CancelOnDrop {
	handler: Arc<ShellSpeechHandler>,
	id:      u32,
	armed:   bool,
}

impl Drop for CancelOnDrop {
	fn drop(&mut self) {
		if !self.armed {
			return;
		}
		let mut request = ShellSpeechRequest::new(ShellSpeechOp::Cancel);
		request.id = Some(self.id);
		// Needs no runtime and never blocks. The returned promise is still
		// consumed, so a rejection is never left unhandled.
		let _ = self.handler.call_with_return_value(
			Ok(request),
			ThreadsafeFunctionCallMode::NonBlocking,
			|_: napi::Result<Promise<ShellSpeechResponse>>, _: Env| Ok(()),
		);
	}
}

impl SpeechHost for JsSpeech {
	fn voices(&self, required: bool) -> BoxFuture<'static, io::Result<Option<Vec<SpeechVoice>>>> {
		let handler = Arc::clone(&self.handler);
		Box::pin(async move {
			let mut request = ShellSpeechRequest::new(ShellSpeechOp::Voices);
			request.required = Some(required);
			let response = call(&handler, request).await?;
			if !response.configured {
				return Ok(None);
			}
			let voices = response.voices.unwrap_or_default();
			Ok(Some(
				voices
					.into_iter()
					.map(|ShellSpeechVoice { name, locale, sample }| SpeechVoice {
						name,
						locale,
						sample,
					})
					.collect(),
			))
		})
	}

	fn speak(&self, request: SpeechRequest) -> BoxFuture<'static, io::Result<SpeechOutcome>> {
		let handler = Arc::clone(&self.handler);
		let id = self.next_id.fetch_add(1, Ordering::Relaxed);
		Box::pin(async move {
			let SpeechRequest { text, voice, rate, capture, required } = request;
			let mut cancel = CancelOnDrop { handler: Arc::clone(&handler), id, armed: true };
			let response = call(&handler, ShellSpeechRequest {
				op: ShellSpeechOp::Speak,
				id: Some(id),
				text: Some(text),
				voice,
				rate,
				capture: Some(capture),
				required: Some(required),
			})
			.await;
			cancel.armed = false;
			let response = response?;
			if !response.configured {
				return Ok(SpeechOutcome::Unconfigured);
			}
			Ok(match response.samples {
				Some(samples) if capture => SpeechOutcome::Captured(SpeechAudio {
					samples:     samples.to_vec(),
					sample_rate: response.sample_rate.unwrap_or_default(),
				}),
				_ => SpeechOutcome::Spoken,
			})
		})
	}
}
