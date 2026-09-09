//! Native WebRTC media transport for Codex live conversations.
//!
//! [`LivePeerCore`] owns the realtime peer, Opus microphone input, remote audio
//! playback, and the `oai-events` data channel. Authenticated signaling and the
//! sideband socket are composed by [`crate::realtime::transport`].

use std::{
	sync::{
		Arc, Weak,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
	time::Duration,
};

use bytes::Bytes;
use flume::Receiver;
use omp_audio::{
	AudioError,
	audio::{CaptureStream, PlaybackStream, PlaybackWriter},
	coordinator::{AudioCoordinator, MicrophoneLease},
};
use opus::{Application, Channels, Decoder, Encoder};
use parking_lot::Mutex;
use strum::{Display, IntoStaticStr};
use thiserror::Error;
use tokio::{sync::watch, task::JoinHandle, time, time::MissedTickBehavior};
use webrtc::{
	api::{
		APIBuilder,
		interceptor_registry::register_default_interceptors,
		media_engine::{MIME_TYPE_OPUS, MediaEngine},
	},
	data_channel::{RTCDataChannel, data_channel_message::DataChannelMessage},
	ice_transport::{
		ice_candidate_pair::RTCIceCandidatePair, ice_candidate_type::RTCIceCandidateType,
		ice_connection_state::RTCIceConnectionState,
	},
	interceptor::registry::Registry,
	media::Sample,
	peer_connection::{
		RTCPeerConnection, configuration::RTCConfiguration,
		peer_connection_state::RTCPeerConnectionState,
		sdp::session_description::RTCSessionDescription,
	},
	rtp_transceiver::{
		rtp_codec::{RTCRtpCodecCapability, RTCRtpCodecParameters, RTPCodecType},
		rtp_sender::RTCRtpSender,
	},
	track::{
		track_local::{TrackLocal, track_local_static_sample::TrackLocalStaticSample},
		track_remote::TrackRemote,
	},
};

/// Errors returned by the native live media session.
#[derive(Clone, Debug, Error)]
pub enum LiveMediaError {
	/// Audio ownership could not be acquired.
	#[error(transparent)]
	Coordinator(#[from] omp_audio::coordinator::CoordinatorError),
	/// Native audio playback or capture failed.
	#[error(transparent)]
	Audio(#[from] AudioError),
	/// Realtime voice transport failure.
	#[error("realtime voice transport failed: {0}")]
	RealtimeTransport(String),
	/// An established native media peer reported a classified terminal failure.
	#[error("realtime media failed: {source}")]
	LiveMedia {
		/// Typed media-path failure.
		#[source]
		source: LiveMediaFailure,
	},
}

impl From<String> for LiveMediaError {
	fn from(message: String) -> Self {
		Self::RealtimeTransport(message)
	}
}

/// Backward-compatible alias for [`LiveMediaError`].
pub type VoiceError = LiveMediaError;

/// Result type for live media operations.
pub type LiveMediaResult<T> = Result<T, LiveMediaError>;

/// Backward-compatible alias for [`LiveMediaResult`].
pub type VoiceResult<T> = LiveMediaResult<T>;

const DATA_CHANNEL_LABEL: &str = "oai-events";
const INPUT_SAMPLE_RATE: u32 = 16_000;
const INPUT_FRAME_SAMPLES: usize = 320;
const INPUT_FRAME_DURATION: Duration = Duration::from_millis(20);
const MAX_ENCODED_OPUS_BYTES: usize = 1_275;
const MAX_QUEUED_INPUT_SAMPLES: usize = 32_000;
const OUTPUT_SAMPLE_RATE: u32 = 48_000;
const MAX_DECODED_OPUS_SAMPLES: usize = 5_760;
const OUTPUT_LEVEL_SAMPLES: usize = 2_400;
const OUTPUT_FRAME_SAMPLES: usize = 960;
/// Default `wait_for_open` timeout, exposed so the N-API adapter can apply it
/// when TypeScript passes no override.
pub const DEFAULT_OPEN_TIMEOUT_MS: u32 = 20_000;
const DISCONNECT_GRACE: Duration = Duration::from_secs(2);
const CLOSE_TASK_TIMEOUT: Duration = Duration::from_secs(1);

const OPUS_CAPABILITY: RTCRtpCodecCapability = RTCRtpCodecCapability {
	mime_type:     String::new(),
	clock_rate:    OUTPUT_SAMPLE_RATE,
	channels:      2,
	sdp_fmtp_line: String::new(),
	rtcp_feedback: Vec::new(),
};

/// Privacy-safe ICE candidate class for a selected media path.
///
/// Addresses, ports, foundations, protocols, and related candidates are
/// discarded before this value crosses the native media boundary.
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

/// Aggregate routing mode of one selected ICE candidate pair.
#[derive(Clone, Copy, Debug, Display, Eq, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase")]
pub enum LiveIcePathKind {
	/// Neither selected candidate uses a relay.
	Direct,
	/// At least one selected candidate uses a relay.
	Relay,
}

/// Privacy-redacted selected ICE path emitted by the native media peer.
///
/// This is deliberately closed over candidate classes and aggregate routing;
/// it cannot carry addresses, ports, credentials, interface names, or SSIDs.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LiveIcePath {
	/// Local candidate class.
	pub local:  LiveIceCandidateClass,
	/// Remote candidate class.
	pub remote: LiveIceCandidateClass,
	/// Aggregate relay/direct routing mode.
	pub kind:   LiveIcePathKind,
}

/// Typed terminal failure from an established native media peer.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum LiveMediaFailure {
	/// ICE could not retain a viable UDP media path.
	#[error("WebRTC ICE connectivity failed")]
	Ice,
	/// The WebRTC peer connection failed independently of ICE state.
	#[error("the WebRTC peer connection failed")]
	WebRtc,
	/// The authenticated WebRTC data channel failed or closed.
	#[error("the WebRTC data channel failed")]
	DataChannel,
	/// Local or negotiated audio encoding failed.
	#[error("the realtime audio codec failed")]
	Codec,
	/// Audio RTP transmission, receipt, or playback failed.
	#[error("the realtime audio stream failed")]
	Audio,
}

#[derive(Clone, Debug)]
enum PeerSignal {
	Connecting,
	Open,
	Failed(LiveMediaFailure),
	Closed,
}

enum InputCommand {
	Audio(Vec<f32>),
	Muted(bool),
	Close,
}

/// Host callbacks for peer lifecycle and media events. Every callback is
/// invoked from Tokio or native audio worker threads and must not block.
pub struct LiveCallbacks {
	/// One `oai-events` data-channel text payload.
	pub event:        Box<dyn Fn(String) + Send + Sync>,
	/// RMS microphone level in `[0, 1]`.
	pub input_level:  Box<dyn Fn(f64) + Send + Sync>,
	/// RMS output level in `[0, 1]`, one report per level window.
	pub output_level: Box<dyn Fn(f64) + Send + Sync>,
	/// Privacy-redacted selected ICE candidate pair.
	pub ice_path:     Box<dyn Fn(LiveIcePath) + Send + Sync>,
	/// Typed terminal transport failure; reported at most once per peer.
	pub failure:      Box<dyn Fn(LiveMediaFailure) + Send + Sync>,
}

struct LiveResources {
	peer:         Arc<RTCPeerConnection>,
	data_channel: Arc<RTCDataChannel>,
	input_tx:     flume::Sender<InputCommand>,
	input_task:   JoinHandle<()>,
	rtcp_task:    JoinHandle<()>,
	playback:     PlaybackStream,
}
/// An owned live-media session bound to the shared audio coordinator.
///
/// Construction acquires exclusive live microphone ownership (which suspends
/// local TTS), opens 16 kHz capture, and creates the SDP offer. [`Self::close`]
/// stops capture, closes WebRTC, and restores coordinator state exactly once.
pub struct LiveMediaSession {
	peer:    Arc<LivePeerCore>,
	capture: Mutex<Option<CaptureStream>>,
	lease:   Mutex<Option<MicrophoneLease>>,
	closed:  AtomicBool,
}

impl LiveMediaSession {
	/// Acquire audio ownership, start the peer, and use both system-default
	/// endpoints.
	pub async fn start(
		coordinator: &AudioCoordinator,
		callbacks: LiveCallbacks,
	) -> VoiceResult<(Arc<Self>, String)> {
		Self::start_on(coordinator, callbacks, None, None).await
	}

	/// Acquire audio ownership and start the peer on stable platform endpoint
	/// IDs.
	///
	/// An omitted ID follows the corresponding system default.
	pub async fn start_on(
		coordinator: &AudioCoordinator,
		callbacks: LiveCallbacks,
		input_device_id: Option<&str>,
		output_device_id: Option<&str>,
	) -> VoiceResult<(Arc<Self>, String)> {
		let lease = coordinator.acquire_live()?;
		let peer = Arc::new(LivePeerCore::new(callbacks));
		let offer = peer.create_offer_on(output_device_id).await?;
		let weak_peer = Arc::downgrade(&peer);
		let capture =
			match CaptureStream::start_on(INPUT_SAMPLE_RATE, input_device_id, move |samples| {
				if let Some(peer) = weak_peer.upgrade() {
					peer.report_input_level(rms(samples));
					let _ = peer.push_audio(samples);
				}
			}) {
				Ok(capture) => capture,
				Err(error) => {
					peer.close().await;
					return Err(error.into());
				},
			};
		let session = Arc::new(Self {
			peer,
			capture: Mutex::new(Some(capture)),
			lease: Mutex::new(Some(lease)),
			closed: AtomicBool::new(false),
		});
		Ok((session, offer))
	}

	/// Access the underlying peer for SDP answer, realtime events, and mute
	/// control.
	pub const fn peer(&self) -> &Arc<LivePeerCore> {
		&self.peer
	}

	/// Close capture and transport, restoring microphone and TTS ownership.
	pub async fn close(&self) {
		if self.closed.swap(true, Ordering::AcqRel) {
			self.peer.close().await;
			return;
		}
		if let Some(mut capture) = self.capture.lock().take() {
			let _ = capture.stop();
		}
		self.peer.close().await;
		if let Some(mut lease) = self.lease.lock().take() {
			lease.release();
		}
	}
}

impl Drop for LiveMediaSession {
	fn drop(&mut self) {
		if self.closed.swap(true, Ordering::AcqRel) {
			return;
		}
		if let Some(mut capture) = self.capture.lock().take() {
			let _ = capture.stop();
		}
		let lease = self.lease.lock().take();
		if let Ok(runtime) = tokio::runtime::Handle::try_current() {
			let peer = Arc::clone(&self.peer);
			let _ = runtime.spawn(async move {
				peer.close().await;
				if let Some(mut lease) = lease {
					lease.release();
				}
			});
		} else if let Some(mut lease) = lease {
			lease.release();
		}
	}
}

/// WebRTC live-conversation peer: accepts 16 kHz mono PCM input and renders
/// remote Opus audio to the default speaker.
pub struct LivePeerCore {
	callbacks:        LiveCallbacks,
	resources:        Mutex<Option<LiveResources>>,
	signal_tx:        watch::Sender<PeerSignal>,
	started:          AtomicBool,
	closing:          AtomicBool,
	muted:            AtomicBool,
	failure_reported: AtomicBool,
	queued_samples:   AtomicUsize,
}

impl LivePeerCore {
	/// Create an idle peer with its host callbacks registered.
	pub fn new(callbacks: LiveCallbacks) -> Self {
		let (signal_tx, _) = watch::channel(PeerSignal::Connecting);
		Self {
			callbacks,
			resources: Mutex::new(None),
			signal_tx,
			started: AtomicBool::new(false),
			closing: AtomicBool::new(false),
			muted: AtomicBool::new(false),
			failure_reported: AtomicBool::new(false),
			queued_samples: AtomicUsize::new(0),
		}
	}

	/// Start the native media peer on the system-default speaker.
	pub async fn create_offer(self: &Arc<Self>) -> VoiceResult<String> {
		self.create_offer_on(None).await
	}

	/// Start the native media peer on a stable speaker endpoint ID.
	///
	/// Fails when called twice, after close, or when the speaker, codec,
	/// peer, track, or data channel cannot be set up.
	pub async fn create_offer_on(
		self: &Arc<Self>,
		output_device_id: Option<&str>,
	) -> VoiceResult<String> {
		if self.started.swap(true, Ordering::AcqRel) {
			return Err(
				"Native live WebRTC peer has already started"
					.to_owned()
					.into(),
			);
		}
		if self.closing.load(Ordering::Acquire) {
			return Err("Native live WebRTC peer is closed".to_owned().into());
		}

		let playback = PlaybackStream::start_on(OUTPUT_SAMPLE_RATE, output_device_id)?;
		let playback_tx = playback.writer()?;
		let mut media_engine = MediaEngine::default();
		let capability = opus_capability();
		media_engine
			.register_codec(
				RTCRtpCodecParameters {
					capability: capability.clone(),
					payload_type: 111,
					..Default::default()
				},
				RTPCodecType::Audio,
			)
			.map_err(|error| format!("Failed to register the live Opus codec: {error}"))?;
		let registry = register_default_interceptors(Registry::new(), &mut media_engine)
			.map_err(|error| format!("Failed to configure live WebRTC interceptors: {error}"))?;
		let api = APIBuilder::new()
			.with_media_engine(media_engine)
			.with_interceptor_registry(registry)
			.build();
		let peer = Arc::new(
			api.new_peer_connection(RTCConfiguration::default())
				.await
				.map_err(|error| format!("Failed to create the live WebRTC peer: {error}"))?,
		);

		let track = Arc::new(TrackLocalStaticSample::new(
			capability,
			"audio".to_owned(),
			"omp-live".to_owned(),
		));
		let sender = match peer
			.add_track(Arc::clone(&track) as Arc<dyn TrackLocal + Send + Sync>)
			.await
		{
			Ok(sender) => sender,
			Err(error) => {
				let _ = peer.close().await;
				return Err(format!("Failed to add the live audio track: {error}").into());
			},
		};

		install_peer_callbacks(&peer, Arc::downgrade(self), playback_tx);
		install_ice_path_callback(&peer, Arc::downgrade(self));
		let data_channel = match peer.create_data_channel(DATA_CHANNEL_LABEL, None).await {
			Ok(channel) => channel,
			Err(error) => {
				let _ = peer.close().await;
				return Err(format!("Failed to create the live data channel: {error}").into());
			},
		};
		install_data_channel_callbacks(&data_channel, Arc::downgrade(self));

		let offer = match peer.create_offer(None).await {
			Ok(offer) => offer,
			Err(error) => {
				let _ = peer.close().await;
				return Err(format!("Failed to create the live SDP offer: {error}").into());
			},
		};
		if let Err(error) = peer.set_local_description(offer.clone()).await {
			let _ = peer.close().await;
			return Err(format!("Failed to install the live SDP offer: {error}").into());
		}
		let mut resources_slot = self.resources.lock();
		if self.closing.load(Ordering::Acquire) {
			drop(resources_slot);
			let _ = peer.close().await;
			return Err(
				"Native live WebRTC peer was closed while starting"
					.to_owned()
					.into(),
			);
		}

		let (input_tx, input_rx) = flume::unbounded();
		let input_task = tokio::spawn(run_input_audio(track, input_rx, Arc::downgrade(self)));
		let rtcp_task = tokio::spawn(drain_rtcp(sender));
		let resources =
			LiveResources { peer, data_channel, input_tx, input_task, rtcp_task, playback };
		*resources_slot = Some(resources);
		Ok(offer.sdp)
	}

	/// Apply the remote SDP answer returned by Codex signaling.
	pub async fn accept_answer(&self, sdp: String) -> VoiceResult<()> {
		let peer = self
			.resources
			.lock()
			.as_ref()
			.map(|resources| Arc::clone(&resources.peer))
			.ok_or_else(|| "Native live WebRTC peer has not started".to_owned())?;
		let answer = RTCSessionDescription::answer(sdp)
			.map_err(|error| format!("Codex returned an invalid live SDP answer: {error}"))?;
		peer
			.set_remote_description(answer)
			.await
			.map_err(|error| format!("Failed to install the live SDP answer: {error}"))?;
		Ok(())
	}

	/// Wait until the `oai-events` data channel is open, failing on peer
	/// failure, close, or timeout.
	pub async fn wait_for_open(&self, timeout_ms: u32) -> VoiceResult<()> {
		let mut signal_rx = self.signal_tx.subscribe();
		let wait = async {
			loop {
				let signal = signal_rx.borrow().clone();
				match signal {
					PeerSignal::Open => return Ok(()),
					PeerSignal::Failed(source) => return Err(LiveMediaError::LiveMedia { source }),
					PeerSignal::Closed => {
						return Err(LiveMediaError::LiveMedia { source: LiveMediaFailure::DataChannel });
					},
					PeerSignal::Connecting => {},
				}
				signal_rx
					.changed()
					.await
					.map_err(|_| LiveMediaError::LiveMedia { source: LiveMediaFailure::WebRtc })?;
			}
		};
		time::timeout(Duration::from_millis(u64::from(timeout_ms)), wait)
			.await
			.map_err(|_| LiveMediaError::LiveMedia { source: LiveMediaFailure::Ice })?
	}

	/// Queue 16 kHz mono PCM for Opus transmission. Silently drops audio while
	/// muted or when the bounded input queue is full.
	pub fn push_audio(&self, samples: &[f32]) -> VoiceResult<()> {
		if samples.is_empty() || self.muted.load(Ordering::Acquire) {
			return Ok(());
		}
		let input_tx = self
			.resources
			.lock()
			.as_ref()
			.map(|resources| resources.input_tx.clone())
			.ok_or_else(|| "Native live WebRTC peer has not started".to_owned())?;
		let sample_count = samples.len().min(MAX_QUEUED_INPUT_SAMPLES);
		let retained = &samples[samples.len() - sample_count..];
		let queued = self
			.queued_samples
			.fetch_add(sample_count, Ordering::AcqRel);
		if queued.saturating_add(sample_count) > MAX_QUEUED_INPUT_SAMPLES {
			self
				.queued_samples
				.fetch_sub(sample_count, Ordering::AcqRel);
			return Ok(());
		}
		if input_tx
			.send(InputCommand::Audio(retained.to_vec()))
			.is_err()
		{
			self
				.queued_samples
				.fetch_sub(sample_count, Ordering::AcqRel);
			return Err("Native live audio input is closed".to_owned().into());
		}
		Ok(())
	}

	/// Enable or disable microphone transmission, discarding partial muted
	/// frames.
	pub fn set_muted(&self, muted: bool) -> VoiceResult<()> {
		self.muted.store(muted, Ordering::Release);
		let input_tx = self
			.resources
			.lock()
			.as_ref()
			.map(|resources| resources.input_tx.clone());
		if let Some(input_tx) = input_tx {
			input_tx
				.send(InputCommand::Muted(muted))
				.map_err(|_| "Native live audio input is closed".to_owned())?;
		}
		Ok(())
	}

	/// Whether close has begun; lets the adapter's `Drop` skip spawning a
	/// redundant close task.
	pub fn is_closing(&self) -> bool {
		self.closing.load(Ordering::Acquire)
	}

	fn report_event(&self, payload: String) {
		(self.callbacks.event)(payload);
	}

	fn report_input_level(&self, level: f64) {
		(self.callbacks.input_level)(level.clamp(0.0, 1.0));
	}

	fn report_level(&self, level: f64) {
		(self.callbacks.output_level)(level.clamp(0.0, 1.0));
	}

	fn report_ice_path(&self, path: LiveIcePath) {
		if !self.closing.load(Ordering::Acquire) {
			(self.callbacks.ice_path)(path);
		}
	}

	fn mark_open(&self) {
		if !self.closing.load(Ordering::Acquire) {
			self.signal_tx.send_replace(PeerSignal::Open);
		}
	}

	fn report_failure(&self, failure: LiveMediaFailure) {
		if self.closing.load(Ordering::Acquire) || self.failure_reported.swap(true, Ordering::AcqRel)
		{
			return;
		}
		self.signal_tx.send_replace(PeerSignal::Failed(failure));
		(self.callbacks.failure)(failure);
	}

	/// Close media, the data channel, the peer connection, and speaker
	/// playback. Concurrent calls wait for the first closer to finish.
	pub async fn close(&self) {
		if self.closing.swap(true, Ordering::AcqRel) {
			let mut signal_rx = self.signal_tx.subscribe();
			while !matches!(*signal_rx.borrow(), PeerSignal::Closed) {
				if signal_rx.changed().await.is_err() {
					break;
				}
			}
			return;
		}

		let resources = self.resources.lock().take();
		if let Some(mut resources) = resources {
			let _ = resources.input_tx.send(InputCommand::Close);
			let _ = resources.peer.close().await;
			let _ = resources.playback.stop();
			let _ = time::timeout(CLOSE_TASK_TIMEOUT, resources.input_task).await;
			resources.rtcp_task.abort();
			let _ = resources.rtcp_task.await;
			drop(resources.data_channel);
		}
		self.queued_samples.store(0, Ordering::Release);
		self.signal_tx.send_replace(PeerSignal::Closed);
	}
}

fn rms(samples: &[f32]) -> f64 {
	if samples.is_empty() {
		return 0.0;
	}
	let sum = samples
		.iter()
		.map(|sample| {
			let sample = f64::from(*sample);
			sample * sample
		})
		.sum::<f64>();
	(sum / samples.len() as f64).sqrt().clamp(0.0, 1.0)
}

fn opus_capability() -> RTCRtpCodecCapability {
	RTCRtpCodecCapability {
		mime_type:     MIME_TYPE_OPUS.to_owned(),
		clock_rate:    OPUS_CAPABILITY.clock_rate,
		channels:      OPUS_CAPABILITY.channels,
		sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
		rtcp_feedback: Vec::new(),
	}
}

const fn candidate_class(candidate: RTCIceCandidateType) -> Option<LiveIceCandidateClass> {
	match candidate {
		RTCIceCandidateType::Host => Some(LiveIceCandidateClass::Host),
		RTCIceCandidateType::Srflx => Some(LiveIceCandidateClass::ServerReflexive),
		RTCIceCandidateType::Prflx => Some(LiveIceCandidateClass::PeerReflexive),
		RTCIceCandidateType::Relay => Some(LiveIceCandidateClass::Relay),
		RTCIceCandidateType::Unspecified => None,
	}
}

fn redact_ice_pair(pair: &RTCIceCandidatePair) -> Option<LiveIcePath> {
	let local = candidate_class(pair.local.typ)?;
	let remote = candidate_class(pair.remote.typ)?;
	let kind = if local == LiveIceCandidateClass::Relay || remote == LiveIceCandidateClass::Relay {
		LiveIcePathKind::Relay
	} else {
		LiveIcePathKind::Direct
	};
	Some(LiveIcePath { local, remote, kind })
}

fn install_ice_path_callback(peer: &Arc<RTCPeerConnection>, core: Weak<LivePeerCore>) {
	peer
		.dtls_transport()
		.ice_transport()
		.on_selected_candidate_pair_change(Box::new(move |pair| {
			let core = core.clone();
			let path = redact_ice_pair(&pair);
			Box::pin(async move {
				if let (Some(core), Some(path)) = (core.upgrade(), path) {
					core.report_ice_path(path);
				}
			})
		}));
}

fn install_peer_callbacks(
	peer: &Arc<RTCPeerConnection>,
	core: Weak<LivePeerCore>,
	playback_tx: PlaybackWriter,
) {
	let output_sender = Arc::new(Mutex::new(Some(playback_tx)));
	let output_sender_for_track = Arc::clone(&output_sender);
	let core_for_track = core.clone();
	peer.on_track(Box::new(move |track, _receiver, _transceiver| {
		let output_sender = output_sender_for_track.lock().take();
		let core = core_for_track.clone();
		Box::pin(async move {
			if track.kind() != RTPCodecType::Audio {
				return;
			}
			let Some(output_sender) = output_sender else {
				if let Some(core) = core.upgrade() {
					core.report_failure(LiveMediaFailure::Audio);
				}
				return;
			};
			tokio::spawn(receive_output_audio(track, output_sender, core));
		})
	}));

	let peer_for_state = Arc::downgrade(peer);
	let core_for_state = core.clone();
	peer.on_peer_connection_state_change(Box::new(move |state| {
		let core = core_for_state.clone();
		let peer = peer_for_state.clone();
		Box::pin(async move {
			let Some(core) = core.upgrade() else {
				return;
			};
			match state {
				RTCPeerConnectionState::Failed => {
					let failure = if peer
						.upgrade()
						.is_some_and(|peer| peer.ice_connection_state() == RTCIceConnectionState::Failed)
					{
						LiveMediaFailure::Ice
					} else {
						LiveMediaFailure::WebRtc
					};
					core.report_failure(failure);
				},
				RTCPeerConnectionState::Closed if !core.closing.load(Ordering::Acquire) => {
					core.report_failure(LiveMediaFailure::WebRtc);
				},
				RTCPeerConnectionState::Disconnected => {
					time::sleep(DISCONNECT_GRACE).await;
					if peer.upgrade().is_some_and(|peer| {
						peer.connection_state() == RTCPeerConnectionState::Disconnected
							&& peer.ice_connection_state() != RTCIceConnectionState::Disconnected
					}) {
						core.report_failure(LiveMediaFailure::WebRtc);
					}
				},
				_ => {},
			}
		})
	}));

	let peer_for_ice = Arc::downgrade(peer);
	peer.on_ice_connection_state_change(Box::new(move |state| {
		let core = core.clone();
		let peer = peer_for_ice.clone();
		Box::pin(async move {
			let Some(core) = core.upgrade() else {
				return;
			};
			match state {
				RTCIceConnectionState::Failed => core.report_failure(LiveMediaFailure::Ice),
				RTCIceConnectionState::Disconnected => {
					time::sleep(DISCONNECT_GRACE).await;
					if peer.upgrade().is_some_and(|peer| {
						peer.ice_connection_state() == RTCIceConnectionState::Disconnected
					}) {
						core.report_failure(LiveMediaFailure::Ice);
					}
				},
				_ => {},
			}
		})
	}));
}

fn install_data_channel_callbacks(data_channel: &Arc<RTCDataChannel>, core: Weak<LivePeerCore>) {
	let core_for_open = core.clone();
	data_channel.on_open(Box::new(move || {
		Box::pin(async move {
			if let Some(core) = core_for_open.upgrade() {
				core.mark_open();
			}
		})
	}));

	let core_for_message = core.clone();
	data_channel.on_message(Box::new(move |message: DataChannelMessage| {
		let core = core_for_message.clone();
		Box::pin(async move {
			if !message.is_string {
				return;
			}
			if let (Some(core), Ok(payload)) =
				(core.upgrade(), String::from_utf8(message.data.to_vec()))
			{
				core.report_event(payload);
			}
		})
	}));

	let core_for_close = core.clone();
	data_channel.on_close(Box::new(move || {
		let core = core_for_close.clone();
		Box::pin(async move {
			if let Some(core) = core.upgrade() {
				core.report_failure(LiveMediaFailure::DataChannel);
			}
		})
	}));

	data_channel.on_error(Box::new(move |_error| {
		let core = core.clone();
		Box::pin(async move {
			if let Some(core) = core.upgrade() {
				core.report_failure(LiveMediaFailure::DataChannel);
			}
		})
	}));
}

async fn run_input_audio(
	track: Arc<TrackLocalStaticSample>,
	input_rx: Receiver<InputCommand>,
	core: Weak<LivePeerCore>,
) {
	let mut encoder = match Encoder::new(INPUT_SAMPLE_RATE, Channels::Mono, Application::Voip) {
		Ok(encoder) => encoder,
		Err(error) => {
			tracing::warn!(error = %error, "failed to initialize live Opus encoder");
			if let Some(core) = core.upgrade() {
				core.report_failure(LiveMediaFailure::Codec);
			}
			return;
		},
	};
	if let Err(error) = encoder.set_inband_fec(true) {
		tracing::warn!(error = %error, "failed to configure live Opus encoder");
		if let Some(core) = core.upgrade() {
			core.report_failure(LiveMediaFailure::Codec);
		}
		return;
	}

	let mut muted = false;
	let mut pending = Vec::with_capacity(INPUT_FRAME_SAMPLES * 2);
	let mut encoded = [0u8; MAX_ENCODED_OPUS_BYTES];
	let mut ticker = time::interval(INPUT_FRAME_DURATION);
	ticker.set_missed_tick_behavior(MissedTickBehavior::Burst);
	ticker.tick().await;
	loop {
		tokio::select! {
			biased;
			command = input_rx.recv_async() => {
				let Ok(command) = command else {
					break;
				};
				match command {
					InputCommand::Audio(samples) => {
						if let Some(core) = core.upgrade() {
							core.queued_samples.fetch_sub(samples.len(), Ordering::AcqRel);
						}
						if muted {
							continue;
						}
						if samples.len() >= MAX_QUEUED_INPUT_SAMPLES {
							pending.clear();
							pending.extend_from_slice(&samples[samples.len() - MAX_QUEUED_INPUT_SAMPLES..]);
							continue;
						}
						let overflow = pending
							.len()
							.saturating_add(samples.len())
							.saturating_sub(MAX_QUEUED_INPUT_SAMPLES);
						if overflow > 0 {
							pending.drain(..overflow);
						}
						pending.extend_from_slice(&samples);
					},
					InputCommand::Muted(next_muted) => {
						muted = next_muted;
						pending.clear();
					},
					InputCommand::Close => break,
				}
			},
			_ = ticker.tick() => {
				let mut frame = [0.0f32; INPUT_FRAME_SAMPLES];
				if !muted {
					let consumed = pending.len().min(INPUT_FRAME_SAMPLES);
					frame[..consumed].copy_from_slice(&pending[..consumed]);
					if consumed > 0 {
						pending.copy_within(consumed.., 0);
						pending.truncate(pending.len() - consumed);
					}
				}
				let encoded_len = match encoder.encode_float(&frame, &mut encoded) {
					Ok(encoded_len) => encoded_len,
					Err(error) => {
						tracing::warn!(error = %error, "failed to encode live microphone audio");
						if let Some(core) = core.upgrade() {
							core.report_failure(LiveMediaFailure::Codec);
						}
						return;
					},
				};
				let sample = Sample {
					data: Bytes::copy_from_slice(&encoded[..encoded_len]),
					duration: INPUT_FRAME_DURATION,
					..Default::default()
				};
				if track.write_sample(&sample).await.is_err() {
					if let Some(core) = core.upgrade() {
						core.report_failure(LiveMediaFailure::Audio);
					}
					return;
				}
			},
		}
	}
}

async fn drain_rtcp(sender: Arc<RTCRtpSender>) {
	while sender.read_rtcp().await.is_ok() {}
}

async fn receive_output_audio(
	track: Arc<TrackRemote>,
	playback_tx: PlaybackWriter,
	core: Weak<LivePeerCore>,
) {
	if !track
		.codec()
		.capability
		.mime_type
		.eq_ignore_ascii_case(MIME_TYPE_OPUS)
	{
		if let Some(core) = core.upgrade() {
			core.report_failure(LiveMediaFailure::Codec);
		}
		return;
	}
	let mut decoder = match Decoder::new(OUTPUT_SAMPLE_RATE, Channels::Mono) {
		Ok(decoder) => decoder,
		Err(error) => {
			tracing::warn!(error = %error, "failed to initialize live Opus decoder");
			if let Some(core) = core.upgrade() {
				core.report_failure(LiveMediaFailure::Codec);
			}
			return;
		},
	};
	let mut decoded = vec![0.0f32; MAX_DECODED_OPUS_SAMPLES].into_boxed_slice();
	let mut expected_sequence: Option<u16> = None;
	let mut level = OutputLevel::default();

	loop {
		let packet = if let Ok((packet, _attributes)) = track.read_rtp().await {
			packet
		} else {
			if let Some(core) = core.upgrade()
				&& !core.closing.load(Ordering::Acquire)
			{
				core.report_failure(LiveMediaFailure::Audio);
			}
			return;
		};
		let sequence = packet.header.sequence_number;
		if let Some(expected) = expected_sequence {
			let gap = sequence.wrapping_sub(expected);
			if gap >= u16::MAX / 2 {
				continue;
			}
			if gap > 0 {
				for _ in 1..gap.min(5) {
					if let Ok(samples) =
						decoder.decode_float(&[], &mut decoded[..OUTPUT_FRAME_SAMPLES], false)
					{
						if !write_output(&playback_tx, &decoded[..samples], &core) {
							return;
						}
						level.observe(&decoded[..samples], &core);
					}
				}
				if let Ok(samples) = decoder.decode_float(&packet.payload, &mut decoded, true) {
					if !write_output(&playback_tx, &decoded[..samples], &core) {
						return;
					}
					level.observe(&decoded[..samples], &core);
				}
			}
		}
		expected_sequence = Some(sequence.wrapping_add(1));
		match decoder.decode_float(&packet.payload, &mut decoded, false) {
			Ok(samples) => {
				if !write_output(&playback_tx, &decoded[..samples], &core) {
					return;
				}
				level.observe(&decoded[..samples], &core);
			},
			Err(error) => {
				tracing::warn!(error = %error, "failed to decode live speaker audio");
				if let Some(core) = core.upgrade() {
					core.report_failure(LiveMediaFailure::Codec);
				}
				return;
			},
		}
	}
}

fn write_output(playback_tx: &PlaybackWriter, samples: &[f32], core: &Weak<LivePeerCore>) -> bool {
	match playback_tx.write(samples) {
		Ok(()) => true,
		Err(error) => {
			tracing::warn!(error = %error, "live voice playback failed");
			if let Some(core) = core.upgrade()
				&& !core.closing.load(Ordering::Acquire)
			{
				core.report_failure(LiveMediaFailure::Audio);
			}
			false
		},
	}
}

#[derive(Default)]
struct OutputLevel {
	sum_squares: f64,
	samples:     usize,
}

impl OutputLevel {
	fn observe(&mut self, decoded: &[f32], core: &Weak<LivePeerCore>) {
		let mut offset = 0;
		while offset < decoded.len() {
			let take = (OUTPUT_LEVEL_SAMPLES - self.samples).min(decoded.len() - offset);
			for &sample in &decoded[offset..offset + take] {
				let sample = f64::from(sample);
				self.sum_squares = sample.mul_add(sample, self.sum_squares);
			}
			self.samples += take;
			offset += take;
			if self.samples == OUTPUT_LEVEL_SAMPLES {
				if let Some(core) = core.upgrade() {
					core.report_level((self.sum_squares / self.samples as f64).sqrt());
				}
				self.sum_squares = 0.0;
				self.samples = 0;
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use webrtc::ice_transport::ice_candidate::RTCIceCandidate;

	use super::*;

	fn candidate(typ: RTCIceCandidateType, address: &str, port: u16) -> RTCIceCandidate {
		RTCIceCandidate {
			address: address.to_owned(),
			port,
			related_address: "198.51.100.9".to_owned(),
			related_port: 65_000,
			typ,
			..Default::default()
		}
	}

	#[test]
	fn selected_ice_pair_is_redacted_before_leaving_the_native_peer() {
		let pair = RTCIceCandidatePair::new(
			candidate(RTCIceCandidateType::Relay, "203.0.113.4", 34_789),
			candidate(RTCIceCandidateType::Host, "10.0.0.8", 5_555),
		);
		let redacted = redact_ice_pair(&pair).expect("known candidate classes");

		assert_eq!(redacted, LiveIcePath {
			local:  LiveIceCandidateClass::Relay,
			remote: LiveIceCandidateClass::Host,
			kind:   LiveIcePathKind::Relay,
		});
		let debug = format!("{redacted:?}");
		for secret in ["203.0.113.4", "10.0.0.8", "198.51.100.9", "34789", "5555", "65000"] {
			assert!(!debug.contains(secret), "redacted event leaked {secret}: {debug}");
		}
	}

	#[test]
	fn relay_aggregate_depends_only_on_candidate_classes() {
		let direct = RTCIceCandidatePair::new(
			candidate(RTCIceCandidateType::Host, "private", 1),
			candidate(RTCIceCandidateType::Srflx, "public", 2),
		);
		assert_eq!(
			redact_ice_pair(&direct).expect("known direct pair").kind,
			LiveIcePathKind::Direct
		);

		let unspecified = RTCIceCandidatePair::new(
			candidate(RTCIceCandidateType::Unspecified, "secret", 3),
			candidate(RTCIceCandidateType::Host, "secret", 4),
		);
		assert_eq!(redact_ice_pair(&unspecified), None);
	}
}
