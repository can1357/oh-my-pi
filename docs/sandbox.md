# Sandbox detection

omp detects the sandbox it runs in and shows it with `/sandbox`. Detection reports; it changes no approval, tool or setting. What it reports is evidence, not proof of a product's identity or of everything its policy allows.

## `/sandbox`

`/sandbox` starts with a summary of five lines:

- Layer: each detected sandbox, outermost first, and how it was established (`measured` or `declared`, see [Layers](#layers));
- Files: whether the working directory and the home directory are writable, as the layers report it;
- Network: the most restrictive network access a layer reports;
- Approvals: the approval mode tool calls run under (`tools.approvalMode`). A detected sandbox does not change it;
- Kernel: the kernel facts read from the omp process.

Below the summary are the sections that hold the detail:

- one per layer, then one for each titled detail its probe publishes: a markdown section or a policy-files tree;
- `network`: the network access each layer reports, and the proxy variables (`HTTPS_PROXY`, `HTTP_PROXY`, `ALL_PROXY`, `NO_PROXY`) with any `user:password@` replaced by `***@`;
- `namespaces` (Linux): the state of all eight namespaces and the inode each link names;
- `kernel`: the seccomp filter count, capability masks, ID maps, LSM names and label, cgroup, Yama `ptrace_scope` and Landlock support;
- `evidence`: what each probe read and concluded.

In the TUI the report is a panel you step through: the summary rows sit above the list of sections, Up/Down picks a section, Enter opens it, Esc or Backspace returns to the summary, and Esc on the summary closes the panel. Typing filters the section list; the page keys and the wheel scroll. `/sandbox <section>` opens one section directly. RPC and ACP hosts get the same summary and sections as plain labelled lines; having no list to pick from, their summary ends with a `More:` line that names the sections.

For example, the text form under nono with a capability file that grants `~/src/app` read-write and home read-only, nono's proxy in `HTTPS_PROXY`, and omp started in `~/src/app`:

```text
Sandbox ─ nono

Layer: nono (declared)
Files: working directory writable; home read-only
Network: filtered (through the nono proxy)
Approvals: Yolo
Kernel: no_new_privs on · seccomp filter · listing / allowed · own pid namespaces; unknown: mnt, net
More: /sandbox nono | policy-files | paths | network | namespaces | kernel | evidence
```

A policy-files section lists the files and directories a probe says hold its policy. omp looks each one up when the report is built: an absent or unreadable path is marked, and a directory lists its entries, sorted, with a count of the entries past the preview limit. In the TUI every path is a file link. nono's section lists the capability file `NONO_CAP_FILE` names and its user profile directory (`$XDG_CONFIG_HOME/nono/profiles`, `~/.config/nono/profiles` when unset).

What a probe publishes is its sandbox's stated policy, not a test of what a write or a connection does.

## Layers

A layer is one sandbox. Each layer records how it was established. A `measured` layer comes from kernel state that shows a confinement mechanism is in force; that does not say which product set it up or what its policy permits. A `declared` layer comes from a marker that any process of the same user could create, such as an environment variable or a file.

| Layer      | Platforms    | Detected from                                                                                                                                                                               | Basis    |
| ---------- | ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------- |
| `nono`     | Linux, macOS | `NONO_CAP_FILE` and the capability file it names: granted and denied paths, `net_blocked`, `allowed_domains`, `blocked_commands`; `NONO_PROXY_TOKEN` or `HTTPS_PROXY` naming the nono proxy | declared |
| `k8s`      | Linux        | `KUBERNETES_SERVICE_HOST` and a mounted service account                                                                                                                                     | declared |
| `docker`   | Linux        | `/.dockerenv`, or `docker` in PID 1's cgroup path                                                                                                                                           | declared |
| `podman`   | Linux        | `/run/.containerenv`                                                                                                                                                                        | declared |
| `confined` | Linux, macOS | kernel facts, when no other layer matched                                                                                                                                                   | measured |

nono reports whether the working directory and home are writable from its grants: a path is writable when a read-write or write grant covers it or a directory above it. The container layers report neither files nor network.

`confined` covers a sandbox no probe names, such as bubblewrap, Flatpak or systemd sandboxing; it does not say which of them it is. It appears when seccomp is on together with `no_new_privs`, when listing `/` is refused, or when macOS reports a Seatbelt profile. Its restrictions list what was measured, for example `no_new_privs, seccomp filter, pid namespace`. Namespaces alone do not make a `confined` layer.

With more than one layer, the summary takes the strictest answer: a path is read-only if any layer says so, and the network is blocked if any layer blocks it. A layer that does not report files or network does not count.

### What each technique shows

| Technique                                                | What is reported                                                                                                     | What is not shown                                                                                              |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------- |
| nono on Linux                                            | The declared capability and proxy policy, the kernel facts, and Landlock support with its ABI version                | That nono set the sandbox up, that this process is inside a Landlock domain, or that the whole policy is in force |
| nono on macOS                                            | The declared nono policy and the Seatbelt fact                                                                       | Which product set the profile, or what the profile allows                                                      |
| Docker, Podman, Kubernetes                               | The declared marker and the kernel facts                                                                             | Which runtime it is beyond the marker, or what the container may do                                            |
| bubblewrap, Flatpak, systemd and other unnamed sandboxes | seccomp, `no_new_privs`, namespace and LSM facts where readable; a `confined` layer when its conditions hold        | Which product it is                                                                                            |

## Kernel facts

Each fact is read from the kernel, not inferred. A fact that is missing, malformed or unreadable stays absent or `unknown`; unknown does not mean off. The report does not turn kernel support, a filesystem type or namespace membership into a claim about what the process may do.

| Fact                                      | Source and meaning                                                                                                                                                                                 |
| ----------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `noNewPrivs`, `seccomp`, `seccompFilters` | `NoNewPrivs`, `Seccomp` (disabled, strict or filter) and `Seccomp_filters` in `/proc/self/status`                                                                                                  |
| `capabilities`                            | `CapInh`, `CapPrm`, `CapEff`, `CapBnd` and `CapAmb` in `/proc/self/status`, kept as hexadecimal masks and not decoded                                                                              |
| `namespaces`, `namespaceInodes`           | `/proc/self/ns/{mnt,net,user,pid,uts,ipc,cgroup,time}`. The user, pid, uts, ipc, cgroup and time links are compared with the kernel's fixed inode numbers for the initial namespaces               |
| `namespaceIdMaps`                         | `/proc/self/uid_map` and `gid_map`, as inside, outside and length triples                                                                                                                          |
| `lsm`, `lsmLabel`                         | The active security modules from `/sys/kernel/security/lsm`, and this process's AppArmor or SELinux label from `/proc/self/attr/current`                                                           |
| `cgroup`, `yamaPtraceScope`               | `/proc/self/cgroup` and `/proc/sys/kernel/yama/ptrace_scope`                                                                                                                                       |
| `rootListing`                             | Whether listing `/` is refused although `/` is root-owned, world-readable and on a local filesystem. A security module causes that, and so does an ACL entry on `/` that names the user. An allowed listing proves nothing, since a policy may grant `/` |
| `landlock`                                | Whether the kernel supports Landlock and at which ABI version, asked when `/sandbox` is opened. It does not say that this process is inside a Landlock domain |
| `seatbelt`                                | macOS: `sandbox_check(getpid(), NULL, 0)` reports a Seatbelt profile                                                                                                                               |

The mount and network namespaces have no fixed inode to compare with, so their state stays `unknown` even when the link is readable. `/proc/1` is not used as the reference: inside a PID namespace it is not the host's first process.

The Landlock query runs in a short-lived child process on x64 and arm64 Linux, so a seccomp filter that kills the calling process on an unknown system call cannot kill omp. It runs when `/sandbox` is opened (`inspectSandbox()`), not during detection, and the answer is kept for the life of the process. After `detectSandbox()` alone `facts.landlock` is absent; `facts.lsm` already says whether the Landlock module is active. The states are `supported` (with the ABI version), `unsupported`, `disabled`, `blocked` (the query was refused or killed) and `unknown`. The kernel does not report whether a process is inside a Landlock domain, so an ABI version proves support, not enforcement.

## Probes for other sandboxes

A distribution or an extension can name its own sandbox with a probe:

```ts
import { registerSandboxProbe } from "@oh-my-pi/pi-utils/sandbox";

registerSandboxProbe({
	id: "devbox",
	detect(host) {
		const policy = host.readFile("/run/devbox/policy.json");
		if (!policy) return undefined;
		return {
			id: "devbox",
			role: "build",
			basis: "declared",
			restrictions: ["no package installs"],
			files: { cwd: "writable", home: "read-only" },
			network: { access: "filtered", summary: "allow list in /run/devbox/policy.json" },
			details: [
				{ label: "Image", value: "devbox-build" },
				{ title: "Allowed hosts", markdown: "- registry.contoso.example\n- git.contoso.example" },
				{
					title: "Policy files",
					files: [
						{ label: "session policy", path: "/run/devbox/policy.json" },
						{ label: "profiles", path: "/etc/devbox/profiles", directory: true },
					],
				},
			],
			evidence: ["/run/devbox/policy.json present"],
		};
	},
	async report(layer, host, signal) {
		const response = await fetch("http://127.0.0.1:4100/session", { signal });
		return [{ label: "Session", value: await response.text() }];
	},
});
```

- `detect(host, signal)` reads through `host` (`readFile`, `readLink`, `exists`, `env`, `cwd`, `platform`), so tests can run it against a fake `/proc` tree. Keep it to file reads: `detectSandbox()` starts no child process.
- `host.env` is the environment omp was started with, not what dotenv files added at startup: a repository's `.env` cannot declare a sandbox (a `NONO_CAP_FILE` there names no nono layer), also after `--cwd` moves omp elsewhere.
- `detect` may return a promise. Detection waits up to 3 seconds for async probes and drops one that has not answered by then; a probe that wants a fallback layer must bound its own work.
- `files` and `network` feed the summary. `details` holds facts core has no type for, in three kinds. A label/value row goes in the layer's section. A titled markdown section becomes its own `/sandbox` section. A titled `files` list becomes a policy-files section: name each file or directory that holds the sandbox's policy and omp shows whether it is there and what a directory contains (see [`/sandbox`](#sandbox)).
- `report(layer, host, signal)` is optional and returns more details of the same kinds, appended to the layer's. It runs when `/sandbox` is opened, on every open, under the same 3-second timeout as detection. Put anything that starts a process or calls a service there. `detectSandbox()` leaves report details out; `inspectSandbox()` carries them. `detectSandbox()` returns the status it kept from its first run, or from the run a later registration started; `inspectSandbox()` detects again on each call, so `/sandbox` follows a working directory that has moved.
- Every string a probe returns is shown on one line: newlines and tabs become spaces and control characters are dropped. A markdown section is the exception and keeps its lines; a `files` entry's label and path are one line each. A probe that throws, or whose layer names a `network.access` other than `blocked`, `filtered` or `open`, adds no layer; the `evidence` section names it with the error message on one line.
- Probes are keyed by id: registering an existing id replaces that probe. A layer's `id` is its probe's id, whatever the probe returns. An id is one line of printable text, with no leading, trailing or repeated spaces; registering any other id throws. Registering a probe after detection has run starts detection again, so the next status includes the new layer.
- A named layer suppresses `confined`.

## What a layer can claim

Detection reports; it does not authenticate. A process of the same user can forge a declared marker such as `NONO_CAP_FILE` or `/.dockerenv`, and can reach omp's configuration. Kernel facts show which mechanisms are in force, not the whole policy they enforce. Detection is meant to tell you and the agent what environment omp runs in. It is not a security boundary, and it does not try to resist someone who controls the binary, the environment or the configuration.
