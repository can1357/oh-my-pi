<div align="center">
  <img src="https://github.com/user-attachments/assets/266b83a6-bacb-408c-afb7-2a2ddf37b272"/>
</div>

<br/>

<!-- Primary badges -->
<p align="center">
  <!-- crates.io version badge -->
  <a href="https://crates.io/crates/brush-shell"><img src="https://img.shields.io/crates/v/brush-shell?style=flat-square"/></a>
  <!-- msrv badge -->
  <img src="https://img.shields.io/crates/msrv/brush-shell"/>
  <!-- license badge -->
  <img src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"/>
  <br/>
  <!-- crates.io download badge -->
  <a href="https://crates.io/crates/brush-shell"><img src="https://img.shields.io/crates/d/brush-shell?style=flat-square"/></a>
  <!-- compat tests badge -->
  <img src="https://img.shields.io/badge/compat_tests-1389-brightgreen?style=flat-square" alt="1389 compatibility tests"/>
  <!-- Packaging badges -->
  <a href="https://repology.org/project/brush/versions">
    <img src="https://repology.org/badge/tiny-repos/brush.svg" alt="Packaging status"/>
  </a>
  <!-- Social badges -->
  <a href="https://discord.gg/kPRgC9j3Tj">
    <img src="https://dcbadge.limes.pink/api/server/https://discord.gg/kPRgC9j3Tj?compact=true&style=flat" alt="Discord invite"/>
  </a>
</p>

<a href="https://repology.org/project/brush/versions">
</a>

</p>

<hr/>

`brush` (**B**o(u)rn(e) **RU**sty **SH**ell) is a modern [bash-](https://www.gnu.org/software/bash/) and [POSIX-](https://pubs.opengroup.org/onlinepubs/9699919799/utilities/V3_chap02.html) compatible shell written in Rust. Run your existing scripts and `.bashrc` unchanged -- with syntax highlighting and auto-suggestions built in.

## At a glance

✅ Your existing `.bashrc` just works—aliases, functions, completions, all of it.<br/>
✨ Syntax highlighting and auto-suggestions built in.<br/>
🧪 Validated against bash with [~1700 compatibility tests](brush-shell/tests/cases).<br/>
🧩 Easily embeddable in your Rust apps using `brush_core::Shell`.<br/>

<p align="center">
  <img src="https://github.com/user-attachments/assets/0e64d1b9-7e4e-43be-8593-6c1b9607ac52" width="80%"/>
</p>

> ⚠️ **Not everything works yet:** `select` and some edge cases aren't supported. See the [Compatibility Reference](docs/reference/compatibility.md) for details.

### Quick start:

```console
$ cargo binstall brush-shell         # using cargo-binstall
$ brew install brush                 # using Homebrew
$ pacman -S brush                    # Arch Linux
$ cargo install --locked brush-shell # Build from sources
```

`brush` is ready for use as a daily driver. We test every change against `bash` to keep it that way.

More detailed installation instructions are available below.

## ✨ Features

### 🐚 `bash` Compatibility

| | Feature | Description |
|--|---------|-------------|
| ✅ | **50+ builtins** | `echo`, `declare`, `read`, `complete`, `trap`, `ulimit`, ... |
| ✅ | **Full expansions** | brace, parameter, arithmetic, command/process substitution, globs, `extglob`, `globstar` |
| ✅ | **Control flow** | `if`/`for`/`while`/`until`/`case`, `&&`/`\|\|`, subshells, pipelines, etc. |
| ✅ | **Redirection** | here docs, here strings, fd duplication, process substitution redirects |
| ✅ | **Arrays & variables** | indexed/associative arrays, dynamic variables, standard well-known variables, etc. |
| ✅ | **Programmable completion** | Works with [bash-completion](https://github.com/scop/bash-completion) out of the box |
| ✅ | **Job control** | background jobs, suspend/resume, `fg`/`bg`/`jobs` |
| 🔷 | **Traps & options** | `DEBUG`/`ERR`/`EXIT` traps work; signal traps and options in progress |

### ⌨️ User Experience

| | Feature | Description |
|--|---------|-------------|
| ✅ | **Syntax highlighting** | Real-time as you type ([reedline](https://github.com/nushell/reedline)) |
| ✅ | **Auto-suggestions** | History-based hints as you type ([reedline](https://github.com/nushell/reedline)) |
| ✅ | **Rich prompts** | `PS1`/`PROMPT_COMMAND`, right prompts, [starship](https://starship.rs) compatible |
| ✅ | **TOML config** | `~/.config/brush/config.toml` for persistent settings |
| 🧪 | **Extras** | `fzf`/`atuin` support, zsh-style `precmd`/`preexec` hooks (experimental), VS Code terminal integration |

## Installation

_When you run `brush`, it should look exactly as `bash` does on your system: it processes your `.bashrc` and
other standard configuration. If you'd like to distinguish the look of `brush` from the other shells
on your system, you may author a `~/.brushrc` file._

<details>
<summary>🍺 <b>Installing using Homebrew</b> (macOS/Linux)</summary>

Homebrew users can install using [the `brush` formula](https://formulae.brew.sh/formula/brush):

```bash
brew install brush
```

</details>

<details>
<summary>🐧 <b>Installing on Arch Linux</b></summary>

Arch Linux users can install `brush` from the official [extra repository](https://archlinux.org/packages/extra/x86_64/brush/):

```bash
pacman -S brush
```

</details>

<details>
<summary>🚀 <b>Installing prebuilt binaries via `cargo binstall`</b></summary>

You may use [cargo binstall](https://github.com/cargo-bins/cargo-binstall) to install pre-built `brush` binaries. Once you've installed `cargo-binstall` you can run:

```bash
cargo binstall brush-shell
```

</details>

<details>
<summary>🚀 <b>Installing prebuilt binaries from GitHub</b></summary>

We publish prebuilt binaries of `brush` for Linux (x86_64, aarch64) and macOS (aarch64) to GitHub for official [releases](https://github.com/reubeno/brush/releases). You can manually download and extract the `brush` binary from one of the archives published there, or otherwise use the GitHub CLI to download it, e.g.:

```bash
gh release download --repo reubeno/brush --pattern "brush-x86_64-unknown-linux-gnu.*"
```

After downloading the archive for your platform, you may verify its authenticity using the [GitHub CLI](https://cli.github.com/), e.g.:

```bash
gh attestation verify brush-x86_64-unknown-linux-gnu.tar.gz --repo reubeno/brush
```

</details>

<details>
<summary>🐧 <b>Installing using Nix</b></summary>

If you are a Nix user, you can use the registered version:

```bash
nix run 'github:NixOS/nixpkgs/nixpkgs-unstable#brush' -- --version
```

</details>

<details>
<summary> 🔨 <b>Building from sources</b></summary>

To build from sources, first install a working (and recent) `rust` toolchain; we recommend installing it via [`rustup`](https://rustup.rs/). Then run:

```bash
cargo install --locked brush-shell
```

</details>

## Community & Contributing

This project started out of curiosity and a desire to learn—we're keeping that attitude. If something doesn't work the way you'd expect, [let us know](https://github.com/reubeno/brush/issues)!

* [Discord server](https://discord.gg/kPRgC9j3Tj) — chat with the community
* [Building from source](docs/how-to/build.md) — development workflow
* [Contribution guidelines](CONTRIBUTING.md) — how to submit changes
* [Technical docs](docs/README.md) — architecture and reference

## Related Projects

Other POSIX-ish shells implemented in non-C/C++ languages:

* [`nushell`](https://www.nushell.sh/) — modern Rust shell (provides `reedline`)
* [`fish`](https://fishshell.com) — user-friendly shell ([Rust port in 4.0](https://fishshell.com/blog/rustport/))
* [`Oils`](https://github.com/oils-for-unix/oils) — bash-compatible with new Oil language
* [`mvdan/sh`](https://github.com/mvdan/sh) — Go implementation
* [`rusty_bash`](https://github.com/shellgei/rusty_bash) — another Rust bash-like shell

<details>
<summary><b>🙏 Credits</b></summary>

This project relies on many excellent OSS crates:

* [`reedline`](https://github.com/nushell/reedline) — readline-like input and interactive features
* [`clap`](https://github.com/clap-rs/clap) — command-line parsing
* [`fancy-regex`](https://github.com/fancy-regex/fancy-regex) — regex support
* [`tokio`](https://github.com/tokio-rs/tokio) — async runtime
* [`nix`](https://github.com/nix-rust/nix) — Unix/POSIX APIs
* [`criterion.rs`](https://github.com/bheisler/criterion.rs) — benchmarking
* [`bash-completion`](https://github.com/scop/bash-completion) — completion test suite

</details>

---

Licensed under the [MIT license](LICENSE).
