//! Transport framing conformance tests.

use bytes::Bytes;
use omp_ai::transport::{
	ConnectDecoder, ConnectEnvelope, ConnectEnvelopeKind, CrcScope, EventStreamDecoder,
	EventStreamHeaderValue, EventStreamMessage, Frame, FramingError, FramingProtocol, NdjsonDecoder,
	RawChunkFramer, SseDecoder, SseEvent, WebSocketDecoder, WebSocketFragment, WebSocketMessage,
	WebSocketOpcode,
};
use serde::Deserialize;

fn decode_hex(encoded: &str) -> Vec<u8> {
	assert_eq!(encoded.len() % 2, 0, "hex fixture has complete bytes");
	encoded
		.as_bytes()
		.as_chunks::<2>()
		.0
		.iter()
		.map(|pair| {
			fn nibble(byte: u8) -> u8 {
				match byte {
					b'0'..=b'9' => byte - b'0',
					b'a'..=b'f' => byte - b'a' + 10,
					b'A'..=b'F' => byte - b'A' + 10,
					_ => panic!("non-hex fixture byte"),
				}
			}
			(nibble(pair[0]) << 4) | nibble(pair[1])
		})
		.collect()
}

#[derive(Deserialize)]
struct SseFixture {
	cases: Vec<SseCase>,
}

#[derive(Deserialize)]
struct SseCase {
	steps:       Vec<SseStep>,
	final_state: SseFinalState,
}

#[derive(Deserialize)]
struct SseStep {
	input_hex: String,
	emitted:   Vec<SseExpected>,
}

#[derive(Deserialize)]
struct SseExpected {
	name:     Option<String>,
	data_hex: String,
}

#[derive(Deserialize)]
struct SseFinalState {
	done:          bool,
	last_event_id: Option<String>,
	retry_ms:      Option<u64>,
}

#[test]
fn replays_every_sse_cassette_step_exactly() {
	let fixture: SseFixture =
		serde_json::from_str(include_str!("../../../fixtures/llm-oracle/transport/sse.json"))
			.expect("typed SSE fixture");
	for case in fixture.cases {
		let mut decoder = SseDecoder::new();
		for step in case.steps {
			let actual = decoder
				.push(Bytes::from(decode_hex(&step.input_hex)))
				.expect("valid SSE step");
			let expected: Vec<SseEvent> = step
				.emitted
				.into_iter()
				.map(|event| SseEvent {
					name: event.name.map(Into::into),
					data: Bytes::from(decode_hex(&event.data_hex)),
				})
				.collect();
			assert_eq!(actual.as_slice(), expected.as_slice());
		}
		assert_eq!(decoder.is_done(), case.final_state.done);
		assert_eq!(decoder.last_event_id(), case.final_state.last_event_id.as_deref());
		assert_eq!(decoder.retry_ms(), case.final_state.retry_ms);
	}
}

#[test]
fn every_sse_cassette_is_chunk_strategy_invariant() {
	let fixture: SseFixture =
		serde_json::from_str(include_str!("../../../fixtures/llm-oracle/transport/sse.json"))
			.expect("typed SSE fixture");
	for case in &fixture.cases {
		let input: Vec<u8> = case
			.steps
			.iter()
			.flat_map(|step| decode_hex(&step.input_hex))
			.collect();
		let expected: Vec<SseEvent> = case
			.steps
			.iter()
			.flat_map(|step| &step.emitted)
			.map(|event| SseEvent {
				name: event.name.as_deref().map(Into::into),
				data: Bytes::from(decode_hex(&event.data_hex)),
			})
			.collect();
		for chunk_size in [1, 2, 7, input.len()] {
			let mut decoder = SseDecoder::new();
			let mut actual = Vec::new();
			for chunk in input.chunks(chunk_size) {
				actual.extend(
					decoder
						.push(Bytes::copy_from_slice(chunk))
						.expect("valid re-chunked SSE"),
				);
			}
			actual.extend(decoder.finish().expect("complete re-chunked SSE"));
			assert_eq!(actual, expected);
			assert_eq!(decoder.is_done(), case.final_state.done);
			assert_eq!(decoder.last_event_id(), case.final_state.last_event_id.as_deref());
			assert_eq!(decoder.retry_ms(), case.final_state.retry_ms);
		}
	}
}

#[derive(Deserialize)]
struct ChunkingFixture {
	cases: Vec<ChunkingCase>,
}

#[derive(Deserialize)]
struct ChunkingCase {
	concatenated_hex: String,
	strategies: Vec<ChunkStrategy>,
	expected_frames_for_every_strategy: Vec<SseExpected>,
}

#[derive(Deserialize)]
struct ChunkStrategy {
	boundaries: Vec<usize>,
}

#[test]
fn sse_outputs_are_identical_under_every_recorded_chunk_strategy() {
	let fixture: ChunkingFixture =
		serde_json::from_str(include_str!("../../../fixtures/llm-oracle/transport/chunking.json"))
			.expect("typed chunking fixture");
	for case in fixture.cases {
		let input = decode_hex(&case.concatenated_hex);
		let expected: Vec<SseEvent> = case
			.expected_frames_for_every_strategy
			.into_iter()
			.map(|event| SseEvent {
				name: event.name.map(Into::into),
				data: Bytes::from(decode_hex(&event.data_hex)),
			})
			.collect();
		for strategy in case.strategies {
			let mut decoder = SseDecoder::new();
			let mut actual = Vec::new();
			let mut start = 0;
			for end in strategy.boundaries {
				actual.extend(
					decoder
						.push(Bytes::copy_from_slice(&input[start..end]))
						.expect("valid chunked SSE"),
				);
				start = end;
			}
			actual.extend(decoder.finish().expect("complete SSE boundary"));
			assert_eq!(actual, expected);
		}
	}
}

#[derive(Deserialize)]
struct NdjsonFixture {
	cases: Vec<NdjsonCase>,
}

#[derive(Deserialize)]
struct NdjsonCase {
	steps: Vec<NdjsonStep>,
}

#[derive(Deserialize)]
struct NdjsonStep {
	input_hex:   String,
	emitted_hex: Vec<String>,
}

#[test]
fn replays_every_ndjson_cassette_step_exactly() {
	let fixture: NdjsonFixture =
		serde_json::from_str(include_str!("../../../fixtures/llm-oracle/transport/ndjson.json"))
			.expect("typed NDJSON fixture");
	for case in fixture.cases {
		let mut decoder = NdjsonDecoder::new();
		let mut pending = Vec::new();
		for step in case.steps {
			let input = decode_hex(&step.input_hex);
			pending.extend_from_slice(&input);
			if let Some(last_newline) = pending.iter().rposition(|byte| *byte == b'\n') {
				pending.drain(..=last_newline);
			}
			let actual = decoder.push(Bytes::from(input)).expect("valid NDJSON step");
			let expected: Vec<Bytes> = step
				.emitted_hex
				.iter()
				.map(|encoded| Bytes::from(decode_hex(encoded)))
				.collect();
			assert_eq!(actual.as_slice(), expected.as_slice());
			assert_eq!(decoder.buffered_len(), pending.len());
		}
	}
}

#[test]
fn every_ndjson_cassette_is_chunk_strategy_invariant() {
	let fixture: NdjsonFixture =
		serde_json::from_str(include_str!("../../../fixtures/llm-oracle/transport/ndjson.json"))
			.expect("typed NDJSON fixture");
	for case in &fixture.cases {
		let input: Vec<u8> = case
			.steps
			.iter()
			.flat_map(|step| decode_hex(&step.input_hex))
			.collect();
		let expected: Vec<Bytes> = case
			.steps
			.iter()
			.flat_map(|step| &step.emitted_hex)
			.map(|encoded| Bytes::from(decode_hex(encoded)))
			.collect();
		for chunk_size in [1, 2, 7, input.len()] {
			let mut decoder = NdjsonDecoder::new();
			let mut actual = Vec::new();
			for chunk in input.chunks(chunk_size) {
				actual.extend(
					decoder
						.push(Bytes::copy_from_slice(chunk))
						.expect("valid re-chunked NDJSON"),
				);
			}
			actual.extend(decoder.finish().expect("complete re-chunked NDJSON"));
			assert_eq!(actual, expected);
		}
	}
}

#[derive(Deserialize)]
struct ConnectFixture {
	cases: Vec<ConnectCase>,
}

#[derive(Deserialize)]
struct ConnectCase {
	byte_range:       Option<[usize; 2]>,
	chunk_boundaries: Option<Vec<usize>>,
	expected_frames:  Option<Vec<ConnectExpected>>,
	input_hex:        Option<String>,
}

#[derive(Deserialize)]
struct ConnectExpected {
	flags:       u8,
	kind:        String,
	payload_hex: String,
}

#[test]
fn connect_fixture_preserves_envelopes_under_recorded_splits_and_reports_first_eof() {
	let fixture: ConnectFixture =
		serde_json::from_str(include_str!("../../../fixtures/llm-oracle/transport/connect.json"))
			.expect("typed Connect fixture");
	let binary = include_bytes!("../../../fixtures/llm-oracle/transport/connect_frames.bin");
	let split = &fixture.cases[0];
	let [start, end] = split.byte_range.expect("binary range");
	let mut decoder = ConnectDecoder::new();
	let mut actual = Vec::new();
	let mut cursor = start;
	for boundary in split.chunk_boundaries.as_ref().expect("chunk boundaries") {
		actual.extend(
			decoder
				.push(Bytes::copy_from_slice(&binary[cursor..*boundary]))
				.expect("valid Connect chunk"),
		);
		cursor = *boundary;
	}
	assert_eq!(cursor, end);
	let expected: Vec<ConnectEnvelope> = split
		.expected_frames
		.as_ref()
		.expect("expected envelopes")
		.iter()
		.map(|frame| ConnectEnvelope {
			flags:   frame.flags,
			kind:    if frame.kind == "message" {
				ConnectEnvelopeKind::Message
			} else {
				ConnectEnvelopeKind::EndStream
			},
			payload: Bytes::from(decode_hex(&frame.payload_hex)),
		})
		.collect();
	assert_eq!(actual, expected);
	for chunk_size in [1, 2, 7, end - start] {
		let mut decoder = ConnectDecoder::new();
		let mut rechunked = Vec::new();
		for chunk in binary[start..end].chunks(chunk_size) {
			rechunked.extend(
				decoder
					.push(Bytes::copy_from_slice(chunk))
					.expect("valid re-chunked Connect stream"),
			);
		}
		assert!(
			decoder
				.finish()
				.expect("complete Connect stream")
				.is_empty()
		);
		assert_eq!(rechunked, expected);
	}

	let mut truncated = ConnectDecoder::new();
	let bytes = decode_hex(
		fixture.cases[1]
			.input_hex
			.as_deref()
			.expect("truncated input"),
	);
	assert!(
		truncated
			.push(Bytes::from(bytes))
			.expect("buffer truncation")
			.is_empty()
	);
	assert_eq!(
		truncated.finish(),
		Err(FramingError::UnexpectedEof {
			protocol:    FramingProtocol::Connect,
			declared:    7,
			available:   5,
			first_frame: true,
		})
	);
}

#[derive(Deserialize)]
struct WebSocketFixture {
	cases: Vec<WebSocketCase>,
}

#[derive(Deserialize)]
struct WebSocketCase {
	frames: Option<Vec<WebSocketFrameFixture>>,
}

#[derive(Deserialize)]
struct WebSocketFrameFixture {
	opcode:      String,
	payload_hex: String,
}

#[test]
fn websocket_binary_and_close_cassette_preserves_message_boundaries() {
	let fixture: WebSocketFixture =
		serde_json::from_str(include_str!("../../../fixtures/llm-oracle/transport/websocket.json"))
			.expect("typed WebSocket fixture");
	let frames = fixture.cases[1].frames.as_ref().expect("binary frame case");
	let mut decoder = WebSocketDecoder::new();
	let mut output = Vec::new();
	for frame in frames {
		let opcode = match frame.opcode.as_str() {
			"binary" => WebSocketOpcode::Binary,
			"close" => WebSocketOpcode::Close,
			_ => panic!("unexpected fixture opcode"),
		};
		output.extend(
			decoder
				.push_fragment(WebSocketFragment {
					fin: true,
					opcode,
					payload: Bytes::from(decode_hex(&frame.payload_hex)),
				})
				.expect("valid WebSocket fragment"),
		);
	}
	assert!(matches!(output[0], WebSocketMessage::Binary(_)));
	assert_eq!(output[1], WebSocketMessage::Close { code: Some(1000), reason: Bytes::new() });
}

#[test]
fn raw_websocket_wire_parser_preserves_fragmented_utf8_and_control_boundaries() {
	let wire = [
		0x01, 0x04, b'c', b'a', b'f', 0xc3, // non-final text
		0x89, 0x01, b'?', // interleaved ping
		0x80, 0x01, 0xa9, // final continuation
		0x82, 0x02, 0x00, 0xff, // binary
	];
	let mut decoder = WebSocketDecoder::new();
	let mut messages = Vec::new();
	for byte in wire {
		messages.extend(
			decoder
				.push(Bytes::from(vec![byte]))
				.expect("valid byte-at-a-time WebSocket stream"),
		);
	}
	assert_eq!(messages, vec![
		WebSocketMessage::Ping(Bytes::from_static(b"?")),
		WebSocketMessage::Text(Bytes::from_static("café".as_bytes())),
		WebSocketMessage::Binary(Bytes::from_static(b"\x00\xff")),
	]);
	assert!(decoder.finish().expect("complete messages").is_empty());
}

#[test]
fn websocket_invalid_utf8_and_truncated_fragment_are_typed() {
	let mut invalid = WebSocketDecoder::new();
	assert_eq!(
		invalid.push(Bytes::from_static(b"\x81\x01\xff")),
		Err(FramingError::InvalidUtf8 {
			protocol: FramingProtocol::WebSocket,
			field:    omp_ai::transport::Utf8Field::WebSocketText,
		})
	);

	let mut truncated = WebSocketDecoder::new();
	assert!(
		truncated
			.push_fragment(WebSocketFragment {
				fin:     false,
				opcode:  WebSocketOpcode::Binary,
				payload: Bytes::from_static(b"partial"),
			})
			.expect("valid first fragment")
			.is_empty()
	);
	assert!(matches!(
		truncated.finish(),
		Err(FramingError::UnexpectedEof {
			protocol: FramingProtocol::WebSocket,
			first_frame: true,
			..
		})
	));
}

fn decode_eventstream(
	bytes: &[u8],
	chunk_size: usize,
) -> Result<Vec<EventStreamMessage>, FramingError> {
	let mut decoder = EventStreamDecoder::new();
	let mut messages = Vec::new();
	for chunk in bytes.chunks(chunk_size) {
		messages.extend(decoder.push(Bytes::copy_from_slice(chunk))?);
	}
	messages.extend(decoder.finish()?);
	Ok(messages)
}

fn encode_eventstream(headers: &[u8], payload: &[u8]) -> Vec<u8> {
	let total = 16 + headers.len() + payload.len();
	let mut message = Vec::with_capacity(total);
	message.extend_from_slice(
		&u32::try_from(total)
			.expect("small test message")
			.to_be_bytes(),
	);
	message.extend_from_slice(
		&u32::try_from(headers.len())
			.expect("small test headers")
			.to_be_bytes(),
	);
	let prelude_crc = crc32fast::hash(&message);
	message.extend_from_slice(&prelude_crc.to_be_bytes());
	message.extend_from_slice(headers);
	message.extend_from_slice(payload);
	let message_crc = crc32fast::hash(&message);
	message.extend_from_slice(&message_crc.to_be_bytes());
	message
}

fn push_header(headers: &mut Vec<u8>, name: &str, kind: u8, value: &[u8]) {
	headers.push(u8::try_from(name.len()).expect("short test header name"));
	headers.extend_from_slice(name.as_bytes());
	headers.push(kind);
	headers.extend_from_slice(value);
}

#[test]
fn eventstream_validates_and_types_every_header_value() {
	let mut headers = Vec::new();
	push_header(&mut headers, "t", 0, &[]);
	push_header(&mut headers, "f", 1, &[]);
	push_header(&mut headers, "b", 2, &[0xfe]);
	push_header(&mut headers, "i16", 3, &(-2_i16).to_be_bytes());
	push_header(&mut headers, "i32", 4, &(-3_i32).to_be_bytes());
	push_header(&mut headers, "i64", 5, &(-4_i64).to_be_bytes());
	push_header(&mut headers, "bytes", 6, &[0, 2, 0xaa, 0xbb]);
	push_header(&mut headers, "string", 7, &[0, 3, b'h', b'i', b'!']);
	push_header(&mut headers, "time", 8, &123_i64.to_be_bytes());
	push_header(&mut headers, "uuid", 9, &[7; 16]);
	let wire = encode_eventstream(&headers, b"payload");
	let messages = decode_eventstream(&wire, 1).expect("all header kinds are valid");
	let message = &messages[0];
	assert_eq!(message.header("t"), Some(&EventStreamHeaderValue::Bool(true)));
	assert_eq!(message.header("f"), Some(&EventStreamHeaderValue::Bool(false)));
	assert_eq!(message.header("b"), Some(&EventStreamHeaderValue::Byte(-2)));
	assert_eq!(message.header("i16"), Some(&EventStreamHeaderValue::Int16(-2)));
	assert_eq!(message.header("i32"), Some(&EventStreamHeaderValue::Int32(-3)));
	assert_eq!(message.header("i64"), Some(&EventStreamHeaderValue::Int64(-4)));
	assert_eq!(
		message.header("bytes"),
		Some(&EventStreamHeaderValue::ByteArray(Bytes::from_static(b"\xaa\xbb")))
	);
	assert_eq!(message.string_header("string"), Some("hi!"));
	assert_eq!(message.header("time"), Some(&EventStreamHeaderValue::Timestamp(123)));
	assert_eq!(message.header("uuid"), Some(&EventStreamHeaderValue::Uuid([7; 16])));
	assert_eq!(message.payload, Bytes::from_static(b"payload"));

	let mut unknown = Vec::new();
	push_header(&mut unknown, "bad", 10, &[]);
	assert_eq!(
		decode_eventstream(&encode_eventstream(&unknown, &[]), 2),
		Err(FramingError::UnknownEventStreamHeaderType { kind: 10 })
	);

	let malformed = encode_eventstream(&[4, b'a'], &[]);
	assert!(matches!(
		decode_eventstream(&malformed, malformed.len()),
		Err(FramingError::InvalidEventStreamHeader { offset: 0 })
	));
}

#[test]
fn bedrock_eventstream_is_exact_under_all_chunkings_and_bounds_corruption() {
	let success = include_bytes!("../../../fixtures/llm-oracle/bedrock/eventstream-success.bin");
	let expected = decode_eventstream(success, success.len()).expect("valid whole EventStream");
	assert!(!expected.is_empty());
	for chunk_size in [1, 2, 3, 7, 31, 127, success.len()] {
		assert_eq!(
			decode_eventstream(success, chunk_size).expect("valid chunked EventStream"),
			expected
		);
	}
	for message in &expected {
		assert!(message.string_header(":message-type").is_some());
	}

	let invalid = include_bytes!("../../../fixtures/llm-oracle/bedrock/eventstream-invalid-crc.bin");
	for chunk_size in [1, 5, invalid.len()] {
		assert!(matches!(
			decode_eventstream(invalid, chunk_size),
			Err(FramingError::CrcMismatch { scope: CrcScope::Message, .. })
		));
	}

	let mut bad_prelude = success.to_vec();
	bad_prelude[7] ^= 1;
	assert!(matches!(
		decode_eventstream(&bad_prelude, 1),
		Err(FramingError::CrcMismatch { scope: CrcScope::Prelude, .. })
	));

	let truncated = include_bytes!("../../../fixtures/llm-oracle/bedrock/eventstream-truncated.bin");
	for chunk_size in [1, 11, truncated.len()] {
		assert!(matches!(
			decode_eventstream(truncated, chunk_size),
			Err(FramingError::UnexpectedEof { protocol: FramingProtocol::AwsEventStream, .. })
		));
	}
}

#[test]
fn completed_frames_precede_later_corruption_from_the_same_physical_chunk() {
	let mut ndjson = NdjsonDecoder::with_max_frame_bytes(4);
	assert_eq!(
		ndjson
			.push(Bytes::from_static(b"ok\n12345\n"))
			.expect("first record is visible before corruption")
			.as_slice(),
		[Bytes::from_static(b"ok")]
	);
	assert!(matches!(
		ndjson.finish(),
		Err(FramingError::LimitExceeded { protocol: FramingProtocol::Ndjson, .. })
	));

	let first = encode_eventstream(&[], b"ok");
	let mut corrupt = encode_eventstream(&[], b"bad");
	let last = corrupt.len() - 1;
	corrupt[last] ^= 1;
	let mut combined = first;
	combined.extend_from_slice(&corrupt);
	let mut eventstream = EventStreamDecoder::new();
	assert_eq!(
		eventstream
			.push(Bytes::from(combined))
			.expect("first message is visible before CRC failure")
			.len(),
		1
	);
	assert!(matches!(
		eventstream.finish(),
		Err(FramingError::CrcMismatch { scope: CrcScope::Message, .. })
	));

	let mut websocket = WebSocketDecoder::new();
	assert_eq!(
		websocket
			.push(Bytes::from_static(b"\x81\x02ok\xf1\x00"))
			.expect("first message is visible before invalid RSV bits")
			.as_slice(),
		[WebSocketMessage::Text(Bytes::from_static(b"ok"))]
	);
	assert!(matches!(websocket.finish(), Err(FramingError::InvalidWebSocketOpcode { .. })));
}

#[test]
fn raw_chunks_stream_without_aggregation_and_obey_per_chunk_bounds() {
	let mut framer = RawChunkFramer::new(4);
	assert_eq!(
		framer
			.push(Bytes::from_static(b"abc"))
			.expect("bounded media chunk")
			.as_slice(),
		[Bytes::from_static(b"abc")]
	);
	assert!(
		framer
			.push(Bytes::new())
			.expect("empty network chunk")
			.is_empty()
	);
	assert!(framer.finish().expect("clean media EOF").is_empty());

	let mut oversized = RawChunkFramer::new(4);
	assert_eq!(
		oversized.push(Bytes::from_static(b"12345")),
		Err(FramingError::LimitExceeded {
			protocol: FramingProtocol::RawChunks,
			limit:    4,
			observed: 5,
		})
	);

	let mut cancelled = RawChunkFramer::new(4);
	cancelled.cancel();
	assert_eq!(
		cancelled.push(Bytes::from_static(b"late")),
		Err(FramingError::Cancelled { protocol: FramingProtocol::RawChunks })
	);
}

#[test]
fn bounds_cancellation_and_end_state_are_typed() {
	let mut ndjson = NdjsonDecoder::with_max_frame_bytes(4);
	assert_eq!(
		ndjson.push(Bytes::from_static(b"12345")),
		Err(FramingError::LimitExceeded {
			protocol: FramingProtocol::Ndjson,
			limit:    4,
			observed: 5,
		})
	);

	let mut sse = SseDecoder::new();
	sse.cancel();
	assert_eq!(
		sse.push(Bytes::from_static(b"data: late\n\n")),
		Err(FramingError::Cancelled { protocol: FramingProtocol::Sse })
	);

	let raw = Frame::Raw(Bytes::from_static(b"unary"));
	assert_eq!(raw, Frame::Raw(Bytes::from_static(b"unary")));
}
