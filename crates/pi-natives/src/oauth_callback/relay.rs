#![cfg_attr(windows, windows_subsystem = "windows")]

mod publication;

use std::{env, ffi::OsString, path::PathBuf, process::ExitCode};

const EX_USAGE: u8 = 64;
const EX_DATAERR: u8 = 65;
const EX_CANTCREAT: u8 = 73;

fn main() -> ExitCode {
	match run(env::args_os()) {
		Ok(()) => ExitCode::SUCCESS,
		Err(Failure::Usage) => {
			eprintln!("usage: oauth-callback-relay CALLBACK_PATH CALLBACK_URL");
			ExitCode::from(EX_USAGE)
		},
		Err(Failure::InvalidUrlEncoding) => {
			eprintln!("callback URL is not valid UTF-8");
			ExitCode::from(EX_DATAERR)
		},
		Err(Failure::Publish(error)) => {
			eprintln!("could not publish OAuth callback: {error}");
			ExitCode::from(EX_CANTCREAT)
		},
	}
}

fn run(arguments: impl IntoIterator<Item = OsString>) -> Result<(), Failure> {
	let mut arguments = arguments.into_iter();
	let _program = arguments.next().ok_or(Failure::Usage)?;
	let callback_path = arguments.next().ok_or(Failure::Usage)?;
	let callback_url = arguments.next().ok_or(Failure::Usage)?;
	if arguments.next().is_some() {
		return Err(Failure::Usage);
	}
	let callback_url = callback_url
		.into_string()
		.map_err(|_| Failure::InvalidUrlEncoding)?;
	publication::publish_once(&PathBuf::from(callback_path), callback_url.as_bytes())
		.map_err(Failure::Publish)
}

#[derive(Debug)]
enum Failure {
	Usage,
	InvalidUrlEncoding,
	Publish(std::io::Error),
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn requires_exactly_two_operands() {
		for arguments in [
			vec![OsString::from("relay")],
			vec![OsString::from("relay"), OsString::from("callback.url")],
			vec![
				OsString::from("relay"),
				OsString::from("callback.url"),
				OsString::from("omp://callback"),
				OsString::from("extra"),
			],
		] {
			assert!(matches!(run(arguments), Err(Failure::Usage)));
		}
	}
}
