//! Native WebRTC media transport for Codex live conversations.
//!
//! The TypeScript host owns authenticated signaling and the sideband protocol;
//! this module owns the realtime WebRTC peer, Opus media, and speaker
//! playback. The N-API class in pi-natives is a thin adapter over
//! [`LivePeerCore`].

use std::{
	sync::{
		Arc, Weak,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
	time::Duration,
};

use bytes::Bytes;
use opus::{Application, Channels, Decoder, Encoder};
use parking_lot::Mutex;
use tokio::{sync::watch, task::JoinHandle};
use webrtc::{
	api::{
		APIBuilder,
		interceptor_registry::register_default_interceptors,
		media_engine::{MIME_TYPE_OPUS, MediaEngine},
	},
	data_channel::{RTCDataChannel, data_channel_message::DataChannelMessage},
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

use crate::{
	VoiceResult,
	audio::{PlaybackStream, PlaybackWriter},
};

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

#[derive(Clone, Debug)]
enum PeerSignal {
	Connecting,
	Open,
	Failed(String),
	Closed,
}

enum InputCommand {
	Audio(Vec<f32>),
	Muted(bool),
	Close,
}

/// Host callbacks for peer lifecycle and media events. Every callback is
/// invoked from tokio worker threads and must not block (the N-API adapter
/// forwards through non-blocking threadsafe functions).
pub struct LiveCallbacks {
	/// One `oai-events` data-channel text payload.
	pub event:   Box<dyn Fn(String) + Send + Sync>,
	/// RMS output level in `[0, 1]`, one report per level window.
	pub level:   Box<dyn Fn(f64) + Send + Sync>,
	/// Terminal transport failure; reported at most once per peer.
	pub failure: Box<dyn Fn(String) + Send + Sync>,
}

struct LiveResources {
	peer:         Arc<RTCPeerConnection>,
	data_channel: Arc<RTCDataChannel>,
	input_tx:     flume::Sender<InputCommand>,
	input_task:   JoinHandle<()>,
	rtcp_task:    JoinHandle<()>,
	playback:     PlaybackStream,
}

/// WebRTC live-conversation peer: accepts 16 kHz mono PCM input and renders
/// remote Opus audio to the default speaker. Owned as an `Arc` by the N-API
/// `LiveWebRtcPeer` wrapper.
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

	/// Start the native media peer and return its SDP offer.
	///
	/// Fails when called twice, after close, or when the speaker, codec,
	/// peer, track, or data channel cannot be set up.
	pub async fn create_offer(self: &Arc<Self>) -> VoiceResult<String> {
		if self.started.swap(true, Ordering::AcqRel) {
			return Err("Native live WebRTC peer has already started".to_owned());
		}
		if self.closing.load(Ordering::Acquire) {
			return Err("Native live WebRTC peer is closed".to_owned());
		}

		let playback = PlaybackStream::start(OUTPUT_SAMPLE_RATE)?;
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
				return Err(format!("Failed to add the live audio track: {error}"));
			},
		};

		install_peer_callbacks(&peer, Arc::downgrade(self), playback_tx);
		let data_channel = match peer.create_data_channel(DATA_CHANNEL_LABEL, None).await {
			Ok(channel) => channel,
			Err(error) => {
				let _ = peer.close().await;
				return Err(format!("Failed to create the live data channel: {error}"));
			},
		};
		install_data_channel_callbacks(&data_channel, Arc::downgrade(self));

		let offer = match peer.create_offer(None).await {
			Ok(offer) => offer,
			Err(error) => {
				let _ = peer.close().await;
				return Err(format!("Failed to create the live SDP offer: {error}"));
			},
		};
		if let Err(error) = peer.set_local_description(offer.clone()).await {
			let _ = peer.close().await;
			return Err(format!("Failed to install the live SDP offer: {error}"));
		}
		let mut resources_slot = self.resources.lock();
		if self.closing.load(Ordering::Acquire) {
			drop(resources_slot);
			let _ = peer.close().await;
			return Err("Native live WebRTC peer was closed while starting".to_owned());
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
			.map_err(|error| format!("Failed to install the live SDP answer: {error}"))
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
					PeerSignal::Failed(message) => return Err(message),
					PeerSignal::Closed => {
						return Err("Native live WebRTC peer closed before opening".to_owned());
					},
					PeerSignal::Connecting => {},
				}
				signal_rx
					.changed()
					.await
					.map_err(|_| "Native live WebRTC peer stopped before opening".to_owned())?;
			}
		};
		tokio::time::timeout(Duration::from_millis(u64::from(timeout_ms)), wait)
			.await
			.map_err(|_| "Timed out waiting for the live data channel to open".to_owned())?
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
			return Err("Native live audio input is closed".to_owned());
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

	fn report_level(&self, level: f64) {
		(self.callbacks.level)(level.clamp(0.0, 1.0));
	}

	fn mark_open(&self) {
		if !self.closing.load(Ordering::Acquire) {
			self.signal_tx.send_replace(PeerSignal::Open);
		}
	}

	fn report_failure(&self, message: String) {
		if self.closing.load(Ordering::Acquire) || self.failure_reported.swap(true, Ordering::AcqRel)
		{
			return;
		}
		self
			.signal_tx
			.send_replace(PeerSignal::Failed(message.clone()));
		(self.callbacks.failure)(message);
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
			let _ = tokio::time::timeout(CLOSE_TASK_TIMEOUT, resources.input_task).await;
			resources.rtcp_task.abort();
			let _ = resources.rtcp_task.await;
			drop(resources.data_channel);
		}
		self.queued_samples.store(0, Ordering::Release);
		self.signal_tx.send_replace(PeerSignal::Closed);
	}
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
					core.report_failure(
						"Codex live returned more than one remote audio track".to_owned(),
					);
				}
				return;
			};
			tokio::spawn(receive_output_audio(track, output_sender, core));
		})
	}));

	let peer_for_state = Arc::downgrade(peer);
	peer.on_peer_connection_state_change(Box::new(move |state| {
		let core = core.clone();
		let peer = peer_for_state.clone();
		Box::pin(async move {
			let Some(core) = core.upgrade() else {
				return;
			};
			match state {
				RTCPeerConnectionState::Failed => {
					core.report_failure("Live WebRTC peer connection failed".to_owned());
				},
				RTCPeerConnectionState::Closed if !core.closing.load(Ordering::Acquire) => {
					core.report_failure("Live WebRTC peer connection closed unexpectedly".to_owned());
				},
				RTCPeerConnectionState::Disconnected => {
					tokio::time::sleep(DISCONNECT_GRACE).await;
					if peer.upgrade().is_some_and(|peer| {
						peer.connection_state() == RTCPeerConnectionState::Disconnected
					}) {
						core.report_failure("Live WebRTC peer connection disconnected".to_owned());
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
				core.report_failure("Live data channel closed unexpectedly".to_owned());
			}
		})
	}));

	data_channel.on_error(Box::new(move |error| {
		let core = core.clone();
		Box::pin(async move {
			if let Some(core) = core.upgrade() {
				core.report_failure(format!("Live data channel failed: {error}"));
			}
		})
	}));
}

async fn run_input_audio(
	track: Arc<TrackLocalStaticSample>,
	input_rx: flume::Receiver<InputCommand>,
	core: Weak<LivePeerCore>,
) {
	let mut encoder = match Encoder::new(INPUT_SAMPLE_RATE, Channels::Mono, Application::Voip) {
		Ok(encoder) => encoder,
		Err(error) => {
			if let Some(core) = core.upgrade() {
				core.report_failure(format!("Failed to initialize the live Opus encoder: {error}"));
			}
			return;
		},
	};
	if let Err(error) = encoder.set_inband_fec(true) {
		if let Some(core) = core.upgrade() {
			core.report_failure(format!("Failed to configure the live Opus encoder: {error}"));
		}
		return;
	}

	let mut muted = false;
	let mut pending = Vec::with_capacity(INPUT_FRAME_SAMPLES * 2);
	let mut encoded = [0u8; MAX_ENCODED_OPUS_BYTES];
	let mut ticker = tokio::time::interval(INPUT_FRAME_DURATION);
	ticker.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Burst);
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
						if let Some(core) = core.upgrade() {
							core.report_failure(format!("Failed to encode live microphone audio: {error}"));
						}
						return;
					},
				};
				let sample = Sample {
					data: Bytes::copy_from_slice(&encoded[..encoded_len]),
					duration: INPUT_FRAME_DURATION,
					..Default::default()
				};
				if let Err(error) = track.write_sample(&sample).await {
					if let Some(core) = core.upgrade() {
						core.report_failure(format!("Failed to send live microphone audio: {error}"));
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
			core.report_failure(format!(
				"Codex live negotiated unsupported audio codec {}",
				track.codec().capability.mime_type
			));
		}
		return;
	}
	let mut decoder = match Decoder::new(OUTPUT_SAMPLE_RATE, Channels::Mono) {
		Ok(decoder) => decoder,
		Err(error) => {
			if let Some(core) = core.upgrade() {
				core.report_failure(format!("Failed to initialize the live Opus decoder: {error}"));
			}
			return;
		},
	};
	let mut decoded = vec![0.0f32; MAX_DECODED_OPUS_SAMPLES].into_boxed_slice();
	let mut expected_sequence: Option<u16> = None;
	let mut level = OutputLevel::default();

	loop {
		let packet = match track.read_rtp().await {
			Ok((packet, _attributes)) => packet,
			Err(error) => {
				if let Some(core) = core.upgrade()
					&& !core.closing.load(Ordering::Acquire)
				{
					core.report_failure(format!("Live remote audio track failed: {error}"));
				}
				return;
			},
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
				if let Some(core) = core.upgrade() {
					core.report_failure(format!("Failed to decode live speaker audio: {error}"));
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
			if let Some(core) = core.upgrade()
				&& !core.closing.load(Ordering::Acquire)
			{
				core.report_failure(format!("Live speaker playback failed: {error}"));
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
