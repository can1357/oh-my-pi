//! Environment-owned bounded workstation fact collection.

use std::{
	env, io,
	path::{Path, PathBuf},
	process::Stdio,
	str,
	sync::Arc,
	time::Duration,
};

use omp_proto::{SCHEMA_REV, env::v1 as pb};
use serde_json::{Value, json};
use tokio::{io::AsyncReadExt as _, process::Command, sync::OnceCell, time};

const MAX_FIELD_BYTES: usize = 4 * 1024;
const MAX_PROBE_BYTES: u64 = 256 * 1024;
const GPU_CACHE_SCHEMA_VERSION: u64 = 1;
#[cfg(any(target_os = "linux", windows, test))]
const MAX_GPUS: usize = 16;
const QUICK_PROBE_TIMEOUT: Duration = Duration::from_secs(1);
#[cfg(any(target_os = "linux", windows))]
const GPU_PROBE_TIMEOUT: Duration = Duration::from_millis(4_500);

/// Cached Environment authority for bounded workstation facts.
pub(crate) struct HostInfoHost {
	gpu_cache_path: PathBuf,
	gpus:           OnceCell<Arc<[String]>>,
}

impl HostInfoHost {
	/// Creates a host-info authority whose null-inclusive GPU cache is stored in
	/// Environment state rather than the project tree.
	pub(crate) fn new(state_dir: &Path) -> Self {
		Self { gpu_cache_path: state_dir.join("host-info.json"), gpus: OnceCell::new() }
	}

	/// Captures one bounded host snapshot. Probing and environment reads remain
	/// on this side of the Environment wire boundary.
	pub(crate) async fn snapshot(&self, max_field_bytes: u32) -> pb::HostInfo {
		let (release, version, cpu, gpus) = tokio::join!(
			uname("-r"),
			uname("-v"),
			cpu_model(),
			self.gpus.get_or_init(|| self.load_or_probe_gpus()),
		);
		let platform = platform_name();
		let release = release.as_deref().unwrap_or("unknown");
		let os = format!("{platform} {release}");
		let kernel = kernel_identity(version.as_deref(), os_type(), release);
		let limit = usize::try_from(max_field_bytes)
			.unwrap_or(usize::MAX)
			.min(MAX_FIELD_BYTES);

		pb::HostInfo {
			wire_revision: SCHEMA_REV,
			os:            bound_field(&os, limit),
			kernel:        bound_field(&kernel, limit),
			architecture:  bound_field(architecture_name(), limit),
			cpu:           cpu
				.as_deref()
				.map_or_else(String::new, |value| bound_field(value, limit)),
			gpus:          gpus.iter().map(|value| bound_field(value, limit)).collect(),
			terminal:      terminal_name()
				.map_or_else(String::new, |value| bound_field(&value, limit)),
		}
	}

	async fn load_or_probe_gpus(&self) -> Arc<[String]> {
		if let Some(gpus) = load_gpu_cache(&self.gpu_cache_path).await {
			return gpus;
		}
		let gpus: Arc<[String]> = probe_gpus().await.into();
		let _ = save_gpu_cache(&self.gpu_cache_path, &gpus).await;
		gpus
	}
}

async fn uname(argument: &str) -> Option<String> {
	#[cfg(unix)]
	{
		run_probe("uname", &[argument], QUICK_PROBE_TIMEOUT).await
	}
	#[cfg(not(unix))]
	{
		let _ = argument;
		None
	}
}

async fn cpu_model() -> Option<String> {
	#[cfg(any(target_os = "linux", target_os = "android"))]
	{
		let file = tokio::fs::File::open("/proc/cpuinfo").await.ok()?;
		let mut bytes = Vec::new();
		file
			.take(MAX_PROBE_BYTES)
			.read_to_end(&mut bytes)
			.await
			.ok()?;
		return parse_linux_cpu(str::from_utf8(&bytes).ok()?);
	}
	#[cfg(target_os = "macos")]
	{
		return run_probe("sysctl", &["-n", "machdep.cpu.brand_string"], QUICK_PROBE_TIMEOUT).await;
	}
	#[cfg(windows)]
	{
		let output = run_probe("wmic", &["cpu", "get", "name"], QUICK_PROBE_TIMEOUT).await?;
		return parse_wmic_table(&output, "Name").into_iter().next();
	}
	#[allow(unreachable_code, reason = "cfg branches return on supported desktop targets")]
	None
}

async fn probe_gpus() -> Vec<String> {
	#[cfg(windows)]
	{
		return run_probe(
			"wmic",
			&["path", "win32_VideoController", "get", "name"],
			GPU_PROBE_TIMEOUT,
		)
		.await
		.map_or_else(Vec::new, |output| parse_windows_gpus(&output));
	}
	#[cfg(target_os = "linux")]
	{
		return run_probe("lspci", &[], GPU_PROBE_TIMEOUT)
			.await
			.map_or_else(Vec::new, |output| rank_linux_gpus(&output));
	}
	#[allow(unreachable_code, reason = "cfg branches return on probed targets")]
	Vec::new()
}

async fn run_probe(command: &str, arguments: &[&str], timeout: Duration) -> Option<String> {
	let mut child = Command::new(command)
		.args(arguments)
		.stdin(Stdio::null())
		.stdout(Stdio::piped())
		.stderr(Stdio::null())
		.kill_on_drop(true)
		.spawn()
		.ok()?;
	let stdout = child.stdout.take()?;
	let mut limited = stdout.take(MAX_PROBE_BYTES);
	let mut bytes = Vec::new();
	let completed = time::timeout(timeout, async {
		let (read, status) = tokio::join!(limited.read_to_end(&mut bytes), child.wait());
		(read, status)
	})
	.await;
	let Ok((Ok(_), Ok(status))) = completed else {
		let _ = child.kill().await;
		let _ = child.wait().await;
		return None;
	};
	if !status.success() {
		return None;
	}
	let output = String::from_utf8(bytes).ok()?;
	let output = output.trim();
	(!output.is_empty()).then(|| output.to_owned())
}

#[cfg(any(target_os = "linux", target_os = "android", test))]
fn parse_linux_cpu(cpuinfo: &str) -> Option<String> {
	let mut hardware = None;
	let mut processor = None;
	for line in cpuinfo.lines() {
		let Some((key, value)) = line.split_once(':') else {
			continue;
		};
		let value = value.trim();
		if value.is_empty() {
			continue;
		}
		match key.trim() {
			"model name" => return Some(value.to_owned()),
			"Hardware" if cfg!(target_os = "android") => {
				hardware.get_or_insert(value);
			},
			"Processor" if cfg!(target_os = "android") => {
				processor.get_or_insert(value);
			},
			_ => {},
		};
	}
	if cfg!(target_os = "android") {
		hardware.or(processor).map(str::to_owned)
	} else {
		None
	}
}

#[cfg(any(windows, test))]
fn parse_wmic_table(output: &str, header: &str) -> Vec<String> {
	output
		.lines()
		.map(str::trim)
		.filter(|line| !line.is_empty() && !line.eq_ignore_ascii_case(header))
		.map(str::to_owned)
		.collect()
}

#[cfg(any(windows, test))]
fn parse_windows_gpus(output: &str) -> Vec<String> {
	let adapters = parse_wmic_table(output, "Name");
	let mut preferred = Vec::with_capacity(adapters.len());
	let mut physical = Vec::with_capacity(adapters.len());
	for adapter in &adapters {
		let lower = adapter.to_ascii_lowercase();
		if ["virtual", "mirror", "remote", "citrix"]
			.iter()
			.any(|needle| lower.contains(needle))
		{
			continue;
		}
		if ["nvidia", "amd", "radeon", "intel"]
			.iter()
			.any(|vendor| lower.contains(vendor))
		{
			preferred.push(adapter.clone());
		} else {
			physical.push(adapter.clone());
		}
	}
	preferred.extend(physical);
	if preferred.is_empty() {
		preferred.extend(adapters.into_iter().take(1));
	}
	preferred.truncate(MAX_GPUS);
	preferred
}

#[cfg(any(target_os = "linux", test))]
fn rank_linux_gpus(output: &str) -> Vec<String> {
	let mut gpus = output
		.lines()
		.filter(|line| {
			let lower = line.to_ascii_lowercase();
			lower.contains("vga") || lower.contains("3d controller") || lower.contains("display")
		})
		.filter_map(|line| {
			let name = line.rsplit_once(": ").map_or(line, |(_, name)| name).trim();
			let lower = name.to_ascii_lowercase();
			if lower.contains("aspeed") || lower.contains("matrox g200") || lower.contains("mgag200") {
				return None;
			}
			let priority = if ["nvidia", "geforce", "quadro", "rtx", "amd", "radeon", "rx "]
				.iter()
				.any(|needle| lower.contains(needle))
			{
				3
			} else if lower.contains("intel") {
				1
			} else {
				2
			};
			Some((priority, name.to_owned()))
		})
		.collect::<Vec<_>>();
	gpus.sort_by(|(left_priority, left), (right_priority, right)| {
		right_priority
			.cmp(left_priority)
			.then_with(|| left.cmp(right))
	});
	gpus.truncate(MAX_GPUS);
	gpus.into_iter().map(|(_, name)| name).collect()
}

async fn load_gpu_cache(path: &Path) -> Option<Arc<[String]>> {
	let bytes = tokio::fs::read(path).await.ok()?;
	let value: Value = serde_json::from_slice(&bytes).ok()?;
	if value.as_object()?.get("version")?.as_u64()? != GPU_CACHE_SCHEMA_VERSION {
		return None;
	}
	let gpus = value.as_object()?.get("gpus")?;
	if gpus.is_null() {
		return Some(Arc::from([]));
	}
	let values = gpus.as_array()?;
	let mut parsed = Vec::with_capacity(values.len());
	for value in values {
		parsed.push(value.as_str()?.to_owned());
	}
	Some(parsed.into())
}

async fn save_gpu_cache(path: &Path, gpus: &[String]) -> io::Result<()> {
	let value = if gpus.is_empty() {
		json!({ "version": GPU_CACHE_SCHEMA_VERSION, "gpus": null })
	} else {
		json!({ "version": GPU_CACHE_SCHEMA_VERSION, "gpus": gpus })
	};
	let bytes = serde_json::to_vec_pretty(&value).expect("GPU cache value is serializable");
	tokio::fs::write(path, bytes).await
}

fn kernel_identity(version: Option<&str>, system: &str, release: &str) -> String {
	match version.map(str::trim) {
		Some(version) if !version.is_empty() && !version.eq_ignore_ascii_case("unknown") => {
			version.to_owned()
		},
		_ => format!("{system} {release}").trim().to_owned(),
	}
}

#[cfg(target_os = "macos")]
fn platform_name() -> &'static str {
	"darwin"
}

#[cfg(target_os = "windows")]
fn platform_name() -> &'static str {
	"win32"
}

#[cfg(not(any(target_os = "macos", target_os = "windows")))]
fn platform_name() -> &'static str {
	env::consts::OS
}

#[cfg(target_os = "macos")]
fn os_type() -> &'static str {
	"Darwin"
}

#[cfg(target_os = "windows")]
fn os_type() -> &'static str {
	"Windows_NT"
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn os_type() -> &'static str {
	"Linux"
}

#[cfg(not(any(
	target_os = "macos",
	target_os = "windows",
	target_os = "linux",
	target_os = "android"
)))]
fn os_type() -> &'static str {
	env::consts::OS
}

#[cfg(target_arch = "aarch64")]
fn architecture_name() -> &'static str {
	"arm64"
}

#[cfg(target_arch = "x86_64")]
fn architecture_name() -> &'static str {
	"x64"
}

#[cfg(not(any(target_arch = "aarch64", target_arch = "x86_64")))]
fn architecture_name() -> &'static str {
	env::consts::ARCH
}

fn terminal_name() -> Option<String> {
	if let Some(program) = nonempty_env("TERM_PROGRAM") {
		return Some(match nonempty_env("TERM_PROGRAM_VERSION") {
			Some(version) => format!("{program} {version}"),
			None => program,
		});
	}
	if nonempty_env("WT_SESSION").is_some() {
		return Some("Windows Terminal".to_owned());
	}
	["TERM", "COLORTERM", "TERMINAL_EMULATOR"]
		.into_iter()
		.find_map(nonempty_env)
}

fn nonempty_env(name: &str) -> Option<String> {
	env::var(name)
		.ok()
		.map(|value| value.trim().to_owned())
		.filter(|value| !value.is_empty())
}

fn bound_field(value: &str, maximum: usize) -> String {
	let mut sanitized = String::with_capacity(value.len().min(maximum));
	let mut previous_space = false;
	for character in value.chars() {
		let character = if character.is_control() || character.is_whitespace() {
			' '
		} else {
			character
		};
		if character == ' ' && previous_space {
			continue;
		}
		if sanitized.len().saturating_add(character.len_utf8()) > maximum {
			break;
		}
		sanitized.push(character);
		previous_space = character == ' ';
	}
	sanitized.trim().to_owned()
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn host_info_fallback_and_parser_table() {
		let kernels = [
			(Some("Darwin Kernel Version 25.0"), "Darwin", "25.0", "Darwin Kernel Version 25.0"),
			(Some("unknown"), "Darwin", "25.0", "Darwin 25.0"),
			(Some("  "), "Linux", "6.12", "Linux 6.12"),
			(None, "Windows_NT", "10", "Windows_NT 10"),
		];
		for (version, system, release, expected) in kernels {
			assert_eq!(kernel_identity(version, system, release), expected);
		}
		assert_eq!(
			parse_linux_cpu("processor: 0\nmodel name : Example CPU 9000\nprocessor: 1\n"),
			Some("Example CPU 9000".to_owned())
		);
		let ranked = rank_linux_gpus(
			"00:02.0 VGA compatible controller: Intel UHD\n01:00.0 3D controller: NVIDIA RTX \
			 6000\n02:00.0 VGA compatible controller: ASPEED Graphics\n",
		);
		assert_eq!(ranked, ["NVIDIA RTX 6000", "Intel UHD"]);
		assert_eq!(
			parse_windows_gpus(
				"Name\nGameViewer Virtual Display Adapter\nGeneric Physical Adapter\nIntel Arc \
				 A770\nNVIDIA GeForce RTX 5090\nCitrix Mirror Adapter\n"
			),
			["Intel Arc A770", "NVIDIA GeForce RTX 5090", "Generic Physical Adapter"]
		);
		assert_eq!(parse_windows_gpus("Name\nRemote Display Adapter\nCitrix Virtual Adapter\n"), [
			"Remote Display Adapter"
		]);
		assert_eq!(bound_field("abc\0  def", 7), "abc def");
	}

	#[tokio::test]
	async fn null_gpu_cache_is_a_stable_cached_fact() {
		let directory = tempfile::tempdir().expect("cache directory");
		let path = directory.path().join("host-info.json");
		save_gpu_cache(&path, &[]).await.expect("save null cache");
		assert!(
			load_gpu_cache(&path)
				.await
				.expect("load null cache")
				.is_empty()
		);
		let value: Value =
			serde_json::from_slice(&tokio::fs::read(path).await.expect("read cache")).unwrap();
		assert!(value["gpus"].is_null());
		assert_eq!(value["version"], GPU_CACHE_SCHEMA_VERSION);
	}

	#[tokio::test]
	async fn legacy_and_mismatched_gpu_cache_versions_are_rejected() {
		let directory = tempfile::tempdir().expect("cache directory");
		let path = directory.path().join("host-info.json");
		for value in [
			json!({ "gpus": ["GameViewer Virtual Display Adapter"] }),
			json!({ "version": GPU_CACHE_SCHEMA_VERSION + 1, "gpus": ["NVIDIA RTX"] }),
		] {
			tokio::fs::write(&path, serde_json::to_vec(&value).unwrap())
				.await
				.expect("write stale cache");
			assert!(load_gpu_cache(&path).await.is_none());
		}
	}
}
