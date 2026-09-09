//! Production composition boundary for shared audio ownership.
//!
//! The policy state machine remains in [`omp_audio::coordinator`]. This module
//! only adapts its suspension and gain transitions to the application's local
//! text-to-speech controller.

use std::sync::Arc;

use omp_audio::coordinator::{
	AudioCoordinator, AudioEffects, MicrophoneLease, PushToTalkLease, TtsSuspensionLease,
};
use parking_lot::Mutex;

/// Application-side local text-to-speech controls consumed by the voice
/// coordinator adapter.
pub trait LocalTtsControl: Send + Sync + 'static {
	/// Suspend or resume creation and playback of local speech.
	fn set_suspended(&self, suspended: bool);

	/// Set render-time playback gain for current and future local speech.
	fn set_gain(&self, gain: f32);
}

struct ApplicationAudioEffects<C> {
	control: Arc<C>,
}

impl<C> AudioEffects for ApplicationAudioEffects<C>
where
	C: LocalTtsControl,
{
	fn set_tts_suspended(&self, suspended: bool) {
		self.control.set_suspended(suspended);
	}

	fn set_tts_gain(&self, gain: f32) {
		self.control.set_gain(gain);
	}
}

/// Application wrapper around the domain-owned audio coordinator.
#[derive(Clone)]
pub struct AppAudioCoordinator {
	domain: AudioCoordinator,
}

impl AppAudioCoordinator {
	/// Compose audio ownership policy with the production local-TTS controller.
	pub fn new<C>(control: Arc<C>) -> Self
	where
		C: LocalTtsControl,
	{
		let effects = Arc::new(ApplicationAudioEffects { control });
		Self { domain: AudioCoordinator::new(effects) }
	}

	/// Borrow the domain coordinator used by STT, live voice, and vocalization
	/// controllers to acquire their leases.
	pub fn domain(&self) -> &AudioCoordinator {
		&self.domain
	}
}

struct InteractiveTtsControl {
	con: Arc<omp_con::Ctx>,
}

impl LocalTtsControl for InteractiveTtsControl {
	fn set_suspended(&self, suspended: bool) {
		if let Some(vocalizer) = self
			.con
			.user::<omp_chat::notices::voice::VoiceSlot>()
			.and_then(|slot| slot.0.upgrade())
		{
			vocalizer.lock().set_suspended(suspended);
		}
	}

	fn set_gain(&self, gain: f32) {
		if let Some(vocalizer) = self
			.con
			.user::<omp_chat::notices::voice::VoiceSlot>()
			.and_then(|slot| slot.0.upgrade())
		{
			vocalizer.lock().set_gain(gain);
		}
	}
}

#[derive(Default)]
struct InteractiveAudioState {
	stt:        Option<MicrophoneLease>,
	duck:       Option<PushToTalkLease>,
	live:       Option<MicrophoneLease>,
	live_muted: bool,
}

struct InteractiveAudioInner {
	coordinator: AppAudioCoordinator,
	state:       Mutex<InteractiveAudioState>,
}

/// Production session owner for interactive STT and realtime-voice microphone
/// leases.
///
/// A UI transition is acknowledged only after the shared audio authority grants
/// the requested lease. Competing microphone owners therefore fail instead of
/// presenting a synthetic enabled state.
#[derive(Clone)]
pub struct InteractiveAudioController {
	inner: Arc<InteractiveAudioInner>,
}

impl InteractiveAudioController {
	/// Creates one session-scoped controller over the production audio policy.
	pub fn new(con: Arc<omp_con::Ctx>) -> Self {
		let control = Arc::new(InteractiveTtsControl { con });
		Self {
			inner: Arc::new(InteractiveAudioInner {
				coordinator: AppAudioCoordinator::new(control),
				state:       Mutex::new(InteractiveAudioState::default()),
			}),
		}
	}

	/// Returns the shared domain authority used by the native live transport.
	#[must_use]
	pub fn coordinator(&self) -> AudioCoordinator {
		self.inner.coordinator.domain().clone()
	}

	/// Keeps local TTS suspended across deterministic live-media restarts.
	///
	/// Each concrete media attempt owns its own microphone lease. This
	/// session-level guard prevents the gap between attempts from briefly
	/// resuming local speech while the logical live session is still active.
	#[must_use]
	pub fn begin_live_restart_scope(&self) -> TtsSuspensionLease {
		self.inner.coordinator.domain().suspend_tts()
	}

	/// Returns whether STT currently owns the microphone.
	pub fn stt_active(&self) -> bool {
		self.inner.state.lock().stt.is_some()
	}

	/// Returns whether live voice currently owns the microphone.
	pub fn live_active(&self) -> bool {
		self.inner.state.lock().live.is_some()
	}

	/// Acquires the STT microphone lease. Repeated starts are idempotent.
	pub fn start_stt(&self) -> Result<(), omp_audio::coordinator::CoordinatorError> {
		let mut state = self.inner.state.lock();
		if state.stt.is_none() {
			let lease = self.inner.coordinator.domain().acquire_speech_to_text()?;
			let duck = lease.begin_push_to_talk()?;
			state.stt = Some(lease);
			state.duck = Some(duck);
		}
		Ok(())
	}

	/// Releases the STT microphone lease. Repeated stops are idempotent.
	pub fn stop_stt(&self) {
		let mut state = self.inner.state.lock();
		if let Some(mut duck) = state.duck.take() {
			duck.release();
		}
		if let Some(mut lease) = state.stt.take() {
			lease.release();
		}
	}

	/// Toggles the real STT microphone lease and returns its new state.
	pub fn toggle_stt(&self) -> Result<bool, omp_audio::coordinator::CoordinatorError> {
		if self.stt_active() {
			self.stop_stt();
			Ok(false)
		} else {
			self.start_stt()?;
			Ok(true)
		}
	}

	/// Starts live voice after acquiring exclusive microphone ownership.
	pub fn start_live(&self) -> Result<(), omp_audio::coordinator::CoordinatorError> {
		let mut state = self.inner.state.lock();
		if state.live.is_some() {
			return Ok(());
		}
		state.live = Some(self.inner.coordinator.domain().acquire_live()?);
		state.live_muted = false;
		Ok(())
	}

	/// Stops live voice and restores the prior TTS ownership state.
	pub fn stop_live(&self) {
		let mut state = self.inner.state.lock();
		if let Some(mut lease) = state.live.take() {
			lease.release();
		}
		state.live_muted = false;
	}

	/// Returns the effective live microphone mute state.
	pub fn live_muted(&self) -> bool {
		self.inner.state.lock().live_muted
	}

	/// Changes mute state only while a live session owns the microphone.
	pub fn set_live_muted(&self, muted: bool) -> Result<(), &'static str> {
		let mut state = self.inner.state.lock();
		if state.live.is_none() {
			return Err("live voice is not active");
		}
		state.live_muted = muted;
		Ok(())
	}
}

#[cfg(test)]
mod tests {
	use std::{
		future::Future,
		pin::Pin,
		sync::{
			Arc,
			atomic::{AtomicUsize, Ordering},
		},
	};

	use omp_chat::notices::voice::{
		SpeechSynth, SpeechSynthFailure, SynthAudio, SynthConfig, SynthFormat, SynthRequest,
		Vocalizer,
	};
	use omp_core::Str;
	use parking_lot::Mutex;

	use super::InteractiveAudioController;

	struct CountingSynth(AtomicUsize);

	impl SpeechSynth for CountingSynth {
		fn configuration(&self) -> SynthConfig {
			SynthConfig {
				model:       Str::new_static("kokoro"),
				voice:       Str::new_static("af_heart"),
				format:      SynthFormat::Pcm16,
				sample_rate: 24_000,
			}
		}

		fn synthesize(
			&self,
			_request: SynthRequest,
		) -> Pin<Box<dyn Future<Output = Result<SynthAudio, SpeechSynthFailure>> + Send + '_>> {
			Box::pin(async move {
				self.0.fetch_add(1, Ordering::AcqRel);
				Ok(SynthAudio { sample_rate: 24_000, samples: Vec::new() })
			})
		}
	}

	#[test]
	fn interactive_controller_enforces_exclusive_microphone_ownership() {
		let audio = InteractiveAudioController::new(Arc::new(omp_con::Ctx::new()));
		assert_eq!(audio.toggle_stt(), Ok(true));
		assert!(audio.stt_active());
		assert!(audio.start_live().is_err());
		assert_eq!(audio.toggle_stt(), Ok(false));
		audio.start_live().expect("live lease");
		assert!(audio.live_active());
		assert!(audio.set_live_muted(true).is_ok());
		audio.stop_live();
		assert!(!audio.live_active());
		assert!(audio.set_live_muted(false).is_err());
	}

	#[tokio::test]
	async fn live_audio_lease_suspends_the_installed_vocalizer() {
		let con = Arc::new(omp_con::Ctx::new());
		let synth = Arc::new(CountingSynth(AtomicUsize::new(0)));
		let vocalizer = Arc::new(Mutex::new(Vocalizer::new(synth.clone(), Arc::clone(&con))));
		omp_chat::notices::voice::install(&con, Arc::clone(&vocalizer));
		let audio = InteractiveAudioController::new(Arc::clone(&con));

		audio.start_live().expect("live lease");
		vocalizer.lock().push_text(
			omp_chat::notices::voice::SpeechMode::Assistant,
			"This sentence must remain silent.",
		);
		vocalizer
			.lock()
			.message_completed(omp_chat::notices::voice::SpeechMode::Assistant);
		tokio::time::sleep(std::time::Duration::from_millis(20)).await;
		assert_eq!(synth.0.load(Ordering::Acquire), 0);

		audio.stop_live();
		vocalizer.lock().push_text(
			omp_chat::notices::voice::SpeechMode::Assistant,
			"This sentence is audible after release.",
		);
		vocalizer
			.lock()
			.message_completed(omp_chat::notices::voice::SpeechMode::Assistant);
		let deadline = tokio::time::Instant::now() + std::time::Duration::from_secs(1);
		while synth.0.load(Ordering::Acquire) == 0 {
			assert!(tokio::time::Instant::now() < deadline);
			tokio::time::sleep(std::time::Duration::from_millis(5)).await;
		}
	}
}
