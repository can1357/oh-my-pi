# Installation

An omp extension is a Python distribution plus an `omp.toml` manifest. The manifest lets the host discover, admit, and route the extension before it imports any Python. Use a development link while authoring; package a wheel when you need a reproducible install.

## Extension layout

A small source tree can look like this:

```text
word-tools/
├── omp.toml
├── pyproject.toml
└── src/
    └── word_tools/
        └── __init__.py
```

The package must be importable from the extension's site tree. `entry` names the first module imported when the extension starts.

## Manifest anatomy

```toml
id = "dev.example.word-tools"
name = "Word tools"
version = "0.1.0"
omp_api = 1
description = "Small text utilities"
entry = "word_tools"
capabilities = ["env.fs.read"]

[[tools]]
name = "word_count"
kind = "soft"
family = "dev.example.word-tools"
rev = 1
module = "word_tools"
summary = "Count words in text"

[[hooks]]
event = "turn_end"
phase = "observe"
module = "word_tools"
order = 0

[[services]]
name = "dev.example.words"
rev = 1
module = "word_tools"

[requires]
python = ">=3.14"
wheels = ["regex==2026.8.3"]
services = ["dev.example.dictionary"]
```

The host exposes the parsed record as an immutable [`omp.Manifest`](../reference/omp.md#ompmanifest). Its declaration rows correspond to `ToolEntry`, `HookEntry`, and `ServiceEntry`; `Requires` holds interpreter, wheel, and service requirements.

A tool row supplies a non-empty `name`, `module`, and `summary`, a `kind` of `"soft"` or `"hard"`, a `family`, and a positive `rev`. A hook row names its event, phase, implementation module, and optional integer order. A service row names the service, positive revision, and module. The runtime checks imported declarations against these static rows.

> **Note** Declare only capabilities you actually use. Capabilities are members of the closed [`omp.Capability`](../reference/omp.md#ompcapability) vocabulary; an unknown value is not treated as a custom permission.

## Install and link

Link the source tree during development:

```console
$ omp ext link /absolute/path/to/word-tools
```

Install a built distribution or another supported package source for normal use:

```console
$ omp ext install ./dist/word_tools-0.1.0-py3-none-any.whl
```

Use `omp ext enable dev.example.word-tools` after an explicit disable. The extension is then eligible for discovery; its Python process starts only when one of its declared surfaces is reached.

## Deployment layers

Extension discovery has four practical precedence scopes:

| Scope | Intended owner | Typical use |
|---|---|---|
| builtin | omp | Extensions shipped with the application |
| managed | user or organization | Installed, centrally managed extensions |
| project | repository | Project configuration shared with collaborators |
| workspace | active environment | Extensions supplied beside the current workspace |

At runtime, [`omp.Layer`](../reference/omp.md#omplayer) reports the execution side as `Layer.CLIENT` (`"client"`) or `Layer.WORKSPACE` (`"workspace"`). Builtin, managed, and project discoveries execute on the client side unless placement selects the workspace side. The more detailed precedence, identity, and packaging rules are in [Placement and Packaging](../guides/placement-and-packaging.md).

## Python and wheel requirements

The `omp` executable embeds free-threaded CPython 3.14t, the standard library, and the frozen `omp` modules. It does not consult an ambient Python installation or user site. Pure-Python requirements may be included in a resolved extension site tree; native dependencies require a compatible CPython 3.14t wheel on disk.

`$OMP_PY_SITE` identifies the authorized site-packages directory. The default interpreter location is `~/.local/share/omp-py/site-packages`, while a managed host normally supplies an extension-specific site tree. Setting `$OMP_PY_SITE` yourself is a debugging override and bypasses the managed layout.

> **Warning** A native wheel built for ordinary CPython 3.14 is not automatically compatible with the free-threaded `cp314t` ABI. Install a wheel whose tags match the embedded interpreter and platform.

## Trust and signing

Trust is a user-level admission decision, not a decorator option. Package signatures establish publisher and artifact identity; capability grants record what that identity may request. Unsigned local links are useful for development, but the host can present them differently from verified releases. Trust does not remove capability checks or placement boundaries.

See [Placement and Packaging](../guides/placement-and-packaging.md) for signing, provenance, install records, layering, and wheel resolution.
