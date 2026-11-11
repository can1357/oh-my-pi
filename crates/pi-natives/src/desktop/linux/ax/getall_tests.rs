use std::os::{linux::net::SocketAddrExt, unix::net::SocketAddr};

use futures::StreamExt;
use zbus::{message::Type, zvariant::Value};

use super::*;

const TEXT: &str = "org.a11y.atspi.Text";
const PROPERTIES: &str = "org.freedesktop.DBus.Properties";
const PEER: &str = ":1.7";
const TEXT_PATH: &str = "/text";

// Handles Properties on the wire, so a GetAll is recorded whichever interface
// it names. GetAll is refused rather than crashing the way Qt 5 does.
async fn serve_app(connection: zbus::Connection) -> Vec<(String, String)> {
	let mut messages = zbus::MessageStream::from(&connection);
	let mut calls = Vec::new();
	while let Some(message) = messages.next().await {
		let message = message.unwrap();
		let header = message.header();
		if header.message_type() != Type::MethodCall {
			continue;
		}
		let interface = header.interface().unwrap().as_str();
		let member = header.member().unwrap().as_str();
		match (interface, member) {
			(PROPERTIES, "GetAll") => {
				let requested: String = message.body().deserialize().unwrap();
				calls.push((member.to_owned(), requested));
				connection
					.reply_error(&header, "org.freedesktop.DBus.Error.NotSupported", &"GetAll is unsafe")
					.await
					.unwrap();
			},
			(PROPERTIES, "Get") => {
				let (requested, property): (String, String) = message.body().deserialize().unwrap();
				assert_eq!((requested.as_str(), property.as_str()), (TEXT, "CharacterCount"));
				calls.push((member.to_owned(), format!("{requested}.{property}")));
				connection
					.reply(&header, &Value::from(12_i32))
					.await
					.unwrap();
			},
			(TEXT, "GetText") => {
				let (start, end): (i32, i32) = message.body().deserialize().unwrap();
				let result: String = "initial text"
					.chars()
					.skip(usize::try_from(start).unwrap())
					.take(usize::try_from(end - start).unwrap())
					.collect();
				connection.reply(&header, &result).await.unwrap();
			},
			("org.omp.GetAllTest", "Finish") => {
				connection.reply(&header, &()).await.unwrap();
				break;
			},
			_ => panic!("unexpected AT-SPI call: {interface}.{member}"),
		}
	}
	calls
}

#[test]
fn text_value_reads_text_without_get_all() {
	let rt = Builder::new_current_thread().enable_all().build().unwrap();
	let (text, calls) = rt.block_on(async {
		// A Linux abstract socket is isolated by a fresh GUID and disappears on
		// close. No daemon, ambient session bus, or filesystem cleanup is needed.
		let guid = zbus::Guid::generate();
		let socket = format!("omp-atspi-getall-{guid}");
		let address = SocketAddr::from_abstract_name(socket.as_bytes()).unwrap();
		let listener = std::os::unix::net::UnixListener::bind_addr(&address).unwrap();
		listener.set_nonblocking(true).unwrap();
		let listener = tokio::net::UnixListener::from_std(listener).unwrap();
		let server = tokio::spawn(async move {
			let (stream, _) = listener.accept().await.unwrap();
			let app = zbus::connection::Builder::unix_stream(stream)
				.server(guid)
				.unwrap()
				.p2p()
				.build()
				.await
				.unwrap();
			serve_app(app).await
		});
		let client = zbus::connection::Builder::address(format!("unix:abstract={socket}").as_str())
			.unwrap()
			.p2p()
			.build()
			.await
			.unwrap();
		let builder = atspi::proxy::text::TextProxy::builder(&client)
			.destination(PEER)
			.and_then(|builder| builder.path(TEXT_PATH));
		let text = text_value(builder).await;
		client
			.call_method(Some(PEER), TEXT_PATH, Some("org.omp.GetAllTest"), "Finish", &())
			.await
			.unwrap();
		(text, server.await.unwrap())
	});

	assert!(calls.iter().all(|(member, _)| member != "GetAll"), "unsafe property calls: {calls:?}");
	assert_eq!(text.as_deref(), Some("initial text"));
	assert!(calls.iter().any(
		|(member, property)| member == "Get" && property == "org.a11y.atspi.Text.CharacterCount"
	));
}
