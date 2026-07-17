use std::{
	fs,
	io::{BufRead, BufReader, Read, Write},
	net::TcpStream,
	path::{Path, PathBuf},
	process::{Child, Command, Stdio},
	sync::{
		Arc, Mutex,
		atomic::{AtomicBool, Ordering},
	},
	thread,
	time::{Duration, Instant},
};

use anyhow::{Context, Result, bail};
use windows_sys::Win32::{
	Security::Cryptography::{BCRYPT_USE_SYSTEM_PREFERRED_RNG, BCryptGenRandom},
	UI::{Shell::ShellExecuteW, WindowsAndMessaging::SW_SHOWNORMAL},
};

use super::wide;
use crate::{
	backoff::RestartBackoff,
	protocol::{CaptureManifest, GatewayReady, StageResponse},
};

const READINESS_TIMEOUT: Duration = Duration::from_secs(15);
const HEALTHY_RESET: Duration = Duration::from_secs(60);
const MAX_HTTP_RESPONSE: u64 = 1024 * 1024;

#[derive(Clone, Debug, Default)]
pub struct GatewayState {
	pub ready:  Option<GatewayReady>,
	pub status: String,
}

pub struct GatewaySupervisor {
	state:      Arc<Mutex<GatewayState>>,
	stopped:    Arc<AtomicBool>,
	thread:     Option<thread::JoinHandle<()>>,
	token_file: PathBuf,
}

impl GatewaySupervisor {
	pub fn start(program: PathBuf, root: &Path) -> Result<Self> {
		fs::create_dir_all(root)?;
		let token_file = root.join("control.token");
		if !token_file.exists() {
			write_control_token(&token_file)?;
		}
		let capture_root = root.join("captures");
		fs::create_dir_all(&capture_root)?;
		let state =
			Arc::new(Mutex::new(GatewayState { ready: None, status: "gateway starting".into() }));
		let stopped = Arc::new(AtomicBool::new(false));
		let thread_state = Arc::clone(&state);
		let thread_stopped = Arc::clone(&stopped);
		let thread_token = token_file.clone();
		let thread = thread::Builder::new()
			.name("desktop-tag-gateway".into())
			.spawn(move || {
				supervise(program, thread_token, capture_root, thread_state, thread_stopped)
			})?;
		Ok(Self { state, stopped, thread: Some(thread), token_file })
	}

	pub fn state(&self) -> GatewayState {
		self
			.state
			.lock()
			.unwrap_or_else(|value| value.into_inner())
			.clone()
	}

	pub fn stage(&self, manifest: &CaptureManifest) -> Result<String> {
		let ready = self.state().ready.context("gateway is not ready")?;
		let token = fs::read_to_string(&self.token_file)?.trim().to_owned();
		let response = stage_request(&ready.url, &token, manifest)?;
		response.claim_url(&ready.url)
	}

	pub fn open_overlay(&self) -> Result<()> {
		let ready = self.state().ready.context("gateway is not ready")?;
		launch_url(&ready.url)
	}
}

impl Drop for GatewaySupervisor {
	fn drop(&mut self) {
		self.stopped.store(true, Ordering::Release);
		if let Some(thread) = self.thread.take() {
			let _ = thread.join();
		}
	}
}

fn supervise(
	program: PathBuf,
	token_file: PathBuf,
	capture_root: PathBuf,
	state: Arc<Mutex<GatewayState>>,
	stopped: Arc<AtomicBool>,
) {
	let mut backoff = RestartBackoff::default();
	while !stopped.load(Ordering::Acquire) {
		set_state(&state, None, "gateway launching");
		match spawn_gateway(&program, &token_file, &capture_root) {
			Ok((mut child, ready)) => {
				let started = Instant::now();
				set_state(&state, Some(ready), "gateway ready");
				while !stopped.load(Ordering::Acquire) {
					match child.try_wait() {
						Ok(Some(status)) => {
							set_state(&state, None, &format!("gateway exited: {status}"));
							break;
						},
						Ok(None) => thread::sleep(Duration::from_millis(250)),
						Err(error) => {
							set_state(&state, None, &format!("gateway status failed: {error}"));
							break;
						},
					}
				}
				if stopped.load(Ordering::Acquire) {
					let _ = child.kill();
					let _ = child.wait();
					return;
				}
				if started.elapsed() >= HEALTHY_RESET {
					backoff.reset();
				}
			},
			Err(error) => set_state(&state, None, &format!("gateway launch failed: {error:#}")),
		}
		let delay = backoff.next_delay();
		let until = Instant::now() + delay;
		while !stopped.load(Ordering::Acquire) && Instant::now() < until {
			thread::sleep(Duration::from_millis(100));
		}
	}
}

fn spawn_gateway(
	program: &Path,
	token_file: &Path,
	capture_root: &Path,
) -> Result<(Child, GatewayReady)> {
	let mut child = Command::new(program)
		.arg("--port=0")
		.arg("--ready-json")
		.arg(format!("--control-token-file={}", token_file.display()))
		.arg(format!("--capture-root={}", capture_root.display()))
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::null())
		.spawn()
		.with_context(|| format!("start {}", program.display()))?;
	let stdout = child
		.stdout
		.take()
		.context("gateway stdout was not piped")?;
	let (sender, receiver) = std::sync::mpsc::sync_channel(1);
	thread::spawn(move || {
		let mut line = String::new();
		let result = BufReader::new(stdout).read_line(&mut line).map(|_| line);
		let _ = sender.send(result);
	});
	let line = match receiver.recv_timeout(READINESS_TIMEOUT) {
		Ok(result) => result?,
		Err(_) => {
			let _ = child.kill();
			let _ = child.wait();
			bail!("gateway readiness timed out");
		},
	};
	let ready: GatewayReady =
		serde_json::from_str(line.trim()).context("invalid gateway readiness JSON")?;
	validate_ready(&ready, child.id())?;
	Ok((child, ready))
}

fn validate_ready(ready: &GatewayReady, child_pid: u32) -> Result<()> {
	if ready.version != 1 || ready.pid != child_pid || ready.instance_id.is_empty() {
		bail!("gateway readiness identity mismatch");
	}
	let (_, authority, _) = split_http_url(&ready.url)?;
	let host = authority.split(':').next().unwrap_or_default();
	if host != "127.0.0.1" && host != "localhost" && host != "[::1]" {
		bail!("gateway readiness URL is not loopback");
	}
	Ok(())
}

fn set_state(state: &Mutex<GatewayState>, ready: Option<GatewayReady>, status: &str) {
	*state.lock().unwrap_or_else(|value| value.into_inner()) =
		GatewayState { ready, status: status.into() };
}

fn write_control_token(path: &Path) -> Result<()> {
	let mut bytes = [0_u8; 32];
	let status = unsafe {
		BCryptGenRandom(
			std::ptr::null_mut(),
			bytes.as_mut_ptr(),
			bytes.len() as u32,
			BCRYPT_USE_SYSTEM_PREFERRED_RNG,
		)
	};
	if status < 0 {
		bail!("secure token generation failed: {status}");
	}
	let mut token = String::with_capacity(64);
	for byte in bytes {
		use std::fmt::Write;
		let _ = write!(token, "{byte:02x}");
	}
	let temporary = path.with_extension("tmp");
	fs::write(&temporary, token)?;
	fs::rename(temporary, path)?;
	Ok(())
}

fn stage_request(url: &str, token: &str, manifest: &CaptureManifest) -> Result<StageResponse> {
	if token.len() != 64 || !token.bytes().all(|byte| byte.is_ascii_hexdigit()) {
		bail!("invalid private control token");
	}
	let (_, authority, _) = split_http_url(url)?;
	let body = serde_json::to_vec(manifest)?;
	let mut stream = TcpStream::connect(authority).context("connect to Desktop Tag gateway")?;
	stream.set_read_timeout(Some(Duration::from_secs(15)))?;
	stream.set_write_timeout(Some(Duration::from_secs(15)))?;
	write!(
		stream,
		"POST /api/native/invocations HTTP/1.1\r\nHost: {authority}\r\nAuthorization: Bearer \
		 {token}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: \
		 close\r\n\r\n",
		body.len()
	)?;
	stream.write_all(&body)?;
	let mut response = Vec::new();
	stream.take(MAX_HTTP_RESPONSE).read_to_end(&mut response)?;
	let split = response
		.windows(4)
		.position(|window| window == b"\r\n\r\n")
		.context("invalid gateway HTTP response")?;
	let headers = std::str::from_utf8(&response[..split])?;
	let status = headers.lines().next().unwrap_or_default();
	if !status.contains(" 200 ") && !status.contains(" 201 ") {
		bail!("gateway staging rejected request: {status}");
	}
	serde_json::from_slice(&response[split + 4..]).context("invalid gateway stage response")
}

fn split_http_url(url: &str) -> Result<(&str, &str, &str)> {
	let rest = url
		.strip_prefix("http://")
		.context("gateway URL must use HTTP")?;
	let (authority, path) = rest.split_once('/').unwrap_or((rest, ""));
	if authority.is_empty() || authority.contains('@') {
		bail!("invalid gateway authority");
	}
	Ok(("http", authority, path))
}

pub fn launch_url(url: &str) -> Result<()> {
	let verb = wide("open");
	let target = wide(url);
	let result = unsafe {
		ShellExecuteW(
			std::ptr::null_mut(),
			verb.as_ptr(),
			target.as_ptr(),
			std::ptr::null(),
			std::ptr::null(),
			SW_SHOWNORMAL,
		)
	};
	if result as isize <= 32 {
		bail!("default browser launch failed: {}", result as isize);
	}
	Ok(())
}
