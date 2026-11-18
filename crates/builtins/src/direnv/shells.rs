//! direnv's target shells: how an environment change is spelled for each
//! (`direnv export SHELL`, `direnv dump SHELL`) and the hook each installs
//! (`direnv hook SHELL`). Ported from direnv 2.38.2 (`internal/cmd/shell_*.go`),
//! escaping rules included; entries print in name order where direnv's own
//! order is Go's random map order.

use std::{
	fmt::Write as _,
	hash::{BuildHasher, RandomState},
};

use serde_json::Value;

/// A variable to set (`Some`) or remove (`None`), by name.
pub(super) type Change<'a> = (&'a str, Option<&'a str>);

/// The shells `direnv` exports to, by the name the command line gives.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Shell {
	Bash,
	Elvish,
	Fish,
	Gha,
	Gzenv,
	Json,
	Murex,
	Pwsh,
	Systemd,
	Tcsh,
	Vim,
	Zsh,
}

/// Every shell name, sorted, as `direnv help` lists them.
pub(super) const SHELL_NAMES: &str =
	"[bash, elvish, fish, gha, gzenv, json, murex, pwsh, systemd, tcsh, vim, zsh]";

impl Shell {
	/// The shell `target` names: usually `$0`, so a path and a login shell's
	/// leading `-` are dropped.
	pub(super) fn detect(target: &str) -> Option<Self> {
		let base = target.trim_end_matches('/').rsplit('/').next().unwrap_or_default();
		Some(match base.strip_prefix('-').unwrap_or(base) {
			"bash" => Self::Bash,
			"elvish" => Self::Elvish,
			"fish" => Self::Fish,
			"gha" => Self::Gha,
			"gzenv" => Self::Gzenv,
			"json" => Self::Json,
			"murex" => Self::Murex,
			"pwsh" => Self::Pwsh,
			"systemd" => Self::Systemd,
			"tcsh" => Self::Tcsh,
			"vim" => Self::Vim,
			"zsh" => Self::Zsh,
			_ => return None,
		})
	}

	/// The text that applies `changes` when the shell evaluates it.
	///
	/// # Errors
	///
	/// The GitHub Actions format cannot delimit a value that contains two
	/// fresh random delimiters.
	pub(super) fn export(self, changes: &[Change<'_>]) -> Result<String, String> {
		let mut out = String::new();
		match self {
			Self::Bash | Self::Zsh => {
				for &(key, value) in changes {
					match value {
						Some(value) => {
							let _ = write!(out, "export {}={};", bash_escape(key), bash_escape(value));
						},
						None => {
							let _ = write!(out, "unset {};", bash_escape(key));
						},
					}
				}
			},
			Self::Fish => {
				for &(key, value) in changes {
					match value {
						Some(value) if key == "PATH" => {
							out.push_str("set -x -g PATH");
							for dir in value.split(':') {
								out.push(' ');
								fish_escape(&mut out, dir);
							}
							out.push(';');
						},
						Some(value) => {
							out.push_str("set -x -g ");
							fish_escape(&mut out, key);
							out.push(' ');
							fish_escape(&mut out, value);
							out.push(';');
						},
						None => {
							out.push_str("set -e -g ");
							fish_escape(&mut out, key);
							out.push(';');
						},
					}
				}
			},
			Self::Tcsh => {
				for &(key, value) in changes {
					match value {
						Some(value) if key == "PATH" => {
							out.push_str("set path = (");
							for dir in value.split(':') {
								out.push(' ');
								tcsh_escape(&mut out, dir);
							}
							out.push_str(" );");
						},
						Some(value) => {
							out.push_str("setenv ");
							tcsh_escape(&mut out, key);
							out.push(' ');
							tcsh_escape(&mut out, value);
							out.push_str(" ;");
						},
						None => {
							out.push_str("unsetenv ");
							tcsh_escape(&mut out, key);
							out.push_str(" ;");
						},
					}
				}
			},
			Self::Vim => {
				for &(key, value) in changes {
					out.push_str("call setenv(");
					vim_escape(&mut out, key);
					out.push(',');
					match value {
						Some(value) => vim_escape(&mut out, value),
						None => out.push_str("v:null"),
					}
					out.push_str(")\n");
				}
			},
			Self::Pwsh => {
				// Removals first, and never a variable with no name.
				for &(key, _) in changes.iter().filter(|(key, value)| !key.is_empty() && value.is_none()) {
					let _ = write!(out, "Remove-Item -LiteralPath 'env:/{}';", key.replace('\'', "''"));
				}
				for &(key, value) in changes {
					if let Some(value) = value.filter(|_| !key.is_empty()) {
						let _ = write!(out, "${{env:{}}}='{}';", pwsh_key(key), value.replace('\'', "''"));
					}
				}
			},
			Self::Systemd => {
				for &(key, value) in changes {
					if let Some(value) = value {
						let _ = writeln!(out, "{key}={}", systemd_value(value));
					}
				}
			},
			Self::Gha => {
				for &(key, value) in changes {
					// `>> $GITHUB_ENV` cannot remove a variable.
					let (Some(value), true) = (value, gha_key(key)) else {
						continue;
					};
					let mut delimiter = gha_delimiter();
					if key.contains(&delimiter) || value.contains(&delimiter) {
						delimiter = gha_delimiter();
						if key.contains(&delimiter) || value.contains(&delimiter) {
							return Err(format!("delimiter collision after regeneration for key {key}"));
						}
					}
					let _ = write!(out, "{key}<<{delimiter}\n{value}\n{delimiter}\n");
				}
			},
			Self::Json => json_map(&mut out, changes, true),
			Self::Elvish | Self::Murex => {
				json_map(&mut out, changes, false);
				out.push('\n');
			},
			Self::Gzenv => {
				json_map(&mut out, changes, false);
				out = super::gzenv_encode(&out);
			},
		}
		Ok(out)
	}

	/// The hook that makes the shell load `.envrc` files as it moves between
	/// directories, calling direnv as `self_path`.
	///
	/// # Errors
	///
	/// direnv's message for a target that is no interactive shell.
	pub(super) fn hook(self, self_path: &str) -> Result<String, &'static str> {
		let template = match self {
			Self::Bash => BASH_HOOK,
			Self::Zsh => ZSH_HOOK,
			Self::Fish => FISH_HOOK,
			Self::Elvish => ELVISH_HOOK,
			Self::Murex => MUREX_HOOK,
			Self::Pwsh => PWSH_HOOK,
			Self::Tcsh => "alias precmd 'eval `{{.SelfPath}} export tcsh`'",
			Self::Gha => return Err("Hook not implemented for GitHub Actions shell"),
			Self::Gzenv => return Err("the gzenv shell doesn't support hooking"),
			Self::Json | Self::Systemd => return Err("this feature is not supported"),
			Self::Vim => {
				return Err("this feature is not supported. Install the direnv.vim plugin instead");
			},
		};
		Ok(template
			.replace("{{.BashSelfPath}}", &bash_escape(self_path))
			.replace("{{.PwshSelfPath}}", &self_path.replace('\'', "''"))
			.replace("{{.SelfPath}}", self_path))
	}
}

/// `str` as one bash (or zsh) word: as it is when no byte needs quoting,
/// else inside `$'…'` with control and high bytes as escapes, so the word
/// never spans lines or carries non-ASCII bytes.
pub(super) fn bash_escape(str: &str) -> String {
	if str.is_empty() {
		return "''".to_owned();
	}
	let mut out = String::with_capacity(str.len() + 4);
	let mut quoted = false;
	for byte in str.bytes() {
		match byte {
			b'\t' => out.push_str("\\t"),
			b'\n' => out.push_str("\\n"),
			b'\r' => out.push_str("\\r"),
			b'\'' | b'\\' => {
				out.push('\\');
				out.push(char::from(byte));
			},
			b',' | b'-' | b'.' | b'/' | b'0'..=b'9' | b'@' | b'A'..=b'Z' | b'_' => {
				out.push(char::from(byte));
				continue;
			},
			b' '..=b'~' => out.push(char::from(byte)),
			_ => {
				let _ = write!(out, "\\x{byte:02x}");
			},
		}
		quoted = true;
	}
	if quoted {
		out.insert_str(0, "$'");
		out.push('\'');
	}
	out
}

/// `str` as one fish word: single-quoted, with control and high bytes
/// spliced in as unquoted escapes.
fn fish_escape(out: &mut String, str: &str) {
	out.push('\'');
	for byte in str.bytes() {
		match byte {
			b'\t' => out.push_str("'\\t'"),
			b'\n' => out.push_str("'\\n'"),
			b'\r' => out.push_str("'\\r'"),
			b'\'' | b'\\' => {
				out.push('\\');
				out.push(char::from(byte));
			},
			b' '..=b'~' => out.push(char::from(byte)),
			_ => {
				let _ = write!(out, "'\\X{byte:02x}'");
			},
		}
	}
	out.push('\'');
}

/// `str` as one tcsh word: every special byte quoted on its own.
fn tcsh_escape(out: &mut String, str: &str) {
	if str.is_empty() {
		out.push_str("''");
		return;
	}
	for byte in str.bytes() {
		match byte {
			b'\t' => out.push_str("\\t"),
			b'\n' => out.push_str("\\n"),
			b'\r' => out.push_str("\\r"),
			b' ' | b'\'' | b'\\' => {
				out.push('\\');
				out.push(char::from(byte));
			},
			b',' | b'-' | b'.' | b'/' | b'0'..=b'9' | b'@' | b'A'..=b'Z' | b']'..=b'z' => {
				out.push(char::from(byte));
			},
			b'!'..=b'~' => {
				out.push('"');
				out.push(char::from(byte));
				out.push('"');
			},
			_ => {
				let _ = write!(out, "\\x{byte:02x}");
			},
		}
	}
}

/// `str` as a vim string literal.
fn vim_escape(out: &mut String, str: &str) {
	out.push('\'');
	for c in str.chars() {
		match c {
			'\n' => out.push_str("\\n"),
			'\'' => out.push_str("''"),
			c => out.push(c),
		}
	}
	out.push('\'');
}

/// `key` inside PowerShell's `${env:…}`, which takes no wildcard or
/// separator characters.
fn pwsh_key(key: &str) -> String {
	let mut out = String::with_capacity(key.len());
	for c in key.chars() {
		match c {
			'*' | ':' | '=' | '?' | '[' | ']' => {
				let _ = write!(out, "\\x{:02x}", u32::from(c));
			},
			'{' | '}' => {
				out.push('`');
				out.push(c);
			},
			c => out.push(c),
		}
	}
	out
}

/// `value` for a systemd `EnvironmentFile`: quoted once it holds a newline,
/// backslash or quote, keeping quotes it already wears.
fn systemd_value(value: &str) -> String {
	if !value.contains(['\n', '\\', '"', '\'']) {
		return value.to_owned();
	}
	let inside = |quote: char| value.strip_prefix(quote).and_then(|rest| rest.strip_suffix(quote));
	match inside('\'') {
		Some(inner) => format!("'{}'", inner.replace('\'', "\\'")),
		None => format!("\"{}\"", inside('"').unwrap_or(value).replace('"', "\\\"")),
	}
}

/// Whether `key` is a name `$GITHUB_ENV` accepts.
fn gha_key(key: &str) -> bool {
	let mut bytes = key.bytes();
	bytes.next().is_some_and(|c| c.is_ascii_alphabetic() || c == b'_')
		&& bytes.all(|c| c.is_ascii_alphanumeric() || c == b'_')
}

/// A fresh heredoc delimiter for one `$GITHUB_ENV` value.
fn gha_delimiter() -> String {
	let random = || RandomState::new().hash_one(0u8);
	format!("ghadelimiter_{:016x}{:016x}", random(), random())
}

/// Appends `changes` as a JSON object the way Go's `encoding/json` writes a
/// map: `indent` selects `MarshalIndent`'s two-space layout over `Marshal`'s
/// compact one, and a removal is `null`.
pub(super) fn json_map(out: &mut String, changes: &[Change<'_>], indent: bool) {
	if changes.is_empty() {
		out.push_str("{}");
		return;
	}
	out.push('{');
	for (index, &(key, value)) in changes.iter().enumerate() {
		if index > 0 {
			out.push(',');
		}
		if indent {
			out.push_str("\n  ");
		}
		json_string(out, key);
		out.push_str(if indent { ": " } else { ":" });
		match value {
			Some(value) => json_string(out, value),
			None => out.push_str("null"),
		}
	}
	if indent {
		out.push('\n');
	}
	out.push('}');
}

/// Appends `str` as a JSON string with Go's escapes: the HTML-sensitive
/// characters and the line separators leave as `\uXXXX`.
pub(super) fn json_string(out: &mut String, str: &str) {
	out.push('"');
	for c in str.chars() {
		match c {
			'"' => out.push_str("\\\""),
			'\\' => out.push_str("\\\\"),
			'\n' => out.push_str("\\n"),
			'\r' => out.push_str("\\r"),
			'\t' => out.push_str("\\t"),
			'\u{8}' => out.push_str("\\b"),
			'\u{c}' => out.push_str("\\f"),
			'<' | '>' | '&' | '\u{2028}' | '\u{2029}' | '\0'..='\u{1f}' => {
				let _ = write!(out, "\\u{:04x}", u32::from(c));
			},
			c => out.push(c),
		}
	}
	out.push('"');
}

/// Appends `value` as Go's `json.Encoder` with a two-space indent prints a
/// decoded document: object keys in name order.
pub(super) fn json_value(out: &mut String, value: &Value, depth: usize) {
	let newline = |out: &mut String, depth: usize| {
		out.push('\n');
		for _ in 0..depth {
			out.push_str("  ");
		}
	};
	match value {
		Value::String(str) => json_string(out, str),
		Value::Array(items) if !items.is_empty() => {
			out.push('[');
			for (index, item) in items.iter().enumerate() {
				if index > 0 {
					out.push(',');
				}
				newline(out, depth + 1);
				json_value(out, item, depth + 1);
			}
			newline(out, depth);
			out.push(']');
		},
		Value::Object(map) if !map.is_empty() => {
			let mut entries: Vec<(&String, &Value)> = map.iter().collect();
			entries.sort_unstable_by_key(|&(key, _)| key);
			out.push('{');
			for (index, (key, item)) in entries.into_iter().enumerate() {
				if index > 0 {
					out.push(',');
				}
				newline(out, depth + 1);
				json_string(out, key);
				out.push_str(": ");
				json_value(out, item, depth + 1);
			}
			newline(out, depth);
			out.push('}');
		},
		other => {
			let _ = write!(out, "{other}");
		},
	}
}

/// direnv's `bash` hook template.
const BASH_HOOK: &str = r##"
_direnv_hook() {
  local previous_exit_status=$?;
  local previous_sigint_trap="$(trap -p SIGINT)";
  vars="$({{.BashSelfPath}} export bash)";
  trap -- '' SIGINT;
  eval "$vars";
  eval "${previous_sigint_trap:-trap - SIGINT}";
  return $previous_exit_status;
};
if [[ ${BLE_VERSION-} ]] && (( _ble_version >= 400 )); then
  blehook PRECMD!="_direnv_hook"
elif [[ ";${PROMPT_COMMAND[*]:-};" != *";_direnv_hook;"* ]]; then
  if [[ "$(declare -p PROMPT_COMMAND 2>&1)" == "declare -a"* ]]; then
    PROMPT_COMMAND=(_direnv_hook "${PROMPT_COMMAND[@]}")
  else
    PROMPT_COMMAND="_direnv_hook${PROMPT_COMMAND:+;$PROMPT_COMMAND}"
  fi
fi
"##;

/// direnv's `zsh` hook template.
const ZSH_HOOK: &str = r##"
_direnv_hook() {
  setopt localoptions localtraps
  if [[ ! -o interactive || $ZSH_SUBSHELL -ne 0 ]]; then
    return
  fi
  vars="$({{.BashSelfPath}} export zsh)"
  trap -- '' SIGINT
  eval "$vars"
  trap - SIGINT
}
typeset -ag precmd_functions
if (( ! ${precmd_functions[(I)_direnv_hook]} )); then
  precmd_functions=(_direnv_hook $precmd_functions)
fi
typeset -ag chpwd_functions
if (( ! ${chpwd_functions[(I)_direnv_hook]} )); then
  chpwd_functions=(_direnv_hook $chpwd_functions)
fi
"##;

/// direnv's `fish` hook template.
const FISH_HOOK: &str = r##"
    function __direnv_export_eval --on-event fish_prompt;
        "{{.SelfPath}}" export fish | source;
        __direnv_update_fish_complete_path;

        if test "$direnv_fish_mode" != "disable_arrow";
            function __direnv_cd_hook --on-variable PWD;
                if test "$direnv_fish_mode" = "eval_after_arrow";
                    set -g __direnv_export_again 0;
                else;
                    "{{.SelfPath}}" export fish | source;
                    __direnv_update_fish_complete_path;
                end;
            end;
        end;
    end;

    function __direnv_export_eval_2 --on-event fish_preexec;
        if set -q __direnv_export_again;
            set -e __direnv_export_again;
            "{{.SelfPath}}" export fish | source;
            __direnv_update_fish_complete_path;
            echo;
        end;

        functions --erase __direnv_cd_hook;
    end;

    function __direnv_update_fish_complete_path;
        set -l desired;
        for p in $fish_complete_path;
            contains -- $p $__direnv_fish_complete_paths;
            or set -a desired $p;
        end;

        set -l added;
        for dir in (string split ':' -- $XDG_DATA_DIRS);
            test -n "$dir"; or continue;
            # same normalisation as fish's share/config.fish, so contains matches its own entries
            set -l completions_dir (string replace -r '([^/])/$' '$1' -- $dir)/fish/vendor_completions.d;
            if test -d "$completions_dir"; and not contains -- $completions_dir $desired;
                set -a desired $completions_dir;
                set -a added $completions_dir;
            end;
        end;
        set -g __direnv_fish_complete_paths $added;

        # every assignment makes fish unload autoloaded completions (complete_invalidate_path)
        if test (count $desired) -ne (count $fish_complete_path); or test "$desired" != "$fish_complete_path";
            set -g fish_complete_path $desired;
        end;
    end;
"##;

/// direnv's `elvish` hook template.
const ELVISH_HOOK: &str = r##"## hook for direnv
set @edit:before-readline = $@edit:before-readline {
	try {
		var m = [("{{.SelfPath}}" export elvish | from-json)]
		if (> (count $m) 0) {
			set m = (all $m)
			keys $m | each { |k|
				if $m[$k] {
					set-env $k $m[$k]
				} else {
					unset-env $k
				}
			}
		}
	} catch e {
		echo $e
	}
}
"##;

/// direnv's `murex` hook template.
const MUREX_HOOK: &str = r##"event: onPrompt direnv_hook=before {
	"{{.SelfPath}}" export murex -> set exports
	if { $exports != "" } {
		$exports -> :json: formap key value {
			if { is-null value } then {
				!export "$key"
			} else {
				$value -> export "$key"
			}
		}
	}
}"##;

/// direnv's `pwsh` hook template.
const PWSH_HOOK: &str = r##"using namespace System;
using namespace System.Management.Automation;

if ($PSVersionTable.PSVersion.Major -lt 7 -or ($PSVersionTable.PSVersion.Major -eq 7 -and $PSVersionTable.PSVersion.Minor -lt 2)) {
    throw "direnv: PowerShell version $($PSVersionTable.PSVersion) does not meet the minimum required version 7.2!"
}

$hook = [EventHandler[LocationChangedEventArgs]] {
  param([object] $source, [LocationChangedEventArgs] $eventArgs)
  end {
    $export = (& '{{.PwshSelfPath}}' export pwsh) -join [Environment]::NewLine;
    if ($export) {
      Invoke-Expression -Command $export;
    }
  }
};
$currentAction = $ExecutionContext.SessionState.InvokeCommand.LocationChangedAction;
if ($currentAction) {
  $ExecutionContext.SessionState.InvokeCommand.LocationChangedAction = [Delegate]::Combine($currentAction, $hook);
}
else {
  $ExecutionContext.SessionState.InvokeCommand.LocationChangedAction = $hook;
};

"##;

#[cfg(test)]
mod tests {
	use super::{Shell, bash_escape};

	/// Contract: `eval "$(direnv export bash)"` must restore every byte of a
	/// value, and a word that needs no quoting stays bare.
	#[test]
	fn bash_words_quote_everything_the_shell_would_read() {
		assert_eq!(bash_escape(""), "''");
		assert_eq!(bash_escape("PATH_2/A-B.C,D@E"), "PATH_2/A-B.C,D@E");
		assert_eq!(bash_escape("bar"), "$'bar'");
		assert_eq!(bash_escape("a b'c\\d\n\te\u{1}é"), "$'a b\\'c\\\\d\\n\\te\\x01\\xc3\\xa9'");
	}

	/// Contract: each target spells a set, a removal and `PATH` its own way.
	#[test]
	fn every_shell_spells_sets_and_removals() {
		let changes = [("GONE", None), ("PATH", Some("/a b:/c")), ("V", Some("it's"))];
		let export = |shell: Shell| shell.export(&changes).expect("export");
		assert_eq!(
			export(Shell::Bash),
			"unset GONE;export PATH=$'/a b:/c';export V=$'it\\'s';"
		);
		assert_eq!(export(Shell::Zsh), export(Shell::Bash));
		assert_eq!(
			export(Shell::Fish),
			"set -e -g 'GONE';set -x -g PATH '/a b' '/c';set -x -g 'V' 'it\\'s';"
		);
		assert_eq!(
			export(Shell::Tcsh),
			"unsetenv GONE ;set path = ( /a\\ b /c );setenv V it\\'s ;"
		);
		assert_eq!(
			export(Shell::Vim),
			"call setenv('GONE',v:null)\ncall setenv('PATH','/a b:/c')\ncall setenv('V','it''s')\n"
		);
		assert_eq!(
			export(Shell::Pwsh),
			"Remove-Item -LiteralPath 'env:/GONE';${env:PATH}='/a b:/c';${env:V}='it''s';"
		);
		assert_eq!(export(Shell::Systemd), "PATH=/a b:/c\nV=\"it's\"\n");
		assert_eq!(
			export(Shell::Json),
			"{\n  \"GONE\": null,\n  \"PATH\": \"/a b:/c\",\n  \"V\": \"it's\"\n}"
		);
		assert_eq!(export(Shell::Elvish), "{\"GONE\":null,\"PATH\":\"/a b:/c\",\"V\":\"it's\"}\n");
		let gha = export(Shell::Gha);
		let mut lines = gha.lines();
		let delimiter = lines.next().and_then(|line| line.strip_prefix("PATH<<")).expect("heredoc");
		assert!(delimiter.starts_with("ghadelimiter_"), "{gha}");
		assert_eq!(lines.next(), Some("/a b:/c"));
		assert_eq!(lines.next(), Some(delimiter));
	}

	/// Contract: a login shell's `$0` (`-zsh`, a path) picks its hook, the
	/// hook calls direnv by the given path, and a non-shell target refuses.
	#[test]
	fn hooks_name_direnv_and_refuse_non_shells() {
		let zsh = Shell::detect("-zsh").expect("zsh").hook("/opt/my direnv").expect("hook");
		assert!(zsh.contains("vars=\"$($'/opt/my direnv' export zsh)\""), "{zsh}");
		let fish = Shell::detect("/usr/bin/fish").expect("fish").hook("direnv").expect("hook");
		assert!(fish.contains("\"direnv\" export fish | source;"), "{fish}");
		assert_eq!(Shell::Json.hook("direnv"), Err("this feature is not supported"));
		assert_eq!(Shell::detect("nushell"), None);
	}
}
