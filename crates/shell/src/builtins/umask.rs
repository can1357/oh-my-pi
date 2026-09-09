#[cfg(any(target_os = "linux", target_os = "android"))]
use std::fs;
use std::io::Write;

use clap::Parser;
use nix::sys::stat;

use crate::{
	Error, ErrorKind, ExecutionContext, ExecutionResult, ShellExtensions, builtins, int_utils::parse,
};

/// Manage the process umask.
#[derive(Parser)]
pub(crate) struct UmaskCommand {
	/// If MODE is omitted, output in a form that may be reused as input.
	#[arg(short = 'p')]
	print_roundtrippable: bool,

	/// Makes the output symbolic; otherwise an octal number is given.
	#[arg(short = 'S')]
	symbolic_output: bool,

	/// Mode mask.
	mode: Option<String>,
}

impl builtins::Command for UmaskCommand {
	type Error = Error;

	async fn execute<SE: ShellExtensions>(
		&self,
		context: ExecutionContext<'_, SE>,
	) -> Result<ExecutionResult, Self::Error> {
		let protected = context.params.protect_host_process();
		if let Some(mode) = &self.mode {
			if mode.starts_with(|c: char| c.is_digit(8)) {
				let parsed = parse(mode.as_str(), 8)?;
				if protected {
					context.shell.set_virtual_umask(u32::from(parsed));
				} else {
					set_umask(parsed)?;
				}
			} else {
				let current_umask = if protected {
					context.shell.virtual_umask()
				} else {
					get_umask()?
				};
				let parsed = parse_symbolic_umask(mode, current_umask)?;
				if protected {
					context.shell.set_virtual_umask(u32::from(parsed));
				} else {
					set_umask(parsed)?;
				}
			}
		} else {
			let umask = if protected {
				context.shell.virtual_umask()
			} else {
				get_umask()?
			};

			let formatted = if self.symbolic_output {
				let u = symbolic_mask_from_bits((!umask & 0o700) >> 6);
				let g = symbolic_mask_from_bits((!umask & 0o070) >> 3);
				let o = symbolic_mask_from_bits(!umask & 0o007);
				std::format!("u={u},g={g},o={o}")
			} else {
				std::format!("{umask:04o}")
			};

			if self.print_roundtrippable {
				writeln!(context.stdout(), "umask {formatted}")?;
			} else {
				writeln!(context.stdout(), "{formatted}")?;
			}
		}

		Ok(ExecutionResult::success())
	}
}

#[cfg(any(target_os = "linux", target_os = "android"))]
fn get_umask() -> Result<u32, Error> {
	let status = fs::read_to_string("/proc/self/status")?;
	status
		.lines()
		.find_map(|line| line.strip_prefix("Umask:"))
		.and_then(|value| u32::from_str_radix(value.trim(), 8).ok())
		.ok_or_else(|| ErrorKind::InvalidUmask.into())
}

#[cfg(not(any(target_os = "linux", target_os = "android")))]
#[expect(
	clippy::unnecessary_wraps,
	reason = "platform-specific implementations share a fallible API"
)]
fn get_umask() -> Result<u32, Error> {
	let u = stat::umask(stat::Mode::empty());
	stat::umask(u);
	Ok(u32::from(u.bits()))
}

fn parse_symbolic_umask(mode: &str, current_umask: u32) -> Result<stat::mode_t, Error> {
	let mut umask = current_umask & 0o777;
	let mut chars = mode.chars().peekable();
	let mut saw_clause = false;

	while chars.peek().is_some() {
		saw_clause = true;

		let mut who_bits = 0;
		while let Some(&ch) = chars.peek() {
			let bits = match ch {
				'u' => 0o700,
				'g' => 0o070,
				'o' => 0o007,
				'a' => 0o777,
				_ => break,
			};
			who_bits |= bits;
			chars.next();
		}
		if who_bits == 0 {
			who_bits = 0o777;
		}

		loop {
			let op = chars.next().ok_or(ErrorKind::InvalidUmask)?;
			if !matches!(op, '+' | '-' | '=') {
				return Err(ErrorKind::InvalidUmask.into());
			}

			let mut perm_bits = 0;
			while let Some(&ch) = chars.peek() {
				let bits = match ch {
					'r' => 0o444,
					'w' => 0o222,
					'x' => 0o111,
					'+' | '-' | '=' | ',' => break,
					_ => return Err(ErrorKind::InvalidUmask.into()),
				};
				perm_bits |= bits & who_bits;
				chars.next();
			}

			match op {
				'+' => umask &= !perm_bits,
				'-' => umask |= perm_bits,
				'=' => {
					umask |= who_bits;
					umask &= !perm_bits;
				},
				_ => unreachable!(),
			}

			match chars.peek() {
				Some(',') => {
					chars.next();
					if chars.peek().is_none() {
						return Err(ErrorKind::InvalidUmask.into());
					}
					break;
				},
				Some('+' | '-' | '=') => continue,
				Some(_) => return Err(ErrorKind::InvalidUmask.into()),
				None => break,
			}
		}
	}

	if saw_clause {
		Ok(umask as stat::mode_t)
	} else {
		Err(ErrorKind::InvalidUmask.into())
	}
}

fn set_umask(value: stat::mode_t) -> Result<(), Error> {
	// value of mode_t can be platform dependent
	let mode = stat::Mode::from_bits(value).ok_or_else(|| ErrorKind::InvalidUmask)?;
	stat::umask(mode);
	Ok(())
}

fn symbolic_mask_from_bits(bits: u32) -> String {
	let mut result = String::new();

	if (bits & 0b100) != 0 {
		result.push('r');
	}
	if (bits & 0b010) != 0 {
		result.push('w');
	}
	if (bits & 0b001) != 0 {
		result.push('x');
	}

	result
}

#[cfg(test)]
mod tests {
	use super::*;

	fn parse(mode: &str, current_umask: u32) -> u32 {
		u32::from(parse_symbolic_umask(mode, current_umask).unwrap())
	}

	#[test]
	fn parses_symbolic_umask_assignments() {
		assert_eq!(parse("u=rwx,g=rx,o=", 0o022), 0o027);
		assert_eq!(parse("=r", 0o022), 0o333);
		assert_eq!(parse("a=", 0o022), 0o777);
		assert_eq!(parse("u=", 0o022), 0o722);
	}

	#[test]
	fn parses_symbolic_umask_incremental_ops() {
		assert_eq!(parse("u+rw", 0o777), 0o177);
		assert_eq!(parse("g-w", 0o022), 0o022);
		assert_eq!(parse("+x", 0o022), 0o022);
		assert_eq!(parse("u+r-w", 0o777), 0o377);
		assert_eq!(parse("a+r,u-w", 0o777), 0o333);
	}

	#[test]
	fn rejects_invalid_symbolic_umasks() {
		assert!(parse_symbolic_umask("", 0o022).is_err());
		assert!(parse_symbolic_umask("u", 0o022).is_err());
		assert!(parse_symbolic_umask("u+z", 0o022).is_err());
		assert!(parse_symbolic_umask("z+r", 0o022).is_err());
		assert!(parse_symbolic_umask("u=,", 0o022).is_err());
		assert!(parse_symbolic_umask("u,,g=r", 0o022).is_err());
	}
}
