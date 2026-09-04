//! Integration coverage for the document authority client protocol.

use std::fs;

use bytes::{Bytes, BytesMut};
use omp_envd::docserver::{
	Environment, ServerConfig,
	connection::{ConnectionConfig, PROTOCOL_MAJOR, PROTOCOL_MINOR, serve_connection},
	wire::{FrameConfig, read_server_frame, write_client_frame},
};
use omp_proto::document::v1::{self as pb, client_frame, server_frame};
use tempfile::TempDir;
use tokio::{io, io::DuplexStream};

async fn send(
	stream: &mut DuplexStream,
	request_id: u64,
	body: client_frame::Body,
	scratch: &mut BytesMut,
) {
	write_client_frame(
		stream,
		&pb::ClientFrame { request_id, body: Some(body) },
		FrameConfig::default(),
		scratch,
	)
	.await
	.expect("write client frame");
}

async fn receive(
	stream: &mut DuplexStream,
	request_id: u64,
	scratch: &mut BytesMut,
) -> server_frame::Body {
	loop {
		let frame = read_server_frame(stream, FrameConfig::default(), scratch)
			.await
			.expect("read server frame")
			.expect("server frame");
		if frame.request_id == request_id {
			return frame.body.expect("response body");
		}
		assert_eq!(frame.request_id, 0, "unexpected correlated response");
	}
}

async fn receive_ordinary(
	stream: &mut DuplexStream,
	scratch: &mut BytesMut,
) -> (u64, server_frame::Body) {
	loop {
		let frame = read_server_frame(stream, FrameConfig::default(), scratch)
			.await
			.expect("read server frame")
			.expect("server frame");
		if frame.request_id != 0 {
			return (frame.request_id, frame.body.expect("response body"));
		}
	}
}

fn commit(
	transaction_id: Bytes,
	lease_id: Bytes,
	base_revision: pb::Revision,
	content: &'static [u8],
) -> client_frame::Body {
	client_frame::Body::CommitTransaction(pb::CommitTransactionRequest {
		transaction_id,
		operations: vec![pb::DocumentMutation {
			document:  Some(pb::DocumentTarget {
				target: Some(pb::document_target::Target::LeaseId(lease_id)),
			}),
			operation: Some(pb::document_mutation::Operation::Text(pb::TextMutation {
				base_revision: Some(base_revision),
				change:        Some(pb::text_mutation::Change::ProposedContent(Bytes::from_static(
					content,
				))),
				stale_policy:  pb::StalePolicy::Fail.into(),
				format_policy: pb::FormatPolicy::Disabled.into(),
			})),
		}],
	})
}

#[tokio::test]
async fn transaction_race_replays_one_outcome_and_stale_retry_conflicts() {
	let root = TempDir::new().expect("temporary root");
	let config = ServerConfig::new(root.path()).expect("server config");
	let path = config.environment_root().join("race.txt");
	fs::write(&path, b"before").expect("fixture");
	let uri = config.file_uri(&path).expect("file URI").to_string();
	let environment = Environment::new(config).expect("environment");
	let epoch = *environment.server_epoch();
	let (mut client, server) = io::duplex(64 * 1024);
	let authority = environment.clone();
	let server_task = tokio::spawn(async move {
		serve_connection(authority, server, ConnectionConfig::default()).await
	});
	let mut write_scratch = BytesMut::new();
	let mut read_scratch = BytesMut::new();

	send(
		&mut client,
		0,
		client_frame::Body::Hello(pb::ClientHello {
			protocol_major: PROTOCOL_MAJOR,
			protocol_minor: PROTOCOL_MINOR,
			client_id:      Bytes::from_static(b"authority-race-test"),
		}),
		&mut write_scratch,
	)
	.await;
	let server_frame::Body::Hello(hello) = receive(&mut client, 0, &mut read_scratch).await else {
		panic!("server hello");
	};
	assert_eq!(hello.server_epoch.as_ref(), epoch.as_slice());

	send(
		&mut client,
		1,
		client_frame::Body::OpenDocument(pb::OpenDocumentRequest { uri, language_id: String::new() }),
		&mut write_scratch,
	)
	.await;
	let server_frame::Body::DocumentOpened(opened) =
		receive(&mut client, 1, &mut read_scratch).await
	else {
		panic!("open response");
	};
	let base = opened
		.head
		.as_ref()
		.and_then(|head| head.revision.clone())
		.expect("base revision");
	let transaction_id = Bytes::from_static(b"same-txn-id-0001");
	send(
		&mut client,
		2,
		commit(transaction_id.clone(), opened.lease_id.clone(), base.clone(), b"left"),
		&mut write_scratch,
	)
	.await;
	send(
		&mut client,
		3,
		commit(transaction_id.clone(), opened.lease_id.clone(), base.clone(), b"right"),
		&mut write_scratch,
	)
	.await;
	let (first_id, first) = receive_ordinary(&mut client, &mut read_scratch).await;
	let (second_id, second) = receive_ordinary(&mut client, &mut read_scratch).await;
	assert!(
		(first_id == 2 && second_id == 3) || (first_id == 3 && second_id == 2),
		"both raced requests must complete",
	);
	assert_eq!(first, second, "duplicate transaction ids must replay the original outcome");

	send(
		&mut client,
		4,
		commit(Bytes::from_static(b"stale-txn-id-001"), opened.lease_id, base, b"stale"),
		&mut write_scratch,
	)
	.await;
	let server_frame::Body::TransactionResult(stale) =
		receive(&mut client, 4, &mut read_scratch).await
	else {
		panic!("stale transaction response");
	};
	assert!(matches!(
		stale.outcome,
		Some(pb::commit_transaction_response::Outcome::Rejected(pb::TransactionRejected {
			reason,
			..
		})) if reason == i32::from(pb::TransactionRejectReason::StaleBase)
	));

	drop(client);
	server_task
		.await
		.expect("server task")
		.expect("authority shutdown");
	environment.shutdown().await;
}
