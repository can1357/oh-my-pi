//! Observer-local `/live` voice surface.
//!
//! The application owns microphones, provider transport, reconnect policy,
//! and delegated agent work. This panel is a retained projection of typed
//! [`LiveUiEvent`] values and emits typed [`LiveControl`] requests; it never
//! reads or mutates controller state (ADR 0005).

use std::{
	fmt::Write as _,
	time::{Duration, Instant},
};

use omp_core::{Str, StrMut, sf};
use omp_tui::{
	Component, Frame, Key, MouseReport, PaintCtx, Prop, Props, Rect, Size, Slot, Style, Ui,
	UiContext, UiEvent, cell_width, dom, next_slot,
};
use strum::{Display, IntoStaticStr};

use super::{Panel, PanelAnchor, PanelCx, PanelEvent, PanelNote};

/// Codex-backed realtime model. It is intentionally not the chat model.
pub const LIVE_MODEL: &str = "gpt-live-1-codex";
/// Visualizer and peak-decay cadence.
const FRAME_INTERVAL: Duration = Duration::from_millis(80);
/// Meter value used by the reusable progress component.
const LEVEL_MAX: u16 = 100;
/// Voices accepted by the Codex live endpoint, in display order.
pub const LIVE_VOICES: &[&str] =
	&["arbor", "breeze", "cove", "ember", "juniper", "maple", "sol", "spruce", "vale"];

/// Clamps a native RMS level to the integer percentage carried by
/// [`LiveUiEvent::Levels`].
#[must_use]
pub fn level_percent(level: f32) -> u16 {
	if !level.is_finite() || level <= 0.0 {
		0
	} else {
		(level.min(1.0) * f32::from(LEVEL_MAX)).round() as u16
	}
}

/// Realtime-call presentation phase.
#[derive(Clone, Copy, Debug, Display, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase")]
pub enum LivePhase {
	/// Waiting for the operating system's microphone decision.
	Permission,
	/// Establishing signaling, media, and sideband channels.
	Connecting,
	/// Retrying a recoverable transport failure.
	Reconnecting,
	/// Waiting for caller audio.
	Listening,
	/// Running a delegated coding turn.
	Working,
	/// Playing realtime assistant audio.
	Speaking,
	/// Connected with caller audio suppressed.
	Muted,
	/// Gracefully releasing call resources.
	Closing,
	/// Terminal or recoverable failure.
	Error,
}

/// Speaker represented by a live transcript update.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LiveTranscriptRole {
	/// Caller microphone transcript.
	User,
	/// Realtime assistant transcript.
	Assistant,
}

/// Incremental or finalized transcript for one role-local turn.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveTranscript {
	/// Transcript speaker.
	pub role:      LiveTranscriptRole,
	/// Monotonic role-local turn number.
	pub turn:      u64,
	/// Latest complete text for the turn.
	pub text:      Str,
	/// Whether this turn text is final.
	pub finalized: bool,
}

/// Privacy-safe operating-system network-interface class.
#[derive(Clone, Copy, Debug, Display, Eq, IntoStaticStr, PartialEq)]
pub enum LivePathClass {
	/// Wi-Fi interface.
	#[strum(serialize = "Wi-Fi")]
	Wifi,
	/// Cellular interface.
	Cellular,
	/// Wired Ethernet interface.
	#[strum(serialize = "Ethernet")]
	Wired,
	/// Loopback interface.
	Loopback,
	/// Another operating-system interface class.
	Other,
}

/// Privacy-safe class of one candidate in the selected ICE pair.
#[derive(Clone, Copy, Debug, Display, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "kebab-case")]
pub enum LiveIceCandidateClass {
	/// Candidate gathered from a local interface.
	Host,
	/// Candidate discovered through a STUN binding.
	ServerReflexive,
	/// Candidate discovered from the remote peer during connectivity checks.
	PeerReflexive,
	/// Candidate allocated through a relay.
	Relay,
}

/// Aggregate routing mode of the selected ICE pair.
#[derive(Clone, Copy, Debug, Display, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase")]
pub enum LiveIcePathKind {
	/// Neither selected candidate uses a relay.
	Direct,
	/// At least one selected candidate uses a relay.
	Relay,
}

/// Privacy-redacted selected ICE candidate pair.
///
/// This type is deliberately closed over candidate classes and aggregate
/// routing; it cannot carry addresses, ports, credentials, interface names,
/// or SSIDs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LiveIcePathFacts {
	/// Local candidate class.
	pub local:  LiveIceCandidateClass,
	/// Remote candidate class.
	pub remote: LiveIceCandidateClass,
	/// Aggregate relay/direct routing mode.
	pub kind:   LiveIcePathKind,
}

/// Redacted facts from the operating system's active network path.
///
/// This deliberately cannot carry addresses, SSIDs, gateways, proxy values,
/// or native path handles.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LivePathFacts {
	/// Whether the operating system currently has a satisfied path.
	pub available:   bool,
	/// Sanitized operating-system interface identity, such as `en0`.
	pub interface:   Option<Str>,
	/// Native interface class.
	pub class:       Option<LivePathClass>,
	/// Native constrained-data flag, when the platform exposes it.
	pub constrained: Option<bool>,
	/// Native metered-network flag, when the platform exposes it.
	pub metered:     Option<bool>,
	/// Native expensive-network flag, when the platform exposes it.
	pub expensive:   Option<bool>,
}

/// One selectable audio endpoint published by the application's device host.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveDevice {
	/// Stable platform device identity.
	pub id:         Str,
	/// Human-readable device label.
	pub label:      Str,
	/// Whether the operating system currently uses this endpoint by default.
	pub is_default: bool,
	/// Whether this endpoint is currently selected.
	pub selected:   bool,
}

/// Operating-system microphone permission state.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MicrophonePermission {
	/// The platform cannot distinguish authorization before capture opens.
	Unknown,
	/// Permission has not settled yet.
	Requesting,
	/// Capture may open.
	Granted,
	/// The user denied capture.
	Denied,
	/// Device policy prevents capture and user retry cannot change it.
	Restricted,
	/// Native microphone capture is unavailable.
	Unavailable,
}

/// Typed observer event posted by the live controller through `HostMailbox`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LiveUiEvent {
	/// Call phase changed.
	Phase(LivePhase),
	/// Microphone permission changed.
	Permission(MicrophonePermission),
	/// Clamped RMS levels as integer percentages.
	Levels {
		/// Microphone input level.
		input:  u16,
		/// Speaker output level.
		output: u16,
	},
	/// Incremental or final transcript changed.
	Transcript(LiveTranscript),
	/// Effective mute state changed.
	Muted(bool),
	/// Available input and output endpoints changed.
	Devices {
		/// Microphone endpoints.
		input:  Vec<LiveDevice>,
		/// Speaker endpoints.
		output: Vec<LiveDevice>,
	},
	/// Privacy-redacted operating-system network-path facts changed.
	Path(LivePathFacts),
	/// Privacy-redacted selected ICE path changed or was reset.
	IcePath(Option<LiveIcePathFacts>),
	/// A recoverable reconnect attempt is scheduled or underway.
	Reconnect {
		/// One-based attempt number.
		attempt:  u8,
		/// Maximum attempts before the error becomes terminal.
		maximum:  u8,
		/// Exact backoff selected by the controller.
		delay:    Duration,
		/// The controller's authoritative retry deadline.
		deadline: Instant,
	},
	/// Classified controller failure.
	Error {
		/// User-facing diagnostic.
		message:     Str,
		/// Whether `R` may retry in place.
		recoverable: bool,
	},
	/// Controller cleanup completed.
	Closed,
}

impl LiveUiEvent {
	/// Projects a provider-neutral inference event into observer-only live UI
	/// state. Audio bytes and delegation requests stay with the controller.
	#[must_use]
	pub fn from_realtime(event: &omp_ai::answer::RealtimeEvent) -> Option<Self> {
		use omp_ai::answer::{RealtimeEvent, RealtimePhase, RealtimeTranscriptRole};

		match event {
			RealtimeEvent::Ready => Some(Self::Phase(LivePhase::Listening)),
			RealtimeEvent::Phase(phase) => Some(Self::Phase(match phase {
				RealtimePhase::Connecting => LivePhase::Connecting,
				RealtimePhase::Listening => LivePhase::Listening,
				RealtimePhase::Working => LivePhase::Working,
				RealtimePhase::Speaking => LivePhase::Speaking,
				RealtimePhase::Muted => LivePhase::Muted,
				RealtimePhase::Closing => LivePhase::Closing,
				RealtimePhase::Error => LivePhase::Error,
			})),
			RealtimeEvent::Transcript(transcript) => Some(Self::Transcript(LiveTranscript {
				role:      match transcript.role {
					RealtimeTranscriptRole::User => LiveTranscriptRole::User,
					RealtimeTranscriptRole::Assistant => LiveTranscriptRole::Assistant,
				},
				turn:      transcript.turn,
				text:      transcript.text.clone(),
				finalized: transcript.finalized,
			})),
			RealtimeEvent::Muted(muted) => Some(Self::Muted(*muted)),
			RealtimeEvent::CloseReceipt(_) | RealtimeEvent::Closed => Some(Self::Closed),
			RealtimeEvent::Chat(_)
			| RealtimeEvent::Audio(_)
			| RealtimeEvent::InputCommitted
			| RealtimeEvent::Delegation(_) => None,
		}
	}
}

/// Requests emitted by the live panel to the controller.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum LiveControl {
	/// Start a call with the archived voice/device choices.
	Start,
	/// Gracefully stop the call and close the panel.
	Stop,
	/// Toggle microphone input while keeping output connected.
	ToggleMute,
	/// Retry a recoverable failed connection.
	Reconnect,
	/// Select and archive a realtime voice.
	SelectVoice(Str),
	/// Select and archive a microphone endpoint.
	SelectInputDevice(Str),
	/// Select and archive a speaker endpoint.
	SelectOutputDevice(Str),
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum Picker {
	Voice,
	Input,
	Output,
}

#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct TranscriptState {
	turn:      u64,
	text:      Str,
	finalized: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct LiveReconnectState {
	attempt:  u8,
	maximum:  u8,
	delay:    Duration,
	deadline: Duration,
}

impl LiveReconnectState {
	fn remaining(self, now: Duration) -> Duration {
		self.deadline.saturating_sub(now).min(self.delay)
	}

	fn remaining_ms(self, now: Duration) -> u64 {
		u64::try_from(self.remaining(now).as_millis()).unwrap_or(u64::MAX)
	}

	fn write_label(self, out: &mut impl std::fmt::Write, now: Duration) {
		let _ = write!(out, "Reconnecting · attempt {} of {}", self.attempt, self.maximum);
		let remaining = self.remaining_ms(now);
		if remaining > 0 {
			let _ = out.write_str(" · retrying in ");
			let _ = crate::notices::write_duration(out, remaining);
			let _ = out.write_char('…');
		}
	}
}

/// Pure retained reducer for the `/live` actor.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LiveViewState {
	phase:          LivePhase,
	permission:     Option<MicrophonePermission>,
	muted:          bool,
	input_level:    u16,
	output_level:   u16,
	input_peak:     u16,
	output_peak:    u16,
	user:           TranscriptState,
	assistant:      TranscriptState,
	input_devices:  Vec<LiveDevice>,
	output_devices: Vec<LiveDevice>,
	voice:          Str,
	path_label:     Option<Str>,
	ice_path_label: Option<Str>,
	reconnect:      Option<LiveReconnectState>,
	error:          Option<(Str, bool)>,
	closed:         bool,
}

fn ice_path_label(facts: LiveIcePathFacts) -> Str {
	let mut label = StrMut::with_capacity(72);
	let _ = write!(label, "ICE · {} · local {} · remote {}", facts.kind, facts.local, facts.remote);
	label.freeze()
}

fn path_label(facts: &LivePathFacts) -> Str {
	let mut label = StrMut::with_capacity(80);
	let _ = label.write_str("Network · ");
	if !facts.available {
		let _ = label.write_str("unavailable");
		return label.freeze();
	}
	match (facts.class, facts.interface.as_deref()) {
		(Some(class), Some(interface)) => {
			let _ = write!(label, "{class} ({interface})");
		},
		(Some(class), None) => {
			let _ = write!(label, "{class}");
		},
		(None, Some(interface)) => {
			let _ = label.write_str(interface);
		},
		(None, None) => {
			let _ = label.write_str("system default");
		},
	}
	if facts.constrained == Some(true) {
		let _ = label.write_str(" · constrained");
	}
	if facts.metered == Some(true) {
		let _ = label.write_str(" · metered");
	}
	if facts.expensive == Some(true) {
		let _ = label.write_str(" · expensive");
	}
	label.freeze()
}

impl LiveViewState {
	/// Creates the connecting state for a new call.
	#[must_use]
	pub fn new(voice: impl Into<Str>) -> Self {
		let voice = voice.into();
		let voice = if LIVE_VOICES.contains(&voice.as_str()) {
			voice
		} else {
			Str::new_static("sol")
		};
		Self {
			phase: LivePhase::Connecting,
			permission: None,
			muted: false,
			input_level: 0,
			output_level: 0,
			input_peak: 0,
			output_peak: 0,
			user: TranscriptState::default(),
			assistant: TranscriptState::default(),
			input_devices: Vec::new(),
			output_devices: Vec::new(),
			voice,
			path_label: None,
			ice_path_label: None,
			reconnect: None,
			error: None,
			closed: false,
		}
	}

	/// Applies one controller event. Stale role-local transcript updates are
	/// ignored so an async final cannot replace a newer turn.
	pub fn apply(&mut self, event: &LiveUiEvent) {
		self.apply_at(event, Duration::ZERO, Instant::now());
	}

	fn apply_at(&mut self, event: &LiveUiEvent, now: Duration, observed_at: Instant) {
		match event {
			LiveUiEvent::Phase(phase) => {
				self.phase = *phase;
				self.reconnect = None;
				if matches!(phase, LivePhase::Reconnecting | LivePhase::Closing) {
					self.ice_path_label = None;
				}
				if *phase != LivePhase::Error {
					self.error = None;
				}
			},
			LiveUiEvent::Permission(permission) => {
				self.reconnect = None;
				self.permission = Some(*permission);
				self.phase = match permission {
					MicrophonePermission::Unknown | MicrophonePermission::Requesting => {
						LivePhase::Permission
					},
					MicrophonePermission::Granted => LivePhase::Connecting,
					MicrophonePermission::Denied
					| MicrophonePermission::Restricted
					| MicrophonePermission::Unavailable => LivePhase::Error,
				};
				self.error = match permission {
					MicrophonePermission::Denied => Some((
						Str::new_static(
							"Microphone access was denied. Allow access in system settings, then retry.",
						),
						true,
					)),
					MicrophonePermission::Restricted => Some((
						Str::new_static("Microphone access is restricted by system policy."),
						false,
					)),
					MicrophonePermission::Unavailable => Some((
						Str::new_static("No native microphone permission service is available."),
						false,
					)),
					MicrophonePermission::Unknown
					| MicrophonePermission::Requesting
					| MicrophonePermission::Granted => None,
				};
			},
			LiveUiEvent::Levels { input, output } => {
				self.input_level = (*input).min(LEVEL_MAX);
				self.output_level = (*output).min(LEVEL_MAX);
				self.input_peak = self.input_level;
				self.output_peak = self.output_level;
			},
			LiveUiEvent::Transcript(update) => {
				let slot = match update.role {
					LiveTranscriptRole::User => &mut self.user,
					LiveTranscriptRole::Assistant => &mut self.assistant,
				};
				if update.turn < slot.turn {
					return;
				}
				if update.turn == slot.turn && slot.finalized && !update.finalized {
					return;
				}
				slot.turn = update.turn;
				slot.text = update.text.trim().into();
				slot.finalized = update.finalized;
			},
			LiveUiEvent::Muted(muted) => {
				self.reconnect = None;
				self.muted = *muted;
				self.input_level = 0;
				self.input_peak = 0;
				self.phase = if *muted {
					LivePhase::Muted
				} else {
					LivePhase::Listening
				};
			},
			LiveUiEvent::Devices { input, output } => {
				self.input_devices.clone_from(input);
				self.output_devices.clone_from(output);
			},
			LiveUiEvent::Path(facts) => {
				self.path_label = Some(path_label(facts));
			},
			LiveUiEvent::IcePath(facts) => {
				if !self.closed && self.phase != LivePhase::Closing {
					self.ice_path_label = facts.map(ice_path_label);
				}
			},
			LiveUiEvent::Reconnect { attempt, maximum, delay, deadline } => {
				let remaining = deadline.saturating_duration_since(observed_at).min(*delay);
				self.ice_path_label = None;
				self.reconnect = Some(LiveReconnectState {
					attempt:  *attempt,
					maximum:  *maximum,
					delay:    *delay,
					deadline: now.saturating_add(remaining),
				});
				self.phase = LivePhase::Reconnecting;
				self.error = None;
			},
			LiveUiEvent::Error { message, recoverable } => {
				self.reconnect = None;
				self.error = Some((message.clone(), *recoverable));
				self.phase = LivePhase::Error;
			},
			LiveUiEvent::Closed => {
				self.reconnect = None;
				self.ice_path_label = None;
				self.closed = true;
				self.phase = LivePhase::Closing;
				self.input_level = 0;
				self.output_level = 0;
			},
		}
	}
}

/// Countdown projected from the controller's retry deadline.
///
/// This component only schedules paints. It cannot start, delay, or cancel a
/// reconnect, so the transport retains the sole retry timer.
struct LiveReconnectCountdown {
	props: Props,
	slot:  Slot,
	state: LiveReconnectState,
	label: StrMut,
}

impl LiveReconnectCountdown {
	fn new(state: LiveReconnectState, now: Duration) -> Self {
		let mut label = StrMut::with_capacity(72);
		state.write_label(&mut label, now);
		Self { props: Props::new(), slot: next_slot(), state, label }
	}

	fn refresh(&mut self, now: Duration) {
		self.label.truncate(0);
		self.state.write_label(&mut self.label, now);
	}
}

impl Component for LiveReconnectCountdown {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn measure(&mut self, _ctx: &UiContext) -> (u16, u16) {
		(1, cell_width(self.label.as_str()))
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		1
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		if rect.y >= pc.clip || rect.width == 0 {
			return;
		}
		self.refresh(pc.now);
		pc.frame.put(
			rect.x,
			rect.y,
			self.label.as_str(),
			self.props.style(&pc.ctx.theme).fg(pc.ctx.theme.warn),
		);
		if pc.now < self.state.deadline {
			// The wake is presentation-only and is always capped by the exact
			// controller deadline; it never schedules or authorizes transport work.
			pc.wake(self.slot, (pc.now + FRAME_INTERVAL).min(self.state.deadline));
		}
	}
}

/// Allocation-free two-row microphone spectrum used by the live panel.
///
/// The waveform is presentation-only: the controller sends one RMS value and
/// the actor derives animation from its paint frame. ASCII terminals receive
/// the same geometry with `#`/`.` cells.
pub struct LiveSpectrum {
	props: Props,
	slot:  Slot,
	level: u16,
	tone:  LivePhase,
}

impl LiveSpectrum {
	/// Creates a spectrum snapshot.
	#[must_use]
	pub fn new(level: u16, tone: LivePhase) -> Self {
		let mut props = Props::new();
		props.set(Prop::Grow, true);
		Self { props, slot: next_slot(), level: level.min(LEVEL_MAX), tone }
	}
}

impl Component for LiveSpectrum {
	fn props(&self) -> &Props {
		&self.props
	}

	fn props_mut(&mut self) -> &mut Props {
		&mut self.props
	}

	fn slot(&self) -> Slot {
		self.slot
	}

	fn measure(&mut self, _ctx: &UiContext) -> (u16, u16) {
		(2, u16::MAX)
	}

	fn height(&mut self, _ctx: &UiContext, _width: u16) -> u16 {
		2
	}

	fn paint(&mut self, pc: &mut PaintCtx<'_>, rect: Rect) {
		const BLOCKS: [&str; 9] = [" ", "▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
		pc.wake(self.slot, pc.now + FRAME_INTERVAL);
		let energy = if self.tone == LivePhase::Muted {
			0.0
		} else {
			(f32::from(self.level) / 20.0).sqrt().min(1.0)
		};
		let color = match self.tone {
			LivePhase::Muted | LivePhase::Closing => pc.ctx.theme.muted,
			LivePhase::Error => pc.ctx.theme.err,
			_ => pc.ctx.theme.ok,
		};
		let style = Style::new().fg(color);
		let phase = (pc.now.as_millis() / FRAME_INTERVAL.as_millis()) as f32;
		for column in 0..rect.width {
			let x = f32::from(column);
			let carrier = 0.5 + 0.5 * (phase.mul_add(0.43, x * 0.71)).sin();
			let shimmer = 0.5 + 0.5 * (phase.mul_add(0.19, -(x * 1.17))).sin();
			let height =
				(energy * carrier.mul_add(0.5, shimmer.mul_add(0.2, 0.3)) * 16.0).round() as i16;
			for row in 0..rect.height.min(2) {
				let units = (height - i16::try_from((1 - row) * 8).unwrap_or(0)).clamp(0, 8);
				let glyph = if pc.ctx.charset == omp_tui::Charset::Ascii {
					if units > 0 { "#" } else { "." }
				} else {
					BLOCKS[units as usize]
				};
				pc.frame.put(rect.x + column, rect.y + row, glyph, style);
			}
		}
		self.level = self.level.saturating_mul(84) / 100;
	}
}

/// Retained bottom panel replacing the composer while a live call is active.
pub struct LivePanel {
	state:     LiveViewState,
	picker:    Option<Picker>,
	selection: usize,
	ui:        Ui,
	ctx:       UiContext,
	size:      Size,
	now:       Duration,
	next_wake: Option<Duration>,
	pending:   Option<LiveControl>,
}

impl LivePanel {
	/// Opens the visualizer with the currently archived realtime voice.
	#[must_use]
	pub fn open(voice: impl Into<Str>, cx: &PanelCx<'_>) -> Self {
		let mut panel = Self {
			state:     LiveViewState::new(voice),
			picker:    None,
			selection: 0,
			ui:        Ui::from_root(dom! { <col/> }, cx.viewport.width, cx.ui.clone()),
			ctx:       cx.ui.clone(),
			size:      cx.viewport,
			now:       Duration::ZERO,
			next_wake: Some(Duration::ZERO),
			pending:   Some(LiveControl::Start),
		};
		panel.rebuild();
		panel
	}

	/// Current presentation state, for debug inspectors and headless actors.
	#[must_use]
	pub const fn state(&self) -> &LiveViewState {
		&self.state
	}

	fn options(&self, picker: Picker) -> Vec<(Str, Str, bool)> {
		match picker {
			Picker::Voice => LIVE_VOICES
				.iter()
				.copied()
				.map(|voice| {
					(Str::new_static(voice), Str::new_static(voice), voice == self.state.voice.as_str())
				})
				.collect(),
			Picker::Input => self
				.state
				.input_devices
				.iter()
				.map(|device| {
					let label = if device.is_default {
						sf!("{} · system default", device.label)
					} else {
						device.label.clone()
					};
					(device.id.clone(), label, device.selected)
				})
				.collect(),
			Picker::Output => self
				.state
				.output_devices
				.iter()
				.map(|device| {
					let label = if device.is_default {
						sf!("{} · system default", device.label)
					} else {
						device.label.clone()
					};
					(device.id.clone(), label, device.selected)
				})
				.collect(),
		}
	}

	fn open_picker(&mut self, picker: Picker) {
		let options = self.options(picker);
		if options.is_empty() {
			return;
		}
		self.selection = options
			.iter()
			.position(|(_, _, selected)| *selected)
			.unwrap_or(0);
		self.picker = Some(picker);
		self.rebuild();
	}

	fn step(&mut self, delta: isize) {
		let Some(picker) = self.picker else { return };
		let count = self.options(picker).len();
		if count == 0 {
			return;
		}
		self.selection = (self.selection as isize + delta).rem_euclid(count as isize) as usize;
		self.rebuild();
	}

	fn select(&mut self) -> PanelEvent {
		let Some(picker) = self.picker else {
			return PanelEvent::Consumed;
		};
		let Some((id, ..)) = self.options(picker).get(self.selection).cloned() else {
			return PanelEvent::Consumed;
		};
		self.picker = None;
		if picker == Picker::Voice {
			self.state.voice = id.clone();
		}
		self.rebuild();
		PanelEvent::Live(match picker {
			Picker::Voice => LiveControl::SelectVoice(id),
			Picker::Input => LiveControl::SelectInputDevice(id),
			Picker::Output => LiveControl::SelectOutputDevice(id),
		})
	}

	fn control(&mut self, id: &str) -> PanelEvent {
		if let Some(index) = id
			.strip_prefix("live-option:")
			.and_then(|index| index.parse::<usize>().ok())
		{
			self.selection = index;
			return self.select();
		}
		match id {
			"live-mute" => PanelEvent::Live(LiveControl::ToggleMute),
			"live-voice" => {
				self.open_picker(Picker::Voice);
				PanelEvent::Consumed
			},
			"live-input" => {
				self.open_picker(Picker::Input);
				PanelEvent::Consumed
			},
			"live-output" => {
				self.open_picker(Picker::Output);
				PanelEvent::Consumed
			},
			"live-reconnect" => PanelEvent::Live(LiveControl::Reconnect),
			"live-end" => PanelEvent::Live(LiveControl::Stop),
			_ => PanelEvent::Consumed,
		}
	}

	fn rebuild(&mut self) {
		let phase = self.state.phase.to_string();
		let voice = self.state.voice.clone();
		let input = self.state.input_peak;
		let output = self.state.output_peak;
		let spectrum = LiveSpectrum::new(input, self.state.phase);
		let muted = self.state.muted;
		let user = self.state.user.text.clone();
		let user_final = self.state.user.finalized;
		let assistant = self.state.assistant.text.clone();
		let assistant_final = self.state.assistant.finalized;
		let reconnect = self
			.state
			.reconnect
			.map(|state| LiveReconnectCountdown::new(state, self.now));
		let error = self.state.error.clone();
		let path_label = self.state.path_label.clone();
		let ice_path_label = self.state.ice_path_label.clone();
		let can_retry = error.as_ref().is_some_and(|(_, recoverable)| *recoverable);
		let input_name = (!self.state.input_devices.is_empty()).then(|| {
			self
				.state
				.input_devices
				.iter()
				.find(|device| device.selected)
				.map_or_else(|| Str::new_static("Microphone"), |device| device.label.clone())
		});
		let output_name = (!self.state.output_devices.is_empty()).then(|| {
			self
				.state
				.output_devices
				.iter()
				.find(|device| device.selected)
				.map_or_else(|| Str::new_static("Speaker"), |device| device.label.clone())
		});
		let options = self
			.picker
			.map(|picker| self.options(picker))
			.unwrap_or_default();
		let picker_title = self.picker.map(|picker| match picker {
			Picker::Voice => "Voice",
			Picker::Input => "Microphone",
			Picker::Output => "Speaker",
		});
		let compact = self.size.width < 56;
		let status_tone = match self.state.phase {
			LivePhase::Error => "err",
			LivePhase::Muted | LivePhase::Closing => "muted",
			LivePhase::Working | LivePhase::Reconnecting => "warn",
			LivePhase::Speaking => "accent",
			LivePhase::Permission | LivePhase::Connecting => "info",
			LivePhase::Listening => "ok",
		};
		let tree = dom! {
			<box border=round bc={status_tone} pad-x=1 title_pad=3>
				<row kind=title gap=1>
					if matches!(self.state.phase, LivePhase::Connecting | LivePhase::Permission | LivePhase::Working | LivePhase::Reconnecting | LivePhase::Closing) { <spinner kind=status/> }
					else if self.state.phase == LivePhase::Error { <i:error fg=err/> }
					else if muted { <icon name="muted" fg=muted/> }
					else { <icon name="mic" fg={status_tone}/> }
					<text bold fg={status_tone}>{"Live voice"}</text>
					<text fg=muted>{phase}</text>
					<spacer grow/>
					if !compact { <text fg=muted>{"Codex"}</text><text fg=muted>{"·"}</text><text fg=muted>{LIVE_MODEL}</text> }
				</row>
				<col gap=0>
					{spectrum}
					<row gap=1 fg=muted>
						<text>{sf!("mic {input}%")}</text>
						<text>{"·"}</text>
						<text>{sf!("speaker {output}%")}</text>
					</row>
					if !user.is_empty() {
						<row gap=1><text bold fg=accent>{"You"}</text><text fg=accent grow truncate>{user}</text>
							if !user_final { <spinner kind=status/> }
						</row>
					} else {
						<text fg=muted>{if muted { "Microphone muted" } else { "Speak naturally — your words appear here" }}</text>
					}
					if !assistant.is_empty() {
						<row gap=1><text bold fg=output>{"Assistant"}</text><text fg=output grow truncate>{assistant}</text>
							if !assistant_final { <spinner kind=status/> }
						</row>
					}
					if let Some(path_label) = path_label {
						<text fg=muted>{path_label}</text>
					}
					if let Some(ice_path_label) = ice_path_label {
						<text fg=muted>{ice_path_label}</text>
					}
					if let Some(reconnect) = reconnect {
						<row gap=1><spinner kind=status/>{reconnect}</row>
					}
											if let Some((message, _)) = error {
							<callout kind=error>{message}</callout>
						}
						if let Some(title) = picker_title {
						<hr title={title} title_pad=3 bc=muted/>
						for (index, (_, label, selected)) in options.into_iter().enumerate() {
							<row gap=1>
								if index == self.selection { <icon name="cursor" fg=accent/> } else { <pre>{"  "}</pre> }
								if selected { <i:checked fg=ok/> } else { <i:unchecked fg=muted/> }
								<button id={sf!("live-option:{index}")} variant=ghost active={index == self.selection}>{label}</button>
							</row>
						}
						<text fg=muted>{"↑/↓ select · Enter apply · Esc back"}</text>
					} else {
						<row gap=1>
							<button id="live-mute" variant=soft active={muted}>{if muted { "Unmute" } else { "Mute" }}</button>
							<button id="live-voice" variant=soft>{sf!("Voice: {voice}")}</button>
							if let Some(input_name) = input_name { <button id="live-input" variant=ghost>{sf!("Mic: {input_name}")}</button> }
							if let Some(output_name) = output_name { <button id="live-output" variant=ghost>{sf!("Speaker: {output_name}")}</button> }
							if can_retry { <button id="live-reconnect" variant=tint color=warn active>{"Reconnect"}</button> }
							<spacer grow/>
							<button id="live-end" variant=ghost>{"End"}</button>
						</row>
						<text fg=muted>{if compact { "space mute · v voice · esc end" } else { "Space mute · V voice · D microphone · Shift+D speaker · R reconnect · Esc end" }}</text>
					}
				</col>
			</box>
		};
		self.ui = Ui::from_root(tree, self.size.width, self.ctx.clone());
		let _ = self.ui.tick(self.now);
	}
}

impl Panel for LivePanel {
	fn id(&self) -> &'static str {
		"live"
	}

	fn anchor(&self) -> PanelAnchor {
		PanelAnchor::Bottom
	}

	fn key(&mut self, key: Key) -> PanelEvent {
		if self.picker.is_some() {
			return match key {
				Key::Esc => {
					self.picker = None;
					self.rebuild();
					PanelEvent::Consumed
				},
				Key::Up | Key::Char('k') => {
					self.step(-1);
					PanelEvent::Consumed
				},
				Key::Down | Key::Char('j') => {
					self.step(1);
					PanelEvent::Consumed
				},
				Key::Enter | Key::Space => self.select(),
				_ => PanelEvent::Consumed,
			};
		}
		match key {
			Key::Esc | Key::Ctrl('c') => PanelEvent::Live(LiveControl::Stop),
			Key::Space | Key::Char('m' | 'M') => PanelEvent::Live(LiveControl::ToggleMute),
			Key::Char('v' | 'V') => {
				self.open_picker(Picker::Voice);
				PanelEvent::Consumed
			},
			Key::Char('d') => {
				self.open_picker(Picker::Input);
				PanelEvent::Consumed
			},
			Key::Char('D') => {
				self.open_picker(Picker::Output);
				PanelEvent::Consumed
			},
			Key::Char('r' | 'R') if self.state.error.as_ref().is_some_and(|(_, retry)| *retry) => {
				PanelEvent::Live(LiveControl::Reconnect)
			},
			_ => PanelEvent::Consumed,
		}
	}

	fn mouse(&mut self, report: MouseReport) -> PanelEvent {
		match self
			.ui
			.handle_mouse_with_mods(report.col, report.row, report.kind, report.mods)
		{
			UiEvent::Pressed(id) => self.control(id.as_str()),
			UiEvent::Cancel => {
				if self.picker.take().is_some() {
					self.rebuild();
					PanelEvent::Consumed
				} else {
					PanelEvent::Live(LiveControl::Stop)
				}
			},
			_ => PanelEvent::Consumed,
		}
	}

	fn notify(&mut self, note: PanelNote<'_>) -> PanelEvent {
		let PanelNote::Live(event, now) = note else {
			return PanelEvent::Ignored;
		};
		self.now = now;
		self.state.apply_at(event, now, Instant::now());
		if let Some(picker) = self.picker {
			self.selection = self
				.selection
				.min(self.options(picker).len().saturating_sub(1));
		}
		self.rebuild();
		PanelEvent::Consumed
	}

	fn frame(&mut self, viewport: Size) -> &Frame {
		if self.size != viewport {
			self.size = viewport;
			self.rebuild();
		}
		self.ui.frame()
	}

	fn tick(&mut self, now: Duration) -> bool {
		if self.state.closed {
			return false;
		}
		self.now = now;
		self.next_wake = None;
		let start_due = self.pending.is_some();
		start_due | self.ui.tick(now)
	}

	fn next_wake(&self) -> Option<Duration> {
		match (self.next_wake, self.ui.next_wake()) {
			(Some(panel), Some(ui)) => Some(panel.min(ui)),
			(Some(panel), None) => Some(panel),
			(None, ui) => ui,
		}
	}

	fn finished(&self) -> bool {
		self.state.closed
	}

	fn settled(&mut self) -> Option<PanelEvent> {
		self.pending.take().map(PanelEvent::Live)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn reconnect_countdown_uses_the_controller_deadline_and_clears_on_lifecycle_edges() {
		let controller_now = Instant::now();
		let host_now = Duration::from_secs(10);
		let delay = Duration::from_millis(3_200);
		let reconnect =
			LiveUiEvent::Reconnect { attempt: 2, maximum: 5, delay, deadline: controller_now + delay };
		let mut state = LiveViewState::new("sol");
		state.apply_at(&reconnect, host_now, controller_now);
		let scheduled = state.reconnect.expect("scheduled countdown");
		assert_eq!(scheduled.attempt, 2);
		assert_eq!(scheduled.maximum, 5);
		assert_eq!(scheduled.delay, delay);
		assert_eq!(scheduled.deadline, host_now + delay);
		let mut label = String::new();
		scheduled.write_label(&mut label, host_now + Duration::from_millis(200));
		assert_eq!(label, "Reconnecting · attempt 2 of 5 · retrying in 3.0s…");
		let mut countdown =
			Ui::from_root(LiveReconnectCountdown::new(scheduled, host_now), 72, UiContext::default());
		assert!(countdown.tick(host_now));
		assert_eq!(
			omp_tui::frame_text(countdown.frame()),
			"Reconnecting · attempt 2 of 5 · retrying in 3.2s…"
		);
		assert_eq!(countdown.next_wake(), Some(host_now + FRAME_INTERVAL));
		assert!(countdown.tick(scheduled.deadline));
		assert_eq!(omp_tui::frame_text(countdown.frame()), "Reconnecting · attempt 2 of 5");
		assert_eq!(countdown.next_wake(), None);

		state.apply(&LiveUiEvent::Phase(LivePhase::Listening));
		assert!(state.reconnect.is_none(), "a connected phase clears the countdown");
		state.apply_at(&reconnect, host_now, controller_now);
		state.apply(&LiveUiEvent::Phase(LivePhase::Reconnecting));
		assert!(state.reconnect.is_none(), "manual retry has no scheduled countdown");
		state.apply_at(&reconnect, host_now, controller_now);
		state.apply(&LiveUiEvent::Phase(LivePhase::Closing));
		assert!(state.reconnect.is_none(), "session switch clears while the controller closes");
		state.apply_at(&reconnect, host_now, controller_now);
		state.apply(&LiveUiEvent::Closed);
		assert!(state.reconnect.is_none(), "controller close clears the countdown");
	}

	#[test]
	fn permission_states_preserve_recovery_policy() {
		let mut state = LiveViewState::new("sol");
		state.apply(&LiveUiEvent::Permission(MicrophonePermission::Denied));
		assert_eq!(state.phase, LivePhase::Error);
		assert!(
			state
				.error
				.as_ref()
				.is_some_and(|(_, recoverable)| *recoverable)
		);

		state.apply(&LiveUiEvent::Permission(MicrophonePermission::Restricted));
		assert_eq!(state.phase, LivePhase::Error);
		assert!(
			state
				.error
				.as_ref()
				.is_some_and(|(_, recoverable)| !*recoverable)
		);

		state.apply(&LiveUiEvent::Permission(MicrophonePermission::Granted));
		assert_eq!(state.phase, LivePhase::Connecting);
		assert!(state.error.is_none());
	}

	#[test]
	fn path_facts_are_redacted_and_do_not_disturb_the_retry_deadline() {
		let facts = LivePathFacts {
			available:   true,
			interface:   Some(Str::new_static("en0")),
			class:       Some(LivePathClass::Wifi),
			constrained: Some(true),
			metered:     None,
			expensive:   Some(true),
		};
		assert_eq!(path_label(&facts).as_str(), "Network · Wi-Fi (en0) · constrained · expensive");

		let controller_now = Instant::now();
		let delay = Duration::from_secs(2);
		let mut state = LiveViewState::new("sol");
		state.apply_at(
			&LiveUiEvent::Reconnect {
				attempt: 1,
				maximum: 5,
				delay,
				deadline: controller_now + delay,
			},
			Duration::from_secs(4),
			controller_now,
		);
		let deadline = state.reconnect.expect("retry deadline").deadline;
		state.apply(&LiveUiEvent::Path(facts));
		assert_eq!(
			state
				.reconnect
				.expect("path presentation cannot own retry")
				.deadline,
			deadline
		);
		assert_eq!(
			state.path_label.as_deref(),
			Some("Network · Wi-Fi (en0) · constrained · expensive")
		);
	}

	#[test]
	fn selected_ice_path_is_redacted_and_resets_without_disturbing_reconnect() {
		let facts = LiveIcePathFacts {
			local:  LiveIceCandidateClass::Relay,
			remote: LiveIceCandidateClass::Host,
			kind:   LiveIcePathKind::Relay,
		};
		assert_eq!(ice_path_label(facts).as_str(), "ICE · relay · local relay · remote host");

		let controller_now = Instant::now();
		let delay = Duration::from_secs(2);
		let mut state = LiveViewState::new("sol");
		state.apply_at(
			&LiveUiEvent::Reconnect {
				attempt: 1,
				maximum: 5,
				delay,
				deadline: controller_now + delay,
			},
			Duration::from_secs(4),
			controller_now,
		);
		let deadline = state.reconnect.expect("retry deadline").deadline;
		state.apply(&LiveUiEvent::IcePath(Some(facts)));
		assert_eq!(
			state
				.reconnect
				.expect("ICE presentation cannot own retry")
				.deadline,
			deadline
		);
		assert_eq!(state.ice_path_label.as_deref(), Some("ICE · relay · local relay · remote host"));

		state.apply(&LiveUiEvent::IcePath(None));
		assert!(state.ice_path_label.is_none());
		assert_eq!(
			state
				.reconnect
				.expect("ICE reset cannot own retry")
				.deadline,
			deadline
		);

		state.apply(&LiveUiEvent::IcePath(Some(facts)));
		state.apply(&LiveUiEvent::Closed);
		assert!(state.ice_path_label.is_none(), "session close cannot retain an old ICE path");
		state.apply(&LiveUiEvent::IcePath(Some(facts)));
		assert!(
			state.ice_path_label.is_none(),
			"a late native callback cannot repopulate a closed call"
		);
	}

	#[test]
	fn unavailable_path_has_recovery_wording_without_network_identifiers() {
		let facts = LivePathFacts {
			available:   false,
			interface:   None,
			class:       None,
			constrained: Some(false),
			metered:     None,
			expensive:   Some(false),
		};
		assert_eq!(path_label(&facts).as_str(), "Network · unavailable");
	}

	#[test]
	fn hotplug_snapshot_replaces_removed_device_rows() {
		let mut state = LiveViewState::new("sol");
		state.apply(&LiveUiEvent::Devices {
			input:  vec![LiveDevice {
				id:         Str::new_static("old-mic"),
				label:      Str::new_static("Old microphone"),
				is_default: true,
				selected:   true,
			}],
			output: vec![],
		});
		state.apply(&LiveUiEvent::Devices {
			input:  vec![LiveDevice {
				id:         Str::new_static("new-mic"),
				label:      Str::new_static("New microphone"),
				is_default: true,
				selected:   true,
			}],
			output: vec![],
		});

		assert_eq!(state.input_devices.len(), 1);
		assert_eq!(state.input_devices[0].id.as_str(), "new-mic");
	}
}
