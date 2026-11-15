use std::{
	io::{Read, Write},
	sync::Arc,
};

use agy_transport::{
	CLIENT_HELLO, CLIENT_PROFILE, Result,
	bridge::{self, Bridge},
	serialize::CcpaSerializer,
	transport::Transport,
};
use http::HeaderValue;
use rand::RngCore;
use serde::{Deserialize, Serialize};
use tokio::net::TcpListener;
use tokio_util::sync::CancellationToken;

#[derive(Default)]
struct Flags {
	serialize:     bool,
	client_hello:  Option<String>,
	ca:            Option<String>,
	user_agent:    Option<String>,
	quota_project: Option<String>,
}

fn flags() -> Result<Option<Flags>> {
	let mut flags = Flags::default();
	let mut arguments = std::env::args().skip(1);
	while let Some(argument) = arguments.next() {
		if argument == "--" || !argument.starts_with('-') {
			break;
		}
		if matches!(argument.as_str(), "--help" | "-help" | "-h") {
			eprintln!(
				"agy-transport [--serialize] [--client-hello measured-record] [--ca PEM-or-path] \
				 [--user-agent value] [--quota-project project]\n\n--serialize reads one CCPA JSON \
				 value and emits descriptor-defined protobuf JSON.\nThe bridge listens only on \
				 127.0.0.1 and exits when its stdin pipe closes."
			);
			return Ok(None);
		}
		let option = argument.trim_start_matches('-');
		let (name, inline) = option
			.split_once('=')
			.map_or((option, None), |(name, value)| (name, Some(value)));
		if name == "serialize" {
			flags.serialize = match inline.unwrap_or("true") {
				"1" | "t" | "T" | "true" | "TRUE" | "True" => true,
				"0" | "f" | "F" | "false" | "FALSE" | "False" => false,
				value => return Err(format!("invalid value {value:?} for --serialize").into()),
			};
			continue;
		}
		let slot = match name {
			"client-hello" => &mut flags.client_hello,
			"ca" => &mut flags.ca,
			"user-agent" => &mut flags.user_agent,
			"quota-project" => &mut flags.quota_project,
			_ => return Err(format!("flag provided but not defined: -{name}").into()),
		};
		*slot = Some(match inline {
			Some(value) => value.to_owned(),
			None => arguments
				.next()
				.ok_or_else(|| format!("flag needs an argument: -{name}"))?,
		});
	}
	Ok(Some(flags))
}

fn default_user_agent() -> Result<String> {
	#[derive(Deserialize)]
	struct Profile {
		version:    String,
		changelist: String,
	}
	let profile: Profile = serde_json::from_str(CLIENT_PROFILE)?;
	let os = if cfg!(target_os = "macos") {
		"darwin"
	} else {
		std::env::consts::OS
	};
	let arch = match std::env::consts::ARCH {
		"x86_64" => "amd64",
		"x86" => "386",
		"aarch64" => "arm64",
		arch => arch,
	};
	Ok(format!(
		"antigravity/cli/{} (aidev_client; os_type={os}; arch={arch}; cl={}; auth_method=consumer)",
		profile.version, profile.changelist
	))
}

fn main() {
	if let Err(error) = run() {
		eprintln!("{error}");
		std::process::exit(1);
	}
}

fn run() -> Result<()> {
	let Some(flags) = flags()? else {
		return Ok(());
	};
	let serializer = CcpaSerializer::new()?;
	if flags.serialize {
		let mut input = Vec::new();
		std::io::stdin().lock().read_to_end(&mut input)?;
		std::io::stdout()
			.lock()
			.write_all(&serializer.marshal(&input)?)?;
		return Ok(());
	}
	let override_hello = flags
		.client_hello
		.filter(|value| !value.is_empty())
		.map(std::fs::read)
		.transpose()?;
	let hello = override_hello.as_deref().unwrap_or(CLIENT_HELLO);
	// The Bun wrapper passes NODE_EXTRA_CA_CERTS as --ca. Preserve that behavior
	// for direct invocation too, while explicit --ca always takes precedence.
	let ca = flags
		.ca
		.or_else(|| std::env::var("NODE_EXTRA_CA_CERTS").ok());
	let transport = Transport::new(hello, ca.as_deref())?;
	let mut secret = [0_u8; 32];
	rand::rngs::OsRng.try_fill_bytes(&mut secret)?;
	let mut token = String::with_capacity(64);
	use std::fmt::Write as _;
	for byte in secret {
		write!(token, "{byte:02x}")?;
	}
	let bridge = Arc::new(Bridge {
		token,
		transport,
		serializer,
		user_agent: HeaderValue::from_str(&flags.user_agent.map_or_else(default_user_agent, Ok)?)?,
		quota_project: flags
			.quota_project
			.filter(|value| !value.is_empty())
			.map(|value| HeaderValue::from_str(&value))
			.transpose()?,
	});
	let runtime = tokio::runtime::Builder::new_multi_thread()
		.enable_all()
		.build()?;
	runtime.block_on(async move {
		let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0)).await?;
		#[derive(Serialize)]
		struct Handshake<'a> {
			port:  u16,
			token: &'a str,
		}
		{
			let mut stdout = std::io::stdout().lock();
			serde_json::to_writer(&mut stdout, &Handshake {
				port:  listener.local_addr()?.port(),
				token: &bridge.token,
			})?;
			stdout.write_all(b"\n")?;
			stdout.flush()?;
		}
		let shutdown = CancellationToken::new();
		let input_closed = shutdown.clone();
		// A normal OS thread avoids Tokio's non-cancellable stdin task keeping
		// runtime shutdown alive after the bridge has stopped.
		std::thread::spawn(move || {
			let _ = std::io::copy(&mut std::io::stdin().lock(), &mut std::io::sink());
			input_closed.cancel();
		});
		bridge::serve(listener, bridge, shutdown).await
	})
}
