use std::path::{Component, Path, PathBuf};

use anyhow::{Context, Result, bail};
use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GatewayReady {
	pub version:     u8,
	pub url:         String,
	pub pid:         u32,
	pub instance_id: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Bounds {
	pub x:      i32,
	pub y:      i32,
	pub width:  u32,
	pub height: u32,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisualCapture {
	pub screenshot_path: PathBuf,
	pub selected_region: Bounds,
	pub display_scale:   f64,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ForegroundApp {
	pub process_id:      u32,
	pub process_name:    Option<String>,
	pub window_title:    Option<String>,
	pub executable_path: Option<PathBuf>,
}

#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CaptureManifest {
	pub version:        u8,
	pub capture_id:     String,
	pub captured_at:    u64,
	pub mode:           String,
	pub visual:         VisualCapture,
	pub foreground_app: ForegroundApp,
}

impl CaptureManifest {
	pub fn validate(&self, capture_root: &Path) -> Result<()> {
		if self.version != 1 || self.mode != "window" {
			bail!("unsupported capture manifest");
		}
		if self.capture_id.len() < 16
			|| self.capture_id.len() > 128
			|| !self
				.capture_id
				.bytes()
				.all(|byte| byte.is_ascii_alphanumeric() || byte == b'-')
		{
			bail!("invalid capture id");
		}
		if self.visual.selected_region.width == 0 || self.visual.selected_region.height == 0 {
			bail!("capture bounds are empty");
		}
		if !(0.5..=8.0).contains(&self.visual.display_scale) {
			bail!("invalid display scale");
		}
		let relative = self
			.visual
			.screenshot_path
			.strip_prefix(capture_root)
			.context("screenshot is outside capture root")?;
		if relative
			.components()
			.any(|part| !matches!(part, Component::Normal(_)))
		{
			bail!("screenshot path is not a direct capture path");
		}
		Ok(())
	}
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct StageResponse {
	pub version:       u8,
	pub invocation_id: String,
	pub claim_token:   String,
	pub overlay_path:  String,
}

impl StageResponse {
	pub fn claim_url(&self, gateway_url: &str) -> Result<String> {
		if self.version != 1
			|| self.invocation_id.is_empty()
			|| self.claim_token.len() < 16
			|| !self.overlay_path.starts_with('/')
			|| self.overlay_path.starts_with("//")
			|| self.overlay_path.contains('#')
		{
			bail!("invalid stage response");
		}
		let gateway = gateway_url
			.strip_prefix("http://")
			.context("gateway must use HTTP loopback")?;
		let authority = gateway.split('/').next().unwrap_or_default();
		let host = authority.split(':').next().unwrap_or_default();
		if host != "127.0.0.1" && host != "localhost" && host != "[::1]" {
			bail!("gateway is not loopback");
		}
		Ok(format!(
			"{}/{}?invocation={}#claim={}",
			gateway_url.trim_end_matches('/'),
			self.overlay_path.trim_start_matches('/'),
			percent_encode(&self.invocation_id),
			percent_encode(&self.claim_token)
		))
	}
}

fn percent_encode(value: &str) -> String {
	let mut encoded = String::with_capacity(value.len());
	for byte in value.bytes() {
		if byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_' | b'.' | b'~') {
			encoded.push(char::from(byte));
		} else {
			use std::fmt::Write;
			let _ = write!(encoded, "%{byte:02X}");
		}
	}
	encoded
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ControlCommand {
	Open,
	Capture,
	Status,
	Shutdown,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlRequest {
	pub version: u8,
	pub command: ControlCommand,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ControlResponse {
	pub version: u8,
	pub ok:      bool,
	pub status:  String,
}

#[cfg(test)]
mod tests {
	use super::*;

	fn manifest(root: &Path) -> CaptureManifest {
		CaptureManifest {
			version:        1,
			capture_id:     "019f4e60-12ab-7000".into(),
			captured_at:    42,
			mode:           "window".into(),
			visual:         VisualCapture {
				screenshot_path: root.join("019f4e60-12ab-7000.png"),
				selected_region: Bounds { x: -400, y: 20, width: 300, height: 200 },
				display_scale:   1.5,
			},
			foreground_app: ForegroundApp {
				process_id:      7,
				process_name:    None,
				window_title:    Some("Editor".into()),
				executable_path: None,
			},
		}
	}

	#[test]
	fn validates_private_capture_path_and_negative_coordinates() {
		let root = Path::new(r"C:\private\captures");
		manifest(root).validate(root).unwrap();
		let mut escaped = manifest(root);
		escaped.visual.screenshot_path = root.join("..").join("stolen.png");
		assert!(escaped.validate(root).is_err());
	}

	#[test]
	fn claim_secret_is_fragment_only() {
		let response = StageResponse {
			version:       1,
			invocation_id: "abc def".into(),
			claim_token:   "0123456789abcdef".into(),
			overlay_path:  "/".into(),
		};
		let url = response.claim_url("http://127.0.0.1:4321").unwrap();
		let (request, fragment) = url.split_once('#').unwrap();
		assert!(!request.contains("0123456789abcdef"));
		assert_eq!(fragment, "claim=0123456789abcdef");
	}

	#[test]
	fn protocol_round_trips_exactly() {
		let request = ControlRequest { version: 1, command: ControlCommand::Capture };
		let json = serde_json::to_string(&request).unwrap();
		assert_eq!(json, r#"{"version":1,"command":"capture"}"#);
		assert_eq!(serde_json::from_str::<ControlRequest>(&json).unwrap(), request);
		assert!(
			serde_json::from_str::<ControlRequest>(
				r#"{"version":1,"command":"capture","token":"bad"}"#
			)
			.is_err()
		);
	}
}
