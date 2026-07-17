use std::{env, path::PathBuf, str::FromStr};

use anyhow::{Context, Result, bail};

pub const MOD_ALT: u32 = 0x0001;
pub const MOD_CONTROL: u32 = 0x0002;
pub const MOD_SHIFT: u32 = 0x0004;
pub const MOD_WIN: u32 = 0x0008;
pub const MOD_NOREPEAT: u32 = 0x4000;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct Hotkey {
	pub modifiers: u32,
	pub key:       u32,
}

impl Default for Hotkey {
	fn default() -> Self {
		Self { modifiers: MOD_CONTROL | MOD_ALT | MOD_NOREPEAT, key: u32::from(b'T') }
	}
}

impl FromStr for Hotkey {
	type Err = anyhow::Error;

	fn from_str(value: &str) -> Result<Self> {
		let mut modifiers = MOD_NOREPEAT;
		let mut key = None;
		for part in value
			.split('+')
			.map(str::trim)
			.filter(|part| !part.is_empty())
		{
			match part.to_ascii_lowercase().as_str() {
				"ctrl" | "control" => modifiers |= MOD_CONTROL,
				"alt" => modifiers |= MOD_ALT,
				"shift" => modifiers |= MOD_SHIFT,
				"win" | "windows" => modifiers |= MOD_WIN,
				_ if key.is_none() => {
					let mut chars = part.chars();
					let Some(ch) = chars.next() else {
						bail!("hotkey is empty")
					};
					if chars.next().is_some() || !ch.is_ascii_alphanumeric() {
						bail!("hotkey key must be one ASCII letter or digit");
					}
					key = Some(ch.to_ascii_uppercase() as u32);
				},
				_ => bail!("hotkey has more than one key"),
			}
		}
		let key = key.context("hotkey is missing a key")?;
		if modifiers == MOD_NOREPEAT {
			bail!("hotkey requires at least one modifier");
		}
		Ok(Self { modifiers, key })
	}
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum Command {
	#[default]
	Run,
	Open,
	Capture,
	Status,
	Shutdown,
	ProbeHotkey,
}

#[derive(Clone, Debug)]
pub struct Config {
	pub command:         Command,
	pub root:            PathBuf,
	pub gateway_program: PathBuf,
	pub hotkey:          Hotkey,
}

impl Config {
	pub fn parse() -> Result<Self> {
		Self::parse_from(env::args().skip(1))
	}

	pub fn parse_from(args: impl IntoIterator<Item = String>) -> Result<Self> {
		let local = env::var_os("LOCALAPPDATA").context("LOCALAPPDATA is not set")?;
		let mut config = Self {
			command:         Command::Run,
			root:            PathBuf::from(local).join("OhMyPi").join("DesktopTag"),
			gateway_program: PathBuf::from("ompk-tag"),
			hotkey:          Hotkey::default(),
		};
		for arg in args {
			if let Some(value) = arg.strip_prefix("--root=") {
				config.root = PathBuf::from(value);
			} else if let Some(value) = arg.strip_prefix("--gateway=") {
				config.gateway_program = PathBuf::from(value);
			} else if let Some(value) = arg.strip_prefix("--hotkey=") {
				config.hotkey = value.parse()?;
			} else {
				config.command = match arg.as_str() {
					"run" => Command::Run,
					"open" => Command::Open,
					"capture" => Command::Capture,
					"status" => Command::Status,
					"shutdown" => Command::Shutdown,
					"probe-hotkey" => Command::ProbeHotkey,
					_ => bail!("unknown argument: {arg}"),
				};
			}
		}
		Ok(config)
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn default_hotkey_is_non_repeating_ctrl_alt_t() {
		let key = Hotkey::default();
		assert_eq!(key.modifiers, MOD_CONTROL | MOD_ALT | MOD_NOREPEAT);
		assert_eq!(key.key, u32::from(b'T'));
	}

	#[test]
	fn parses_configurable_hotkey() {
		let key: Hotkey = "Win+Shift+7".parse().unwrap();
		assert_eq!(key.modifiers, MOD_WIN | MOD_SHIFT | MOD_NOREPEAT);
		assert_eq!(key.key, u32::from(b'7'));
	}

	#[test]
	fn rejects_bare_or_ambiguous_hotkeys() {
		assert!("T".parse::<Hotkey>().is_err());
		assert!("Ctrl+T+Y".parse::<Hotkey>().is_err());
		assert!("Ctrl+F12".parse::<Hotkey>().is_err());
	}
}
