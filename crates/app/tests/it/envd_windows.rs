//! Windows-only behavioral coverage for the environment DATA named pipe.

use std::{path::PathBuf, sync::Arc, time::Duration};

use bytes::BytesMut;
use omp_core::{Principal, Str, sf};
use omp_env::windows::{
	OwnerPipeListener, connect_owner_pipe, read_client_frame, read_server_frame, write_client_frame,
	write_server_frame,
};
use omp_envd::{EnvServer, RegistryBridges, worker::ExtHostConfig};
use omp_proto::env::v1::{
	ClientFrame, ClientHello, ServerFrame, ServerHello, client_frame, server_frame,
};
use omp_tool::Registry;
use tokio::{net::windows::named_pipe::ClientOptions, time};

fn unique_endpoint(test: &str) -> PathBuf {
	PathBuf::from(format!(r"\\.\pipe\omp-env-test-{}-{test}", std::process::id()))
}

#[tokio::test]
async fn listener_is_ready_owner_exclusive_cancel_safe_and_cleans_up() {
	let endpoint = unique_endpoint("lifecycle");
	let mut listener = OwnerPipeListener::bind(&endpoint).expect("bind owner pipe");
	assert_eq!(listener.endpoint(), endpoint);
	assert!(OwnerPipeListener::bind(&endpoint).is_err());

	assert!(
		tokio::time::timeout(Duration::from_millis(10), listener.accept())
			.await
			.is_err()
	);
	let client = ClientOptions::new()
		.open(&endpoint)
		.expect("listener remains ready");
	let connected = listener.accept().await.expect("accept after cancellation");
	drop(client);
	drop(connected);
	drop(listener);

	let rebound = OwnerPipeListener::bind(&endpoint).expect("dropped pipe is cleaned up");
	drop(rebound);
}

#[tokio::test]
async fn typed_client_uses_shared_varint_codec_and_disconnects_cleanly() {
	let endpoint = unique_endpoint("typed");
	let mut listener = OwnerPipeListener::bind(&endpoint).expect("bind owner pipe");
	let server = tokio::spawn(async move {
		let mut stream = listener.accept().await.expect("accept typed client");
		let request = read_client_frame(&mut stream, &mut BytesMut::new())
			.await
			.expect("read hello")
			.expect("hello frame");
		assert!(matches!(request.body, Some(client_frame::Body::Hello(_))));
		write_server_frame(
			&mut stream,
			&ServerFrame {
				request_id: request.request_id,
				body: Some(server_frame::Body::Hello(ServerHello {
					server_version: "windows-test".into(),
					..ServerHello::default()
				})),
				..ServerFrame::default()
			},
			&mut BytesMut::new(),
		)
		.await
		.expect("write hello");
		let eof = read_client_frame(&mut stream, &mut BytesMut::new())
			.await
			.expect("clean disconnect");
		assert!(eof.is_none());
	});

	let (client, bridge) = connect_owner_pipe(&endpoint).expect("connect typed client");
	let hello = client
		.hello(ClientHello {
			client: "windows-test".into(),
			schema_rev: omp_proto::SCHEMA_REV,
			..ClientHello::default()
		})
		.await
		.expect("typed hello");
	assert_eq!(hello.server_version, "windows-test");
	drop(client);
	time::timeout(Duration::from_secs(2), bridge)
		.await
		.expect("client bridge exits after disconnect")
		.expect("client bridge task")
		.expect("clean client bridge");
	time::timeout(Duration::from_secs(2), server)
		.await
		.expect("server observes disconnect")
		.expect("server task");
}

#[tokio::test]
async fn unknown_frame_receives_the_same_protocol_error_as_stream_dispatch() {
	let root = tempfile::tempdir().expect("workspace");
	let state = tempfile::tempdir().expect("state");
	let con = Arc::new(omp_con::Ctx::new());
	let convars = Arc::new(omp_envd::exthost::ConvarControlFactory::new(Arc::clone(&con)));
	let server = Arc::new(
		EnvServer::open_local(
			root.path(),
			state.path(),
			Registry::new(),
			ExtHostConfig::current(Principal::new(sf!("test"), sf!("Test")), sf!("test-session"), 1)
				.expect("host config"),
			&con,
			convars,
			RegistryBridges::default(),
		)
		.await
		.expect("environment server"),
	);
	let endpoint = unique_endpoint("unknown");
	let mut listener = OwnerPipeListener::bind(&endpoint).expect("bind owner pipe");
	let connection = tokio::spawn(async move {
		let stream = listener.accept().await.expect("accept raw client");
		server.serve_io(stream).await.expect("serve raw client");
	});
	let mut client = ClientOptions::new()
		.open(&endpoint)
		.expect("connect raw client");
	write_client_frame(
		&mut client,
		&ClientFrame {
			request_id: 0,
			body: Some(client_frame::Body::Hello(ClientHello {
				client: "windows-raw".into(),
				schema_rev: omp_proto::SCHEMA_REV,
				..ClientHello::default()
			})),
			..ClientFrame::default()
		},
		&mut BytesMut::new(),
	)
	.await
	.expect("write hello");
	let hello = read_server_frame(&mut client, &mut BytesMut::new())
		.await
		.expect("read hello")
		.expect("hello response");
	assert!(matches!(hello.body, Some(server_frame::Body::Hello(_))));

	write_client_frame(
		&mut client,
		&ClientFrame { request_id: 41, body: None, ..ClientFrame::default() },
		&mut BytesMut::new(),
	)
	.await
	.expect("write unknown frame");
	let response = read_server_frame(&mut client, &mut BytesMut::new())
		.await
		.expect("read protocol error")
		.expect("protocol error response");
	assert_eq!(response.request_id, 41);
	assert!(matches!(response.body, Some(server_frame::Body::Error(_))));

	drop(client);
	time::timeout(Duration::from_secs(2), connection)
		.await
		.expect("dispatch observes disconnect")
		.expect("connection task");
}
