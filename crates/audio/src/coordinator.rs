//! Shared microphone and text-to-speech ownership policy.
//!
//! Leases are RAII guards with explicit idempotent `release` methods. Effect
//! callbacks run after the state lock is released, so application adapters may
//! safely update their own vocalizer state.

use std::sync::Arc;

use parking_lot::Mutex;
use strum::{Display, IntoStaticStr};
use thiserror::Error;

/// Full text-to-speech gain outside push-to-talk.
pub const FULL_TTS_GAIN: f32 = 1.0;
/// Text-to-speech gain while a push-to-talk scope is active.
pub const PUSH_TO_TALK_TTS_GAIN: f32 = 0.25;

/// Exclusive user of the default microphone.
#[derive(Clone, Copy, Debug, Display, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "kebab-case")]
pub enum MicrophoneUse {
	/// Local speech-to-text capture.
	SpeechToText,
	/// Realtime live voice.
	Live,
}

/// Application-owned effects driven by audio ownership transitions.
pub trait AudioEffects: Send + Sync + 'static {
	/// Suspend or resume local text-to-speech. A transition is emitted only
	/// when the outermost suspension is acquired or released.
	fn set_tts_suspended(&self, suspended: bool);

	/// Set local text-to-speech render gain. A transition is emitted only when
	/// the first push-to-talk scope starts or the last one ends.
	fn set_tts_gain(&self, gain: f32);
}

/// Errors from microphone ownership or push-to-talk acquisition.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum CoordinatorError {
	/// Another voice surface currently owns the microphone.
	#[error("cannot start {requested} microphone capture while {held_by} owns the microphone")]
	MicrophoneBusy {
		/// Requested microphone use.
		requested: MicrophoneUse,
		/// Current exclusive microphone owner.
		held_by:   MicrophoneUse,
	},
	/// Push-to-talk was requested from a live or already-restored lease.
	#[error("push-to-talk ducking requires an active speech-to-text microphone lease")]
	PushToTalkRequiresSpeechToText,
}

#[derive(Clone, Copy)]
struct ActiveMicrophone {
	id:    u64,
	owner: MicrophoneUse,
}

struct State {
	next_id:     u64,
	microphone:  Option<ActiveMicrophone>,
	suspensions: usize,
	ducks:       usize,
}

#[derive(Default)]
struct EffectsTransition {
	suspended: Option<bool>,
	gain:      Option<f32>,
}

struct Inner {
	state:      Mutex<State>,
	transition: Mutex<()>,
	effects:    Arc<dyn AudioEffects>,
}

impl Inner {
	fn apply(&self, transition: EffectsTransition) {
		if let Some(suspended) = transition.suspended {
			self.effects.set_tts_suspended(suspended);
		}
		if let Some(gain) = transition.gain {
			self.effects.set_tts_gain(gain);
		}
	}

	fn release_microphone(&self, id: u64) {
		let _transition_gate = self.transition.lock();
		let transition = {
			let mut state = self.state.lock();
			let Some(active) = state.microphone else {
				return;
			};
			if active.id != id {
				return;
			}
			state.microphone = None;
			let mut transition = EffectsTransition::default();
			if active.owner == MicrophoneUse::Live {
				state.suspensions -= 1;
				if state.suspensions == 0 {
					transition.suspended = Some(false);
				}
			}
			if active.owner == MicrophoneUse::SpeechToText && state.ducks != 0 {
				state.ducks = 0;
				transition.gain = Some(FULL_TTS_GAIN);
			}
			transition
		};
		self.apply(transition);
	}

	fn acquire_duck(&self, microphone_id: u64) -> Result<(), CoordinatorError> {
		let _transition_gate = self.transition.lock();
		let transition = {
			let mut state = self.state.lock();
			let Some(active) = state.microphone else {
				return Err(CoordinatorError::PushToTalkRequiresSpeechToText);
			};
			if active.id != microphone_id || active.owner != MicrophoneUse::SpeechToText {
				return Err(CoordinatorError::PushToTalkRequiresSpeechToText);
			}
			state.ducks += 1;
			EffectsTransition {
				gain: (state.ducks == 1).then_some(PUSH_TO_TALK_TTS_GAIN),
				..EffectsTransition::default()
			}
		};
		self.apply(transition);
		Ok(())
	}

	fn release_duck(&self, microphone_id: u64) {
		let _transition_gate = self.transition.lock();
		let transition = {
			let mut state = self.state.lock();
			if !state.microphone.is_some_and(|active| {
				active.id == microphone_id && active.owner == MicrophoneUse::SpeechToText
			}) || state.ducks == 0
			{
				return;
			}
			state.ducks -= 1;
			EffectsTransition {
				gain: (state.ducks == 0).then_some(FULL_TTS_GAIN),
				..EffectsTransition::default()
			}
		};
		self.apply(transition);
	}

	fn release_suspension(&self) {
		let _transition_gate = self.transition.lock();
		let transition = {
			let mut state = self.state.lock();
			if state.suspensions == 0 {
				return;
			}
			state.suspensions -= 1;
			EffectsTransition {
				suspended: (state.suspensions == 0).then_some(false),
				..EffectsTransition::default()
			}
		};
		self.apply(transition);
	}
}

/// Cloneable authority for microphone, TTS suspension, and push-to-talk
/// ownership.
#[derive(Clone)]
pub struct AudioCoordinator {
	inner: Arc<Inner>,
}

impl AudioCoordinator {
	/// Construct a coordinator around application-owned audio effects.
	pub fn new<E>(effects: Arc<E>) -> Self
	where
		E: AudioEffects,
	{
		Self {
			inner: Arc::new(Inner {
				state: Mutex::new(State {
					next_id:     1,
					microphone:  None,
					suspensions: 0,
					ducks:       0,
				}),
				transition: Mutex::new(()),
				effects,
			}),
		}
	}

	/// Acquire the microphone for local speech-to-text.
	pub fn acquire_speech_to_text(&self) -> Result<MicrophoneLease, CoordinatorError> {
		self.acquire_microphone(MicrophoneUse::SpeechToText)
	}

	/// Acquire the microphone for live voice and suspend local TTS for the
	/// lifetime of the lease.
	pub fn acquire_live(&self) -> Result<MicrophoneLease, CoordinatorError> {
		self.acquire_microphone(MicrophoneUse::Live)
	}

	/// Suspend local TTS independently of microphone ownership. Nested scopes
	/// restore TTS only after their last idempotent release.
	pub fn suspend_tts(&self) -> TtsSuspensionLease {
		let _transition_gate = self.inner.transition.lock();
		let transition = {
			let mut state = self.inner.state.lock();
			state.suspensions += 1;
			EffectsTransition {
				suspended: (state.suspensions == 1).then_some(true),
				..EffectsTransition::default()
			}
		};
		self.inner.apply(transition);
		TtsSuspensionLease { inner: Some(Arc::clone(&self.inner)) }
	}

	/// Return the current exclusive microphone owner.
	pub fn active_microphone(&self) -> Option<MicrophoneUse> {
		self
			.inner
			.state
			.lock()
			.microphone
			.map(|active| active.owner)
	}

	fn acquire_microphone(&self, owner: MicrophoneUse) -> Result<MicrophoneLease, CoordinatorError> {
		let _transition_gate = self.inner.transition.lock();
		let (id, transition) = {
			let mut state = self.inner.state.lock();
			if let Some(active) = state.microphone {
				return Err(CoordinatorError::MicrophoneBusy {
					requested: owner,
					held_by:   active.owner,
				});
			}
			let id = state.next_id;
			state.next_id = state.next_id.wrapping_add(1).max(1);
			state.microphone = Some(ActiveMicrophone { id, owner });
			let mut transition = EffectsTransition::default();
			if owner == MicrophoneUse::Live {
				state.suspensions += 1;
				transition.suspended = (state.suspensions == 1).then_some(true);
			}
			(id, transition)
		};
		self.inner.apply(transition);
		Ok(MicrophoneLease { inner: Some(Arc::clone(&self.inner)), id, owner })
	}
}

/// Exclusive microphone lease. Dropping or explicitly releasing it restores
/// every policy change owned by the lease.
#[must_use]
pub struct MicrophoneLease {
	inner: Option<Arc<Inner>>,
	id:    u64,
	owner: MicrophoneUse,
}

impl MicrophoneLease {
	/// Return the voice surface that owns this lease.
	pub const fn owner(&self) -> MicrophoneUse {
		self.owner
	}

	/// Begin push-to-talk ducking for an active speech-to-text lease.
	pub fn begin_push_to_talk(&self) -> Result<PushToTalkLease, CoordinatorError> {
		let Some(inner) = &self.inner else {
			return Err(CoordinatorError::PushToTalkRequiresSpeechToText);
		};
		inner.acquire_duck(self.id)?;
		Ok(PushToTalkLease { inner: Some(Arc::clone(inner)), microphone_id: self.id })
	}

	/// Release microphone ownership and restore associated TTS state. Repeated
	/// calls are no-ops.
	pub fn release(&mut self) {
		if let Some(inner) = self.inner.take() {
			inner.release_microphone(self.id);
		}
	}
}

impl Drop for MicrophoneLease {
	fn drop(&mut self) {
		self.release();
	}
}

/// Push-to-talk ducking lease nested beneath a speech-to-text microphone
/// lease.
#[must_use]
pub struct PushToTalkLease {
	inner:         Option<Arc<Inner>>,
	microphone_id: u64,
}

impl PushToTalkLease {
	/// Restore full TTS gain when this is the last active ducking scope.
	/// Repeated calls are no-ops.
	pub fn release(&mut self) {
		if let Some(inner) = self.inner.take() {
			inner.release_duck(self.microphone_id);
		}
	}
}

impl Drop for PushToTalkLease {
	fn drop(&mut self) {
		self.release();
	}
}

/// Independent local-TTS suspension lease.
#[must_use]
pub struct TtsSuspensionLease {
	inner: Option<Arc<Inner>>,
}

impl TtsSuspensionLease {
	/// Release this suspension scope. Repeated calls are no-ops.
	pub fn release(&mut self) {
		if let Some(inner) = self.inner.take() {
			inner.release_suspension();
		}
	}
}

impl Drop for TtsSuspensionLease {
	fn drop(&mut self) {
		self.release();
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[derive(Clone, Copy, Debug, PartialEq)]
	enum Event {
		Suspended(bool),
		Gain(f32),
	}

	#[derive(Default)]
	struct RecordingEffects(Mutex<Vec<Event>>);

	impl AudioEffects for RecordingEffects {
		fn set_tts_suspended(&self, suspended: bool) {
			self.0.lock().push(Event::Suspended(suspended));
		}

		fn set_tts_gain(&self, gain: f32) {
			self.0.lock().push(Event::Gain(gain));
		}
	}

	#[test]
	fn stt_and_live_are_mutually_exclusive_in_both_directions() {
		let effects = Arc::new(RecordingEffects::default());
		let coordinator = AudioCoordinator::new(effects);
		let mut stt = coordinator.acquire_speech_to_text().unwrap();
		assert_eq!(coordinator.acquire_live().err().unwrap(), CoordinatorError::MicrophoneBusy {
			requested: MicrophoneUse::Live,
			held_by:   MicrophoneUse::SpeechToText,
		});
		stt.release();
		let _live = coordinator.acquire_live().unwrap();
		assert_eq!(
			coordinator.acquire_speech_to_text().err().unwrap(),
			CoordinatorError::MicrophoneBusy {
				requested: MicrophoneUse::SpeechToText,
				held_by:   MicrophoneUse::Live,
			}
		);
	}

	#[test]
	fn live_and_nested_suspension_restore_once() {
		let effects = Arc::new(RecordingEffects::default());
		let coordinator = AudioCoordinator::new(Arc::clone(&effects));
		let mut manual = coordinator.suspend_tts();
		let mut live = coordinator.acquire_live().unwrap();
		live.release();
		live.release();
		assert_eq!(effects.0.lock().as_slice(), &[Event::Suspended(true)]);
		manual.release();
		manual.release();
		assert_eq!(effects.0.lock().as_slice(), &[Event::Suspended(true), Event::Suspended(false)]);
	}

	#[test]
	fn push_to_talk_ducks_and_microphone_release_restores_idempotently() {
		let effects = Arc::new(RecordingEffects::default());
		let coordinator = AudioCoordinator::new(Arc::clone(&effects));
		let mut stt = coordinator.acquire_speech_to_text().unwrap();
		let mut first = stt.begin_push_to_talk().unwrap();
		let mut second = stt.begin_push_to_talk().unwrap();
		first.release();
		assert_eq!(effects.0.lock().as_slice(), &[Event::Gain(PUSH_TO_TALK_TTS_GAIN)]);
		stt.release();
		stt.release();
		second.release();
		assert_eq!(effects.0.lock().as_slice(), &[
			Event::Gain(PUSH_TO_TALK_TTS_GAIN),
			Event::Gain(FULL_TTS_GAIN)
		]);
	}

	#[test]
	fn live_lease_cannot_start_push_to_talk() {
		let effects = Arc::new(RecordingEffects::default());
		let coordinator = AudioCoordinator::new(effects);
		let live = coordinator.acquire_live().unwrap();
		assert!(matches!(
			live.begin_push_to_talk(),
			Err(CoordinatorError::PushToTalkRequiresSpeechToText)
		));
	}
}
