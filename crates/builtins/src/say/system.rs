//! The system speech synthesizers `say` falls back to, and the command lines
//! that drive them: macOS `say`, Speech Dispatcher's `spd-say`, eSpeak
//! (`espeak-ng`, `espeak`) and Windows SAPI through PowerShell.

use std::{
	ffi::OsString,
	path::{Path, PathBuf},
};

use crate::host::Host;

/// The words per minute a synthesizer speaks at when no rate is asked for;
/// macOS `say` and eSpeak agree on it.
pub(super) const DEFAULT_RATE: u32 = 175;

/// The operating system family whose synthesizers are tried.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Platform {
	MacOs,
	Windows,
	/// Linux and the other Unix systems.
	Unix,
}

impl Platform {
	/// The platform this build runs on.
	pub const fn current() -> Self {
		if cfg!(target_os = "macos") {
			Self::MacOs
		} else if cfg!(windows) {
			Self::Windows
		} else {
			Self::Unix
		}
	}
}

/// How a system synthesizer is driven.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Engine {
	/// macOS `say`: takes every option as given.
	Say,
	/// Speech Dispatcher's client; plays only.
	SpdSay,
	/// `espeak-ng` or `espeak`.
	Espeak,
	/// Windows SAPI, scripted through PowerShell.
	Sapi,
}

/// A system synthesizer found on this machine.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Synthesizer {
	pub engine:  Engine,
	pub program: PathBuf,
}

/// The programs to look for on `platform`, in order of preference; with
/// `to_file` only those that can write an audio file. A name with a
/// directory is that file itself, the others are searched on `PATH`.
pub(super) const fn candidates(platform: Platform, to_file: bool) -> &'static [(&'static str, Engine)] {
	match (platform, to_file) {
		(Platform::MacOs, _) => &[("say", Engine::Say), ("/usr/bin/say", Engine::Say)],
		(Platform::Windows, _) => &[("powershell.exe", Engine::Sapi), ("pwsh.exe", Engine::Sapi)],
		(Platform::Unix, false) => {
			&[("spd-say", Engine::SpdSay), ("espeak-ng", Engine::Espeak), ("espeak", Engine::Espeak)]
		},
		(Platform::Unix, true) => &[("espeak-ng", Engine::Espeak), ("espeak", Engine::Espeak)],
	}
}

/// The first of [`candidates`] present on this machine.
pub(super) async fn find(host: &Host, platform: Platform, to_file: bool) -> Option<Synthesizer> {
	for &(name, engine) in candidates(platform, to_file) {
		if let Some(program) = locate(host, name).await {
			return Some(Synthesizer { engine, program });
		}
	}
	None
}

/// The executable file `name` stands for: itself when it has a directory,
/// else the first match on the shell's `PATH`.
pub(super) async fn locate(host: &Host, name: &str) -> Option<PathBuf> {
	let fs = host.vfs();
	let runnable = async |candidate: PathBuf| {
		let executable = fs.is_file(&candidate).await && fs.access(&candidate, false, false, cfg!(unix)).await.is_ok();
		executable.then_some(candidate)
	};
	if Path::new(name).parent().is_some_and(|dir| !dir.as_os_str().is_empty()) {
		return runnable(PathBuf::from(name)).await;
	}
	let search_path = host.var("PATH")?.to_owned();
	for dir in std::env::split_paths(&search_path) {
		if dir.as_os_str().is_empty() {
			continue;
		}
		if let Some(found) = runnable(omp_vfs::join_path(&host.resolve(dir), Path::new(name))).await {
			return Some(found);
		}
	}
	None
}

/// What `say` was asked for, as far as a system synthesizer can honor it.
#[derive(Clone, Debug, Default)]
pub(super) struct Speech<'a> {
	pub voice:       Option<&'a str>,
	/// `-r` as typed; macOS `say` gets it verbatim.
	pub rate:        Option<&'a str>,
	/// The audio file to write instead of playing.
	pub output:      Option<&'a Path>,
	pub device:      Option<&'a str>,
	pub network:     Option<&'a str>,
	pub progress:    bool,
	/// `-i`'s markup; empty for the bare option.
	pub interactive: Option<&'a str>,
	pub file_format: Option<&'a str>,
	pub data_format: Option<&'a str>,
	pub channels:    Option<&'a str>,
	pub bit_rate:    Option<&'a str>,
	pub quality:     Option<&'a str>,
}

/// One program run: its arguments (the program first), variables to export
/// to it, and whether it reads the text on its standard input.
#[derive(Debug, Default, PartialEq, Eq)]
pub(super) struct Run {
	pub argv:        Vec<OsString>,
	pub env:         Vec<(&'static str, String)>,
	pub stdin_text:  bool,
}

/// PowerShell that speaks standard input through SAPI. An unknown voice is
/// skipped, like every option the synthesizer has no equivalent for.
const SAPI_SPEAK: &str = "\
[Console]::InputEncoding = [Text.Encoding]::UTF8; \
Add-Type -AssemblyName System.Speech; \
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
if ($env:PI_SAY_VOICE) { try { $s.SelectVoice($env:PI_SAY_VOICE) } catch {} }; \
if ($env:PI_SAY_RATE) { $s.Rate = [int]$env:PI_SAY_RATE }; \
if ($env:PI_SAY_OUTPUT) { $s.SetOutputToWaveFile($env:PI_SAY_OUTPUT) }; \
$s.Speak([Console]::In.ReadToEnd()); \
$s.Dispose()";

/// PowerShell that lists the SAPI voices the way `say -v '?'` does.
const SAPI_VOICES: &str = "\
Add-Type -AssemblyName System.Speech; \
$s = New-Object System.Speech.Synthesis.SpeechSynthesizer; \
$s.GetInstalledVoices() | ForEach-Object { $v = $_.VoiceInfo; \
'{0,-20}{1}    # {2}' -f $v.Name, $v.Culture.Name.Replace('-', '_'), $v.Description }";

fn powershell(program: &Path, script: &str) -> Vec<OsString> {
	vec![program.into(), "-NoProfile".into(), "-NonInteractive".into(), "-Command".into(), script.into()]
}

/// The words per minute `rate` asks for; `None` when it is no number, which
/// `say` ignores.
pub(super) fn words_per_minute(rate: &str) -> Option<u32> {
	let rate = rate.trim().parse::<f64>().ok()?;
	(rate.is_finite() && rate >= 1.0).then(|| rate.round().min(f64::from(u16::MAX)) as u32)
}

/// Whether `voice` is spelled like an eSpeak voice or a language code
/// (`en`, `en-us`, `mb-en1`, `fr+f3`) rather than a macOS voice name.
fn is_language_voice(voice: &str) -> bool {
	voice.starts_with(|first: char| first.is_ascii_lowercase())
		&& voice.bytes().all(|byte| byte.is_ascii_lowercase() || byte.is_ascii_digit() || b"+-_".contains(&byte))
}

fn option(argv: &mut Vec<OsString>, flag: &str, value: &str) {
	argv.push(flag.into());
	argv.push(value.into());
}

impl Synthesizer {
	/// The runs that speak `text` (or write it to [`Speech::output`], always
	/// as WAVE except for macOS `say`). Options the engine has no equivalent
	/// for are left out.
	pub fn speak(&self, speech: &Speech<'_>, text: &str) -> Vec<Run> {
		let rate = speech.rate.and_then(words_per_minute);
		let mut argv: Vec<OsString> = vec![self.program.clone().into()];
		match self.engine {
			Engine::Say => {
				for (flag, value) in [("-v", speech.voice), ("-r", speech.rate), ("-a", speech.device), ("-n", speech.network)] {
					if let Some(value) = value {
						option(&mut argv, flag, value);
					}
				}
				if let Some(output) = speech.output {
					argv.push("-o".into());
					argv.push(output.into());
				}
				for (flag, value) in [
					("--file-format", speech.file_format),
					("--data-format", speech.data_format),
					("--channels", speech.channels),
					("--bit-rate", speech.bit_rate),
					("--quality", speech.quality),
				] {
					if let Some(value) = value {
						argv.push(format!("{flag}={value}").into());
					}
				}
				if speech.progress {
					argv.push("--progress".into());
				}
				match speech.interactive {
					Some("") => argv.push("--interactive".into()),
					Some(markup) => argv.push(format!("--interactive={markup}").into()),
					None => {},
				}
				vec![Run { argv, env: Vec::new(), stdin_text: true }]
			},
			Engine::Espeak => {
				argv.push("--stdin".into());
				if let Some(voice) = speech.voice.filter(|voice| is_language_voice(voice)) {
					option(&mut argv, "-v", voice);
				}
				if let Some(rate) = rate {
					option(&mut argv, "-s", &rate.to_string());
				}
				if let Some(output) = speech.output {
					argv.push("-w".into());
					argv.push(output.into());
				}
				vec![Run { argv, env: Vec::new(), stdin_text: true }]
			},
			Engine::SpdSay => {
				argv.push("-w".into());
				if let Some(voice) = speech.voice.filter(|voice| is_language_voice(voice)) {
					option(&mut argv, "-l", voice);
				}
				if let Some(rate) = rate {
					// Speech Dispatcher's rate is a percentage around its default.
					let percent = (i64::from(rate) - i64::from(DEFAULT_RATE)) * 100 / i64::from(DEFAULT_RATE);
					option(&mut argv, "-r", &percent.clamp(-100, 100).to_string());
				}
				argv.push("--".into());
				// The text is an argument, and one argument has a size limit.
				argument_chunks(text)
					.map(|chunk| {
						let mut argv = argv.clone();
						argv.push(chunk.into());
						Run { argv, env: Vec::new(), stdin_text: false }
					})
					.collect()
			},
			Engine::Sapi => {
				let mut env = Vec::new();
				if let Some(voice) = speech.voice {
					env.push(("PI_SAY_VOICE", voice.to_owned()));
				}
				if let Some(rate) = rate {
					// SAPI's rate runs -10..=10, tripling the speed across +10.
					let steps = (f64::from(rate) / f64::from(DEFAULT_RATE)).ln() / 3f64.ln() * 10.0;
					env.push(("PI_SAY_RATE", (steps.round().clamp(-10.0, 10.0) as i32).to_string()));
				}
				if let Some(output) = speech.output {
					env.push(("PI_SAY_OUTPUT", output.to_string_lossy().into_owned()));
				}
				vec![Run { argv: powershell(&self.program, SAPI_SPEAK), env, stdin_text: true }]
			},
		}
	}

	/// The run that lists this synthesizer's voices on standard output.
	pub fn list_voices(&self) -> Run {
		let program: OsString = self.program.clone().into();
		let argv = match self.engine {
			Engine::Say => vec![program, "-v".into(), "?".into()],
			Engine::Espeak => vec![program, "--voices".into()],
			Engine::SpdSay => vec![program, "-L".into()],
			Engine::Sapi => powershell(&self.program, SAPI_VOICES),
		};
		Run { argv, env: Vec::new(), stdin_text: false }
	}
}

/// The largest text one `spd-say` argument carries: under Linux's 128 KiB
/// limit for a single argument.
const ARGUMENT_BYTES: usize = 96 * 1024;

/// `text` in pieces of at most [`ARGUMENT_BYTES`], cut at whitespace where
/// there is some.
fn argument_chunks(text: &str) -> impl Iterator<Item = &str> {
	let mut rest = text;
	std::iter::from_fn(move || {
		if rest.is_empty() {
			return None;
		}
		let mut cut = rest.len();
		if cut > ARGUMENT_BYTES {
			cut = rest.floor_char_boundary(ARGUMENT_BYTES);
			if let Some(space) = rest[..cut].rfind(char::is_whitespace).filter(|space| *space > 0) {
				cut = space;
			}
		}
		let (chunk, tail) = rest.split_at(cut);
		rest = tail.trim_start();
		Some(chunk)
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn args(run: &Run) -> Vec<String> {
		run.argv.iter().map(|arg| arg.to_string_lossy().into_owned()).collect()
	}

	/// Contract: each platform tries its own synthesizers in a fixed order,
	/// and `-o` on Linux skips `spd-say`, which cannot write a file.
	#[test]
	fn each_platform_has_its_synthesizers_in_order() {
		let names = |platform, to_file| -> Vec<&str> {
			candidates(platform, to_file).iter().map(|(name, _)| *name).collect()
		};
		assert_eq!(names(Platform::MacOs, false), ["say", "/usr/bin/say"]);
		assert_eq!(names(Platform::Unix, false), ["spd-say", "espeak-ng", "espeak"]);
		assert_eq!(names(Platform::Unix, true), ["espeak-ng", "espeak"]);
		assert_eq!(names(Platform::Windows, true), ["powershell.exe", "pwsh.exe"]);
	}

	/// Contract: macOS `say` receives every option as typed, text on stdin.
	#[test]
	fn macos_say_gets_every_option_verbatim() {
		let synthesizer = Synthesizer { engine: Engine::Say, program: "/usr/bin/say".into() };
		let speech = Speech {
			voice: Some("Bad News"),
			rate: Some("210"),
			output: Some(Path::new("/tmp/x/hi.m4a")),
			device: Some("BlackHole"),
			network: Some(":1234"),
			progress: true,
			interactive: Some("green/black"),
			file_format: Some("m4af"),
			data_format: Some("aac"),
			channels: Some("2"),
			bit_rate: Some("64000"),
			quality: Some("127"),
		};
		let runs = synthesizer.speak(&speech, "hello");
		assert_eq!(runs.len(), 1);
		assert!(runs[0].stdin_text);
		assert_eq!(args(&runs[0]), [
			"/usr/bin/say",
			"-v",
			"Bad News",
			"-r",
			"210",
			"-a",
			"BlackHole",
			"-n",
			":1234",
			"-o",
			"/tmp/x/hi.m4a",
			"--file-format=m4af",
			"--data-format=aac",
			"--channels=2",
			"--bit-rate=64000",
			"--quality=127",
			"--progress",
			"--interactive=green/black",
		]);
		let bare = Speech { interactive: Some(""), ..Speech::default() };
		assert_eq!(args(&synthesizer.speak(&bare, "hello")[0]), ["/usr/bin/say", "--interactive"]);
	}

	/// Contract: eSpeak speaks at `say`'s words per minute, takes only voices
	/// it could know, and never sees macOS-only options.
	#[test]
	fn espeak_maps_rate_and_drops_foreign_voices() {
		let synthesizer = Synthesizer { engine: Engine::Espeak, program: "/usr/bin/espeak-ng".into() };
		let speech = Speech {
			voice: Some("Samantha"),
			rate: Some("200"),
			output: Some(Path::new("/tmp/out.wav")),
			device: Some("1"),
			progress: true,
			quality: Some("9"),
			..Speech::default()
		};
		let runs = synthesizer.speak(&speech, "hello");
		assert_eq!(args(&runs[0]), ["/usr/bin/espeak-ng", "--stdin", "-s", "200", "-w", "/tmp/out.wav"]);
		assert!(runs[0].stdin_text);

		let french = Speech { voice: Some("fr+f3"), rate: Some("fast"), ..Speech::default() };
		assert_eq!(args(&synthesizer.speak(&french, "bonjour")[0]), ["/usr/bin/espeak-ng", "--stdin", "-v", "fr+f3"]);
	}

	/// Contract: `spd-say` waits for the speech to end, gets the rate as a
	/// percentage, and takes long text as several arguments in order.
	#[test]
	fn spd_say_takes_text_as_arguments_and_a_percent_rate() {
		let synthesizer = Synthesizer { engine: Engine::SpdSay, program: "/usr/bin/spd-say".into() };
		let fast = Speech { rate: Some("350"), ..Speech::default() };
		let runs = synthesizer.speak(&fast, "-v is not an option here");
		assert_eq!(args(&runs[0]), ["/usr/bin/spd-say", "-w", "-r", "100", "--", "-v is not an option here"]);
		assert!(!runs[0].stdin_text);
		let slow = Speech { rate: Some("140"), ..Speech::default() };
		assert_eq!(args(&synthesizer.speak(&slow, "hi")[0])[2..4], ["-r", "-20"]);

		let long = format!("{}tail", "word ".repeat(ARGUMENT_BYTES / 5 + 1));
		let runs = synthesizer.speak(&Speech::default(), &long);
		assert_eq!(runs.len(), 2);
		let spoken: Vec<String> = runs.iter().map(|run| args(run).pop().unwrap()).collect();
		assert!(spoken[0].len() <= ARGUMENT_BYTES);
		assert_eq!(spoken.join(" "), long);
	}

	/// Contract: SAPI gets voice, rate and output through the environment
	/// (no quoting of user text into the script) and its -10..=10 rate scale.
	#[test]
	fn sapi_passes_options_through_the_environment() {
		let synthesizer = Synthesizer { engine: Engine::Sapi, program: "powershell.exe".into() };
		let speech = Speech {
			voice: Some("Microsoft Zira Desktop"),
			rate: Some("525"),
			output: Some(Path::new("C:\\out.wav")),
			..Speech::default()
		};
		let runs = synthesizer.speak(&speech, "it's \"quoted\"");
		assert!(runs[0].stdin_text);
		assert_eq!(args(&runs[0])[..4], ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]);
		assert!(!args(&runs[0])[4].contains("quoted"));
		assert_eq!(runs[0].env, [
			("PI_SAY_VOICE", "Microsoft Zira Desktop".to_owned()),
			("PI_SAY_RATE", "10".to_owned()),
			("PI_SAY_OUTPUT", "C:\\out.wav".to_owned()),
		]);
	}
}
