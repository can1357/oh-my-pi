//! Native WebRTC media transport for Codex live conversations.
//!
//! The TypeScript host owns authenticated signaling and the sideband protocol;
//! this module owns the realtime WebRTC peer, Opus media, and speaker
//! playback. The N-API class in omp-natives is a thin adapter over
//! [`LivePeerCore`].
//!
//! The `webrtc` peer runs its own driver task and reports connection and
//! remote-track events through [`PeerEvents`]; the data channel and the remote
//! track are drained by tasks spawned here.

use std::{
	hash::{BuildHasher, RandomState},
	sync::{
		Arc, Weak,
		atomic::{AtomicBool, AtomicUsize, Ordering},
	},
	time::{Duration, Instant},
};

use bytes::Bytes;
use opus::{Application, Channels, Decoder, Encoder};
use parking_lot::Mutex;
use rtc::{
	media::Sample,
	peer_connection::configuration::media_engine::MIME_TYPE_OPUS,
	rtp_transceiver::{
		PayloadType, SSRC,
		rtp_sender::{
			RTCRtpCodec, RTCRtpCodecParameters, RTCRtpCodingParameters, RTCRtpEncodingParameters,
			RtpCodecKind,
		},
	},
};
use tokio::{sync::watch, task::JoinHandle};
use webrtc::{
	data_channel::{DataChannel, DataChannelEvent},
	media_stream::{
		MediaStreamTrack,
		track_local::{TrackLocal, static_sample::TrackLocalStaticSample},
		track_remote::{TrackRemote, TrackRemoteEvent},
	},
	peer_connection::{
		MediaEngine, PeerConnection, PeerConnectionBuilder, PeerConnectionEventHandler,
		RTCPeerConnectionState, RTCSessionDescription, Registry, register_default_interceptors,
	},
	rtp_transceiver::RtpSender,
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
/// Remote speech held back before playback starts and after each underrun.
/// Packets arrive paced by the network, one 20 ms frame per device period on
/// macOS/Windows; three frames of slack absorb ordinary jitter and spikes.
pub(crate) const OUTPUT_JITTER_BUFFER_MS: u32 = 60;
/// Default `wait_for_open` timeout, exposed so the N-API adapter can apply it
/// when TypeScript passes no override.
pub const DEFAULT_OPEN_TIMEOUT_MS: u32 = 20_000;
const DISCONNECT_GRACE: Duration = Duration::from_secs(2);
const CLOSE_TASK_TIMEOUT: Duration = Duration::from_secs(1);
const OPUS_PAYLOAD_TYPE: PayloadType = 111;
const OPUS_CHANNELS: u16 = 2;
/// Wildcards expand to one UDP socket per usable local IPv4 and IPv6
/// interface, so the offer carries a host candidate for each.
const UDP_BIND_ADDRS: [&str; 2] = ["0.0.0.0:0", "[::]:0"];
const TRACK_STREAM_ID: &str = "omp-live";
const TRACK_ID: &str = "audio";

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
	/// The peer connected: resolve the negotiated payload type and start
	/// sending encoded frames.
	Connected,
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
	peer:              Arc<dyn PeerConnection>,
	input_tx:          flume::Sender<InputCommand>,
	input_task:        JoinHandle<()>,
	data_channel_task: JoinHandle<()>,
	playback:          PlaybackStream,
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

		let playback = PlaybackStream::start(OUTPUT_SAMPLE_RATE, OUTPUT_JITTER_BUFFER_MS)?;
		let playback_tx = playback.writer()?;
		let mut media_engine = MediaEngine::default();
		let codec = opus_codec();
		media_engine
			.register_codec(
				RTCRtpCodecParameters { rtp_codec: codec.clone(), payload_type: OPUS_PAYLOAD_TYPE },
				RtpCodecKind::Audio,
			)
			.map_err(|error| format!("Failed to register the live Opus codec: {error}"))?;
		let registry = register_default_interceptors(Registry::new(), &mut media_engine)
			.map_err(|error| format!("Failed to configure live WebRTC interceptors: {error}"))?;
		let (input_tx, input_rx) = flume::unbounded();
		let events = PeerEvents {
			core:        Arc::downgrade(self),
			input_tx:    input_tx.clone(),
			playback_tx: Mutex::new(Some(playback_tx)),
			state:       Arc::new(Mutex::new(RTCPeerConnectionState::New)),
		};
		let build = PeerConnectionBuilder::new()
			.with_media_engine(media_engine)
			.with_interceptor_registry(registry)
			.with_handler(Arc::new(events))
			.with_udp_addrs(UDP_BIND_ADDRS.to_vec())
			.build();
		let peer: Arc<dyn PeerConnection> = Arc::new(
			Box::pin(build)
				.await
				.map_err(|error| format!("Failed to create the live WebRTC peer: {error}"))?,
		);

		let ssrc = RandomState::new().hash_one(Instant::now()) as SSRC;
		let track = match TrackLocalStaticSample::new(
			Instant::now(),
			MediaStreamTrack::new(
				TRACK_STREAM_ID.to_owned(),
				TRACK_ID.to_owned(),
				TRACK_ID.to_owned(),
				RtpCodecKind::Audio,
				vec![RTCRtpEncodingParameters {
					rtp_coding_parameters: RTCRtpCodingParameters {
						ssrc: Some(ssrc),
						..Default::default()
					},
					active: true,
					codec,
					..Default::default()
				}],
			),
		) {
			Ok(track) => Arc::new(track),
			Err(error) => {
				let _ = peer.close().await;
				return Err(format!("Failed to create the live audio track: {error}"));
			},
		};
		let sender = match peer
			.add_track(Arc::clone(&track) as Arc<dyn TrackLocal>)
			.await
		{
			Ok(sender) => sender,
			Err(error) => {
				let _ = peer.close().await;
				return Err(format!("Failed to add the live audio track: {error}"));
			},
		};

		let data_channel = match peer.create_data_channel(DATA_CHANNEL_LABEL, None).await {
			Ok(channel) => channel,
			Err(error) => {
				let _ = peer.close().await;
				return Err(format!("Failed to create the live data channel: {error}"));
			},
		};

		let offer = match peer.create_offer(None).await {
			Ok(offer) => offer,
			Err(error) => {
				let _ = peer.close().await;
				return Err(format!("Failed to create the live SDP offer: {error}"));
			},
		};
		let sdp = offer.sdp.clone();
		if let Err(error) = peer.set_local_description(offer).await {
			let _ = peer.close().await;
			return Err(format!("Failed to install the live SDP offer: {error}"));
		}
		let mut resources_slot = self.resources.lock();
		if self.closing.load(Ordering::Acquire) {
			drop(resources_slot);
			let _ = peer.close().await;
			return Err("Native live WebRTC peer was closed while starting".to_owned());
		}

		let input_task =
			tokio::spawn(run_input_audio(track, ssrc, sender, input_rx, Arc::downgrade(self)));
		let data_channel_task = tokio::spawn(run_data_channel(data_channel, Arc::downgrade(self)));
		let resources = LiveResources { peer, input_tx, input_task, data_channel_task, playback };
		*resources_slot = Some(resources);
		Ok(sdp)
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
			resources.data_channel_task.abort();
			let _ = resources.data_channel_task.await;
		}
		self.queued_samples.store(0, Ordering::Release);
		self.signal_tx.send_replace(PeerSignal::Closed);
	}
}

fn opus_codec() -> RTCRtpCodec {
	RTCRtpCodec {
		mime_type:     MIME_TYPE_OPUS.to_owned(),
		clock_rate:    OUTPUT_SAMPLE_RATE,
		channels:      OPUS_CHANNELS,
		sdp_fmtp_line: "minptime=10;useinbandfec=1".to_owned(),
		rtcp_feedback: Vec::new(),
	}
}

/// Peer-connection events. Handlers run on the webrtc driver task, so they
/// must neither block nor await the peer; longer work is spawned.
struct PeerEvents {
	core:        Weak<LivePeerCore>,
	input_tx:    flume::Sender<InputCommand>,
	/// Taken by the first remote audio track.
	playback_tx: Mutex<Option<PlaybackWriter>>,
	/// Latest connection state, re-checked after the disconnect grace period.
	state:       Arc<Mutex<RTCPeerConnectionState>>,
}

#[async_trait::async_trait]
impl PeerConnectionEventHandler for PeerEvents {
	async fn on_connection_state_change(&self, state: RTCPeerConnectionState) {
		*self.state.lock() = state;
		let Some(core) = self.core.upgrade() else {
			return;
		};
		match state {
			RTCPeerConnectionState::Connected => {
				let _ = self.input_tx.send(InputCommand::Connected);
			},
			RTCPeerConnectionState::Failed => {
				core.report_failure("Live WebRTC peer connection failed".to_owned());
			},
			RTCPeerConnectionState::Closed if !core.closing.load(Ordering::Acquire) => {
				core.report_failure("Live WebRTC peer connection closed unexpectedly".to_owned());
			},
			RTCPeerConnectionState::Disconnected => {
				let state = Arc::clone(&self.state);
				let core = self.core.clone();
				tokio::spawn(async move {
					tokio::time::sleep(DISCONNECT_GRACE).await;
					if *state.lock() == RTCPeerConnectionState::Disconnected
						&& let Some(core) = core.upgrade()
					{
						core.report_failure("Live WebRTC peer connection disconnected".to_owned());
					}
				});
			},
			_ => {},
		}
	}

	async fn on_track(&self, track: Arc<dyn TrackRemote>) {
		if track.kind().await != RtpCodecKind::Audio {
			return;
		}
		let Some(playback_tx) = self.playback_tx.lock().take() else {
			if let Some(core) = self.core.upgrade() {
				core.report_failure("Codex live returned more than one remote audio track".to_owned());
			}
			return;
		};
		tokio::spawn(receive_output_audio(track, playback_tx, self.core.clone()));
	}
}

async fn run_data_channel(data_channel: Arc<dyn DataChannel>, core: Weak<LivePeerCore>) {
	while let Some(event) = data_channel.poll().await {
		let Some(core) = core.upgrade() else {
			return;
		};
		match event {
			DataChannelEvent::OnOpen => core.mark_open(),
			DataChannelEvent::OnMessage(message) => {
				if message.is_string
					&& let Ok(payload) = String::from_utf8(message.data.into())
				{
					core.report_event(payload);
				}
			},
			DataChannelEvent::OnError => {
				core.report_failure("Live data channel failed".to_owned());
			},
			DataChannelEvent::OnClose => break,
			_ => {},
		}
	}
	if let Some(core) = core.upgrade() {
		core.report_failure("Live data channel closed unexpectedly".to_owned());
	}
}

async fn run_input_audio(
	track: Arc<TrackLocalStaticSample>,
	ssrc: SSRC,
	sender: Arc<dyn RtpSender>,
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
	// Encoded frames are discarded until the peer connects and the sender's
	// negotiated payload type is known.
	let mut payload_type = None;
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
					InputCommand::Connected => {
						if payload_type.is_some() {
							continue;
						}
						match negotiated_payload_type(sender.as_ref()).await {
							Ok(negotiated) => payload_type = Some(negotiated),
							Err(error) => {
								if let Some(core) = core.upgrade() {
									core.report_failure(error);
								}
								return;
							},
						}
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
				let Some(payload_type) = payload_type else {
					continue;
				};
				let sample = Sample {
					data: Bytes::copy_from_slice(&encoded[..encoded_len]),
					duration: INPUT_FRAME_DURATION,
					..Sample::new(Instant::now())
				};
				if let Err(error) = track.write_sample(ssrc, payload_type, &sample, &[]).await {
					if let Some(core) = core.upgrade() {
						core.report_failure(format!("Failed to send live microphone audio: {error}"));
					}
					return;
				}
			},
		}
	}
}

/// The payload type the answer assigned to Opus on the microphone sender.
async fn negotiated_payload_type(sender: &dyn RtpSender) -> VoiceResult<PayloadType> {
	sender
		.get_parameters()
		.await
		.map_err(|error| format!("Failed to read the negotiated live audio codec: {error}"))?
		.rtp_parameters
		.codecs
		.iter()
		.find(|codec| {
			codec
				.rtp_codec
				.mime_type
				.eq_ignore_ascii_case(MIME_TYPE_OPUS)
		})
		.map(|codec| codec.payload_type)
		.ok_or_else(|| "Codex live did not negotiate Opus for microphone audio".to_owned())
}

async fn receive_output_audio(
	track: Arc<dyn TrackRemote>,
	playback_tx: PlaybackWriter,
	core: Weak<LivePeerCore>,
) {
	let ssrc = track.ssrcs().await.first().copied();
	let codec = match ssrc {
		Some(ssrc) => track.codec(ssrc).await,
		None => None,
	};
	let mime_type = codec.map_or_else(String::new, |codec| codec.mime_type);
	if !mime_type.eq_ignore_ascii_case(MIME_TYPE_OPUS) {
		if let Some(core) = core.upgrade() {
			core.report_failure(format!("Codex live negotiated unsupported audio codec {mime_type}"));
		}
		return;
	}
	let mut decoder = match OutputDecoder::new() {
		Ok(decoder) => decoder,
		Err(error) => {
			if let Some(core) = core.upgrade() {
				core.report_failure(format!("Failed to initialize the live Opus decoder: {error}"));
			}
			return;
		},
	};
	let mut level = OutputLevel::default();

	loop {
		let packet = match track.poll().await {
			Some(TrackRemoteEvent::OnRtpPacket(packet)) => packet,
			Some(TrackRemoteEvent::OnError) => {
				if let Some(core) = core.upgrade() {
					core.report_failure("Live remote audio track failed".to_owned());
				}
				return;
			},
			Some(TrackRemoteEvent::OnEnded) | None => {
				if let Some(core) = core.upgrade() {
					core.report_failure("Live remote audio track ended".to_owned());
				}
				return;
			},
			Some(_) => continue,
		};
		let decoded = decoder.push(packet.header.sequence_number, &packet.payload, |samples| {
			if !write_output(&playback_tx, samples, &core) {
				return false;
			}
			level.observe(samples, &core);
			true
		});
		match decoded {
			Ok(true) => {},
			Ok(false) => return,
			Err(error) => {
				if let Some(core) = core.upgrade() {
					core.report_failure(error);
				}
				return;
			},
		}
	}
}

/// Opus decode state for the remote track: conceals sequence gaps, drops
/// late or duplicate packets, and emits PCM in playback order.
struct OutputDecoder {
	decoder:           Decoder,
	decoded:           Box<[f32]>,
	expected_sequence: Option<u16>,
}

impl OutputDecoder {
	fn new() -> Result<Self, opus::Error> {
		Ok(Self {
			decoder:           Decoder::new(OUTPUT_SAMPLE_RATE, Channels::Mono)?,
			decoded:           vec![0.0; MAX_DECODED_OPUS_SAMPLES].into_boxed_slice(),
			expected_sequence: None,
		})
	}

	/// Decode one RTP payload after concealing frames lost since the
	/// previous packet (PLC, then the payload's in-band FEC for the frame
	/// just before it). Returns `Ok(false)` once `emit` asks to stop.
	///
	/// # Errors
	/// The payload itself fails to decode.
	fn push(
		&mut self,
		sequence: u16,
		payload: &[u8],
		mut emit: impl FnMut(&[f32]) -> bool,
	) -> VoiceResult<bool> {
		if let Some(expected) = self.expected_sequence {
			let gap = sequence.wrapping_sub(expected);
			if gap >= u16::MAX / 2 {
				return Ok(true);
			}
			if gap > 0 {
				// libopus synthesizes exactly the requested size for PLC and FEC,
				// so it must match the lost audio: assume this packet's duration.
				let frame = self
					.decoder
					.get_nb_samples(payload)
					.ok()
					.filter(|&samples| samples > 0 && samples <= MAX_DECODED_OPUS_SAMPLES)
					.unwrap_or(OUTPUT_FRAME_SAMPLES);
				for _ in 1..gap.min(5) {
					if let Ok(samples) =
						self
							.decoder
							.decode_float(&[], &mut self.decoded[..frame], false)
						&& !emit(&self.decoded[..samples])
					{
						return Ok(false);
					}
				}
				if let Ok(samples) =
					self
						.decoder
						.decode_float(payload, &mut self.decoded[..frame], true)
					&& !emit(&self.decoded[..samples])
				{
					return Ok(false);
				}
			}
		}
		self.expected_sequence = Some(sequence.wrapping_add(1));
		let samples = self
			.decoder
			.decode_float(payload, &mut self.decoded, false)
			.map_err(|error| format!("Failed to decode live speaker audio: {error}"))?;
		Ok(emit(&self.decoded[..samples]))
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

#[cfg(test)]
mod tests {
	use super::*;

	/// Regression guard for #17114: each lost 20 ms frame must be concealed
	/// with 20 ms of audio, not the whole 120 ms decode buffer.
	#[test]
	fn lost_packets_are_concealed_with_their_own_duration() {
		let speech: Vec<f32> = (0..OUTPUT_FRAME_SAMPLES)
			.map(|sample| (sample as f32 * 0.05).sin() * 0.3)
			.collect();
		// FEC alone recovers one loss; a longer gap adds PLC frames before it.
		for lost in [&[5u16][..], &[3, 4, 5]] {
			let mut encoder = Encoder::new(OUTPUT_SAMPLE_RATE, Channels::Mono, Application::Voip)
				.expect("Opus encoder initializes");
			encoder.set_inband_fec(true).expect("FEC enables");
			encoder.set_packet_loss_perc(10).expect("loss hint applies");
			let mut decoder = OutputDecoder::new().expect("Opus decoder initializes");
			let mut played = 0;
			for sequence in 0..10u16 {
				let mut packet = [0; MAX_ENCODED_OPUS_BYTES];
				let length = encoder
					.encode_float(&speech, &mut packet)
					.expect("frame encodes");
				if lost.contains(&sequence) {
					continue;
				}
				let decoded = decoder.push(sequence, &packet[..length], |samples| {
					played += samples.len();
					true
				});
				assert_eq!(decoded, Ok(true));
			}
			assert_eq!(played, 10 * OUTPUT_FRAME_SAMPLES, "lost {lost:?}");
		}
	}
}
