# Contexto persistente — oh-my-pi / `omp`

## 1. Arquitectura y stack

`omp` es la reimplementación en **Rust** del agente de código + runtime de
inferencia de Oh My Pi (antes `pi`, en TypeScript). Se porta **comportamiento
observable**, nunca la forma del código TS.

- **Lenguaje/toolchain**: Rust nightly fijado en `rust-toolchain.toml`
  (`nightly-2026-08-08`), edición 2024, workspace virtual con resolver 3 y 48
  miembros en `crates/*`.
- **Python embebido**: CPython 3.14t (free-threaded) enlazado estáticamente vía
  `crates/py` (`omp-py`) + `pyo3`. Es el **único** runtime de extensiones: no hay
  plugins JS/TS.
- **Protocolo/IPC**: protobuf con `protox` (sin `protoc` del sistema), gRPC en
  `crates/serve`, RPC propio en `crates/rpc`.
- **Async**: tokio + rayon exclusivamente. Canales `flume`; señales de
  prioridad por `tokio::watch`. Locks `parking_lot`.
- **Herramientas**: `just` (fuente de verdad de comandos), `cargo nextest` para
  tests, `bun` para JS/TS, `uv` para Python. Nunca cargo desnudo, npm ni pip.

### Mapa de crates (los que más se tocan)

| Crate | Rol |
|---|---|
| `crates/app` | arranque del proceso, CLI, TUI, ACP, RPC, adaptadores de presentación |
| `crates/driver` | composición headless del agente; `compose_kernel` es el límite de construcción de producción |
| `crates/agent` | `Kernel`, dispatcher, job board, hooks, aprobaciones |
| `crates/journal` / `dom` / `session` / `vocab` | journal `.oms` append-only, árbol materializado, API de sesión, vocabulario compartido |
| `crates/envd` (`omp-envd`) | host vivo del entorno de proyecto: filesystem, procesos, documentos, **supervisión del extension-host de Python** |
| `crates/env` (`omp-env`) | cliente tipado del protocolo de entorno (no posee recursos del host) |
| `crates/ai` / `catalog` | servicios Tower tipados, routing, providers-as-data (KDL en `data/`) |
| `crates/tool` / `tools` | contratos versionados vs. implementaciones (nunca al revés) |
| `crates/tui` / `chat` / `gui` | UI declarativa retenida, actor de chat, ventana nativa |
| `crates/py` / `py-link` | CPython embebido; `omp-py-link` emite los flags de enlace |
| `crates/e2e` | pruebas conjuntas autoritativas P1–P8 |

`AGENTS.md` en la raíz es la referencia completa y **manda sobre este resumen**.

## 2. Convenciones que hay que respetar

- **Dependencias**: todas en `[workspace.dependencies]` de la raíz; los miembros
  usan `{ workspace = true }`. **Nunca** fijar versiones en un miembro.
- **Nombres**: directorios sin prefijo (`crates/demo`), paquetes con prefijo
  (`name = "omp-demo"`). Variables de entorno siempre `OMP_*`, jamás `PI_*`.
- **Pre-release**: renombrar y mover, nunca copiar. Shims de compatibilidad,
  alias antiguos y exports obsoletos están **prohibidos**; se actualiza cada
  llamador en el mismo cambio.
- **Unicode/ANSI**: todo por `xutf`. Prohibido añadir `unicode-*`, `utf8-*`,
  `ansi_*`, `strip-ansi-escapes`.
- **Hashing**: `omp_core::Hash32` (SHA-256) para contenido/cripto;
  `omp_core::{FastHashMap, FastHashSet, fast_hash64}` (foldhash) para mapas y
  claves de caché. Prohibido añadir crates de hashing.
- **Asignaciones**: preferir `&T`/`&str`/`&[T]`. `omp_core::Str` por defecto para
  strings almacenados; `SmallVec<T, N>` con **sintaxis 2.0-alpha** (dos const
  params, no el array genérico de 1.x); `im::Vector`/`im::HashMap` para lo que se
  clona repetidamente; `omp_core::CowBytes` para bytes compartidos.
- **Tamaño de tipos**: `Box` para silenciar `result_large_err` o
  `large_enum_variant` es motivo de rechazo. Se adelgaza el tipo y se fija con
  `const _: () = assert!(size_of::<T>() <= N, "…");`.
- **Async sin cajas**: traits async con RPITIT o tipo asociado inferido
  (`type Future<'c> = impl Future<…>`). `#[async_trait]`, `BoxFuture` y
  `Box::pin` por llamada quedan restringidos a fronteras `dyn` frías dominadas
  por I/O real.
- **Enum ↔ string**: tablas `match` escritas a mano están prohibidas; se usa
  `strum` derivado (`IntoStaticStr`, `Display`, `EnumString`). Escape solo con
  un `macro_rules!` local que emita ambas direcciones.
- **Errores**: `thiserror` con `#[error("…")]` en cada variante. Nunca pasar un
  error por un formateador ni llevar payloads `String`: se transporta el error
  interno tipado con `#[source]`/`#[from]` y los hechos identificatorios como
  campos con nombre. Se renderiza una sola vez, en el borde `miette` de la app.
- **Estilo**: `cargo fmt` (tabs duros, ancho 100). Nunca formatear a mano.
  `#[allow]` exige `reason`; se prefiere `#[expect]`.
- **Tests**: unitarios junto al `src` cuando importa el comportamiento privado;
  contratos públicos en `crates/*/tests`. Se prueba en la costura que posee el
  comportamiento (`envd` para el host, `env` para el protocolo, `driver` para la
  composición, `app` para CLI/presentación). Cambios de TUI exigen prueba en PTY
  real vía `.omp/tools/tui.ts`.

## 3. Estado actual del trabajo

**Rama**: `claude/omp2-audit-9twnv0` → base `omp2` (PR #32 en `blyzer/oh-my-pi`).
**Objetivo del PR**: que omp2 compile y pase tests en Linux, y que la rama quede
protegida por CI por primera vez.

### Ya hecho y verificado

- **P7 (TUI e2e)**: la pulsación de interrupción pasó de `ctrl+c` a `Escape`
  (`omp_chat::ctrl_c_action` resuelve el primer `C-c` a `Clear`, así que nunca
  llegaba al turno); la salida usa `ctrl+c ctrl+c` dentro de la ventana de
  500 ms. P7 pasa por primera vez.
- **Flags de enlace de Python**: se cambió `--export-dynamic` a listas de
  símbolos acotadas (`crates/py/link/cpython.dynamic-list` para ELF,
  `cpython.macho-list` para Mach-O). Ahorro medido: 315,6 MiB, 23,2 % por
  binario; resolución de `dlopen` verificada 8/8.
- **`crates/py-link` (`omp-py-link`)**: crate nuevo; los cuatro `build.rs`
  consumidores (`py`, `app`, `tools`, `e2e`) se redujeron a `omp_py_link::emit();`
  (−257 líneas).
- **`fetch-python.sh`**: añadido el caso `Linux:aarch64`.
- **CI (`.github/workflows/ci.yml`)**: `runs-on` lee `vars.MACOS_RUNNER` con
  fallback a `macos-15`; `needs: [format, licenses]`; los pasos de caché se
  saltan en runners self-hosted (`runner.environment == 'github-hosted'`); nuevo
  job `lint_linux` con `cargo clippy --workspace --locked --keep-going`.
- **`omp-http`** es el dueño del pool de conexiones reqwest en el workspace y
  lleva el único `#[allow(clippy::disallowed_types)]` sancionado. Se enrutaron
  `envd/security_scan/cloud.rs`, `app/chat_voice.rs` y `app/live_reachability.rs`.
- **Snapshots de `crates/chat/tests/chrome.rs`**, orden de `tool_search` (mtimes
  fijados con `File::set_modified`) y la aserción de descripción de `read`.
- **CONTROL, causa raíz parcial**: Rust emite `"family": ""` en las filas de tier
  de dispositivo y `_host.py` rechazaba cualquier componente de identidad vacío,
  matando al hijo durante el `configure` de CONTROL antes del FREEZE. El plazo
  fijo de 10 s del freeze (frente a `spawn_timeout` de 30 s) lo escondía tras un
  `tracing::warn!` en un test sin subscriber. Corregido en `4bc74a3aa`: el
  chequeo de identidad ahora solo exige no vacíos los componentes que
  identifican de verdad.

Progresión de la suite: **18 → 15 → 14 fallos** sobre 9029 tests.

### Lo que falta

1. **Tres tests CONTROL de `omp-app`** (instrucción del usuario: "fix the CONTROL
   cluster", aún a medias):
   - `envd_contract::same_worker_invocation_id_on_two_connections_cancels_only_its_owner`
   - `envd_contract::worker_cancel_forwards_effects_unknown_once_and_respawn_serves_next_request`
   - `tool_worker::control_cancellation_restarts_only_the_owning_extension_host`

   Diagnóstico en curso del último: las registraciones ya se pueblan (el fallo se
   movió de la aserción de nombres a `tool_worker.rs:489`). Con sondas
   `eprintln!` temporales en `crates/envd/src/worker.rs` se observa que
   `cancel_dispatch` **sí** llega a `Killed(… stage: ProcessGroupKill)`, pero
   después **no** vuelve `dispatch_with_progress` ni se imprime
   `cancel-replacement-ok`: la tarea de dispatch se queda colgada tras el
   `killpg`, así que nunca se emite `ExtHostEvent::Aborted` y el test agota los
   5 s. La hipótesis viva es que al morir el hijo no se cierra el waiter pendiente
   del canal CONTROL.
   Copia limpia de `worker.rs` antes de las sondas: `/tmp/claude-0/worker.rs.bak2`
   (y `worker.rs.bak` de una ronda anterior). **Restaurar antes de commitear.**
2. Fallos no tocados por falta de dirección del usuario:
   `omp-driver forced_choice_capability` (drift de catálogo),
   `omp-shell-builtins touch` ×2 (atime), y 5 fallos previstos del motor de
   edición en `omp-tools`.
3. Cinco decisiones de `runtime_spec` pendientes del usuario: dueño de producción
   de telemetría; `CostClass::Paid` para `omp.provider.request`; contradicción de
   durabilidad de provider; piso de fase de mount/unmount de MCP; nombre de
   `omp.mcp.invoke`.
4. Ofrecido pero no aprobado: que el plazo del freeze respete
   `config.spawn_timeout` en vez de los 10 s fijos, y hacer visibles los fallos
   de extensión contenidos.

### Defecto estructural documentado (no corregido)

`ExtHostSupervisor` contiene los fallos de extensión en cinco puntos de
`crates/envd/src/worker.rs` (≈ líneas 1661, 1729, 1767, 1781, 2019/2050), cada
uno con `tracing::warn!` + `continue`. El resultado es que `spawn` y
`activate_control_hosts` devuelven `Ok` aunque una extensión haya fallado por
completo — y en tests sin subscriber de tracing el fallo es invisible.

## 4. Restricciones — qué NO tocar

- **Desviaciones bloqueadas respecto de `pi`** (decisiones del dueño; "pi hace X"
  nunca es argumento): solo CPython embebido para extensiones; shell bash
  in-process con coreutils propios, jamás `/bin/bash` ni `$PATH`; las ediciones
  de archivos pasan por la autoridad de documentos de envd (CAS versionado +
  rebase 3-way difuso); roster de herramientas fijo y mínimo con identidades
  versionadas (`name@rev`) y ciclo de vida de un solo stream; providers-as-data
  (condicionales por nombre de modelo en `.rs` son rechazo de revisión); prompts
  con plantillas scribe de slots con bandas; plano de control con regímenes
  apilados; solo tokio + rayon; candle para audio/ML local.
- **Secciones de rendimiento de `AGENTS.md`** (disciplina de asignación, tamaño
  de tipos, async/iteradores, doctrina de renderizado TUI): son de carga y no se
  pueden debilitar, resumir ni saltar en refactors.
- **Config de usuario** vive en `~/.o2` (`CONFIG_DIR_NAME = ".o2"`, fijado por un
  test). Nunca bajo el data dir, `~/.omp` ni XDG config.
- **`PYO3_CONFIG_FILE`** en `.cargo/config.toml` es obligatorio antes de que
  cargo resuelva `pyo3`; es la única excepción upstream a la regla `OMP_*`.
- **Nunca** revertir ni hacer `git checkout` de ediciones del usuario; si el
  árbol cambió bajo los pies, hay que adaptarse a él.
- **Nunca** reescribir historia ya publicada de la rama; los commits ya enviados
  se dejan como están.
- **Autoría de git** en esta rama: `Claude <noreply@anthropic.com>`.
- **Nunca** abrir un pull request salvo petición explícita del usuario.
- Las sondas `eprintln!` de depuración son temporales: se restauran desde el
  backup antes de cualquier commit.

Aplica estas reglas y este estado a partir de ahora sin pedir que se lo repitan.
Before continuing, re-read docs/research/upstream-gap-closure-brief.md and docs/research/upstream-gap-closure.md.
