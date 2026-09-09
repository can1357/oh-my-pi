//! Validates that protobuf frame limits reject malformed and oversized
//! payloads.

use omp_proto::bounds::{
	DECLARATION_MAX_COUNT, FRAME_MAX_BYTES, FrameBoundsError, LENGTH_DELIMITED_MAX_COUNT,
	PROTOBUF_MAX_DEPTH, PULL_ALIAS_MAX_COUNT, PULL_CHUNK_MAX_BYTES, PULL_EXPECTED_MAX_BYTES,
	PULL_NAME_MAX_BYTES, PULL_PATH_MAX_SEGMENTS, REPEATED_MAX_COUNT, RESULT_CHUNK_MAX_BYTES,
	TML_MAX_BYTES, TML_MAX_DEPTH, TOOL_EXAMPLE_MAX_COUNT, validate_host_frame,
	validate_worker_frame,
};

fn push_varint(mut value: u64, out: &mut Vec<u8>) {
	loop {
		let byte = (value & 0x7f) as u8;
		value >>= 7;
		if value == 0 {
			out.push(byte);
			return;
		}
		out.push(byte | 0x80);
	}
}

fn push_key(field: u32, wire_type: u8, out: &mut Vec<u8>) {
	push_varint((u64::from(field) << 3) | u64::from(wire_type), out);
}

fn push_len(field: u32, payload: &[u8], out: &mut Vec<u8>) {
	push_key(field, 2, out);
	push_varint(payload.len() as u64, out);
	out.extend_from_slice(payload);
}

fn push_uint(field: u32, value: u64, out: &mut Vec<u8>) {
	push_key(field, 0, out);
	push_varint(value, out);
}

fn worker_frame(field: u32, payload: &[u8]) -> Vec<u8> {
	let mut frame = Vec::new();
	push_len(field, payload, &mut frame);
	frame
}

fn host_frame(field: u32, payload: &[u8]) -> Vec<u8> {
	let mut frame = Vec::new();
	push_len(field, payload, &mut frame);
	frame
}

fn worker_ui_effect(effect: &[u8]) -> Vec<u8> {
	let mut ui = Vec::new();
	push_len(2, effect, &mut ui);
	worker_frame(14, &ui)
}

fn worker_tml(source: &[u8]) -> Vec<u8> {
	let mut tml = Vec::new();
	push_len(1, source, &mut tml);
	let mut mount = Vec::new();
	push_len(3, &tml, &mut mount);
	let mut effect = Vec::new();
	push_len(1, &mount, &mut effect);
	worker_ui_effect(&effect)
}

fn worker_pull_request(pull: &[u8]) -> Vec<u8> {
	let mut arguments = Vec::new();
	push_len(1, pull, &mut arguments);
	worker_frame(11, &arguments)
}

#[test]
fn rejects_malformed_and_truncated_varints_before_decode() {
	let malformed = [0x80; 11];
	assert!(matches!(
		validate_worker_frame(&malformed),
		Err(FrameBoundsError::MalformedVarint { offset: 0 })
	));

	let truncated = [0x72, 0x05, 0x08];
	assert!(matches!(
		validate_worker_frame(&truncated),
		Err(FrameBoundsError::Truncated { needed: 5, remaining: 1, .. })
	));

	let overflowing_length = [0x72, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x02];
	assert!(matches!(
		validate_worker_frame(&overflowing_length),
		Err(FrameBoundsError::MalformedVarint { offset: 1 })
	));
}

#[test]
fn rejects_malformed_nested_hook_and_context_payloads() {
	let malformed = [0x80];
	let mut hook = Vec::new();
	push_len(4, &malformed, &mut hook);
	assert!(matches!(
		validate_worker_frame(&worker_frame(12, &hook)),
		Err(FrameBoundsError::MalformedVarint { .. })
	));

	let mut context = Vec::new();
	push_len(1, &malformed, &mut context);
	assert!(matches!(
		validate_worker_frame(&worker_frame(16, &context)),
		Err(FrameBoundsError::MalformedVarint { .. })
	));
}

#[test]
fn rejects_unbounded_nested_value_maps() {
	let mut nested = Vec::new();
	for _ in 0..=PROTOBUF_MAX_DEPTH {
		let mut parent = Vec::new();
		push_len(15, &nested, &mut parent);
		nested = parent;
	}
	assert!(matches!(
		validate_host_frame(&nested),
		Err(FrameBoundsError::ProtobufTooDeep {
			actual,
			limit: PROTOBUF_MAX_DEPTH,
		}) if actual == PROTOBUF_MAX_DEPTH + 1
	));
}

#[test]
fn rejects_more_than_the_generic_length_field_limit() {
	let mut invoke = Vec::new();
	for _ in 0..=LENGTH_DELIMITED_MAX_COUNT {
		push_len(2, &[], &mut invoke);
	}
	assert!(matches!(
		validate_host_frame(&host_frame(2, &invoke)),
		Err(FrameBoundsError::TooManyLengthDelimitedFields {
			actual,
			limit: LENGTH_DELIMITED_MAX_COUNT,
			..
		}) if actual == LENGTH_DELIMITED_MAX_COUNT + 1
	));
}

#[test]
fn enforces_pull_request_table_and_accepts_exact_boundaries() {
	let mut valid = Vec::new();
	let name = vec![b'k'; PULL_NAME_MAX_BYTES];
	for _ in 0..PULL_PATH_MAX_SEGMENTS {
		push_len(2, &name, &mut valid);
	}
	for _ in 0..PULL_ALIAS_MAX_COUNT {
		push_len(4, &name, &mut valid);
	}
	push_len(3, &name, &mut valid);
	push_len(5, &vec![b'e'; PULL_EXPECTED_MAX_BYTES], &mut valid);
	push_uint(6, PULL_CHUNK_MAX_BYTES as u64, &mut valid);
	validate_worker_frame(&worker_pull_request(&valid)).unwrap();

	let mut too_many_path = valid.clone();
	push_len(2, b"extra", &mut too_many_path);
	assert!(matches!(
		validate_worker_frame(&worker_pull_request(&too_many_path)),
		Err(FrameBoundsError::TooManyRepeatedValues {
			message: "PullRequest",
			field: 2,
			actual,
			limit: PULL_PATH_MAX_SEGMENTS,
		}) if actual == PULL_PATH_MAX_SEGMENTS + 1
	));

	let mut too_many_aliases = Vec::new();
	for _ in 0..=PULL_ALIAS_MAX_COUNT {
		push_len(4, b"alias", &mut too_many_aliases);
	}
	assert!(matches!(
		validate_worker_frame(&worker_pull_request(&too_many_aliases)),
		Err(FrameBoundsError::TooManyRepeatedValues { field: 4, .. })
	));

	let mut long_expected = Vec::new();
	push_len(5, &vec![b'e'; PULL_EXPECTED_MAX_BYTES + 1], &mut long_expected);
	assert!(matches!(
		validate_worker_frame(&worker_pull_request(&long_expected)),
		Err(FrameBoundsError::FieldTooLarge { message: "PullRequest", field: 5, .. })
	));

	let mut large_chunk_request = Vec::new();
	push_uint(6, (PULL_CHUNK_MAX_BYTES + 1) as u64, &mut large_chunk_request);
	assert!(matches!(
		validate_worker_frame(&worker_pull_request(&large_chunk_request)),
		Err(FrameBoundsError::PullChunkTooLarge { .. })
	));
}

#[test]
fn enforces_pull_reply_chunk_before_decode() {
	let mut reply = Vec::new();
	push_len(2, &vec![0; PULL_CHUNK_MAX_BYTES], &mut reply);
	let mut arguments = Vec::new();
	push_len(4, &reply, &mut arguments);
	validate_host_frame(&host_frame(6, &arguments)).unwrap();

	let mut oversized = Vec::new();
	push_len(2, &vec![0; PULL_CHUNK_MAX_BYTES + 1], &mut oversized);
	let mut arguments = Vec::new();
	push_len(4, &oversized, &mut arguments);
	assert!(matches!(
		validate_host_frame(&host_frame(6, &arguments)),
		Err(FrameBoundsError::FieldTooLarge { message: "PullReply", field: 2, .. })
	));
}

#[test]
fn bounds_tool_examples_and_repeated_part_buffers() {
	let mut valid_tool = Vec::new();
	for _ in 0..TOOL_EXAMPLE_MAX_COUNT {
		push_len(9, &[], &mut valid_tool);
	}
	let mut registration = Vec::new();
	push_len(1, &valid_tool, &mut registration);
	validate_worker_frame(&worker_frame(3, &registration)).unwrap();

	let mut invalid_tool = valid_tool;
	push_len(9, &[], &mut invalid_tool);
	let mut registration = Vec::new();
	push_len(1, &invalid_tool, &mut registration);
	assert!(matches!(
		validate_worker_frame(&worker_frame(3, &registration)),
		Err(FrameBoundsError::TooManyRepeatedValues {
			message: "ToolDecl",
			field: 9,
			actual,
			limit: TOOL_EXAMPLE_MAX_COUNT,
		}) if actual == TOOL_EXAMPLE_MAX_COUNT + 1
	));

	let mut completion = Vec::new();
	for _ in 0..=REPEATED_MAX_COUNT {
		push_len(2, &[], &mut completion);
	}
	let mut result = Vec::new();
	push_len(1, &completion, &mut result);
	assert!(matches!(
		validate_worker_frame(&worker_frame(22, &result)),
		Err(FrameBoundsError::TooManyRepeatedValues { message: "ToolResultStart", field: 2, .. })
	));

	let mut chunk = Vec::new();
	push_len(2, &vec![0; RESULT_CHUNK_MAX_BYTES + 1], &mut chunk);
	let mut result = Vec::new();
	push_len(2, &chunk, &mut result);
	assert!(matches!(
		validate_worker_frame(&worker_frame(22, &result)),
		Err(FrameBoundsError::FieldTooLarge { message: "ToolResultChunk", field: 2, .. })
	));
}

#[test]
fn bounds_registration_declarations() {
	let mut registration = Vec::new();
	for _ in 0..DECLARATION_MAX_COUNT {
		push_len(1, &[], &mut registration);
	}
	validate_worker_frame(&worker_frame(3, &registration)).unwrap();
	push_len(1, &[], &mut registration);
	assert!(matches!(
		validate_worker_frame(&worker_frame(3, &registration)),
		Err(FrameBoundsError::TooManyRepeatedValues { message: "RegisterTools", field: 1, .. })
	));
}

#[test]
fn bounds_lifecycle_declaration_collections() {
	let mut admitted = Vec::new();
	for _ in 0..DECLARATION_MAX_COUNT {
		push_len(1, &[], &mut admitted);
	}
	let mut host_lifecycle = Vec::new();
	push_len(1, &admitted, &mut host_lifecycle);
	validate_host_frame(&host_frame(5, &host_lifecycle)).unwrap();

	push_len(1, &[], &mut admitted);
	host_lifecycle.clear();
	push_len(1, &admitted, &mut host_lifecycle);
	assert!(matches!(
		validate_host_frame(&host_frame(5, &host_lifecycle)),
		Err(FrameBoundsError::TooManyRepeatedValues { message: "AdmitExtensions", field: 1, .. })
	));

	let mut availability = Vec::new();
	for _ in 0..DECLARATION_MAX_COUNT {
		push_len(1, &[], &mut availability);
	}
	let mut worker_lifecycle = Vec::new();
	push_len(1, &availability, &mut worker_lifecycle);
	validate_worker_frame(&worker_frame(10, &worker_lifecycle)).unwrap();

	push_len(1, &[], &mut availability);
	worker_lifecycle.clear();
	push_len(1, &availability, &mut worker_lifecycle);
	assert!(matches!(
		validate_worker_frame(&worker_frame(10, &worker_lifecycle)),
		Err(FrameBoundsError::TooManyRepeatedValues { message: "SetAvailability", field: 1, .. })
	));
}

#[test]
fn accepts_tml_max_bytes_and_depth_boundaries() {
	validate_worker_frame(&worker_tml(&vec![b'x'; TML_MAX_BYTES])).unwrap();

	let mut nested = Vec::new();
	for _ in 0..TML_MAX_DEPTH {
		nested.extend_from_slice(b"<panel>");
	}
	for _ in 0..TML_MAX_DEPTH {
		nested.extend_from_slice(b"</panel>");
	}
	validate_worker_frame(&worker_tml(&nested)).unwrap();
}

#[test]
fn rejects_tml_bytes_and_depth_before_decode() {
	assert!(matches!(
		validate_worker_frame(&worker_tml(&vec![b'x'; TML_MAX_BYTES + 1])),
		Err(FrameBoundsError::TmlTooLarge {
			actual,
			limit: TML_MAX_BYTES,
		}) if actual == TML_MAX_BYTES + 1
	));

	let mut nested = Vec::new();
	for _ in 0..=TML_MAX_DEPTH {
		nested.extend_from_slice(b"<panel>");
	}
	for _ in 0..=TML_MAX_DEPTH {
		nested.extend_from_slice(b"</panel>");
	}
	assert!(matches!(
		validate_worker_frame(&worker_tml(&nested)),
		Err(FrameBoundsError::TmlTooDeep {
			actual,
			limit: TML_MAX_DEPTH,
		}) if actual == TML_MAX_DEPTH + 1
	));
}

#[test]
fn ignores_markup_like_text_in_comments_and_attributes() {
	let source = br"<!-- <panel><panel> --><panel title='<panel>'></panel>";
	validate_worker_frame(&worker_tml(source)).unwrap();
}

#[test]
fn accepts_an_exact_maximum_frame_without_decoding_it() {
	let mut frame = Vec::with_capacity(FRAME_MAX_BYTES);
	push_key(21, 2, &mut frame);
	let prefix = frame.len() + 4;
	let payload_len = FRAME_MAX_BYTES - prefix;
	push_varint(payload_len as u64, &mut frame);
	frame.resize(FRAME_MAX_BYTES, 0);
	assert_eq!(frame.len(), FRAME_MAX_BYTES);
	validate_host_frame(&frame).unwrap();
	frame.push(0);
	assert!(matches!(
		validate_host_frame(&frame),
		Err(FrameBoundsError::FrameTooLarge {
			actual,
			limit: FRAME_MAX_BYTES,
		}) if actual == FRAME_MAX_BYTES + 1
	));
}
