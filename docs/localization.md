# Optional Korean UI

English remains the default. Set `OMP_LANG=ko` or `OMP_LANG=ko-KR` to select
Korean interface messages. Unset, empty, English, and unsupported values keep
English.

```sh
OMP_LANG=ko omp
```

In PowerShell:

```powershell
$env:OMP_LANG = "ko"
omp
```

Inside the interactive TUI, `/language ko` and `/language en` switch languages
through the existing restart path. Completion offers both choices. Restart
preserves launch options and resumes the current session if it has been saved.
Missing, unsupported, or extra arguments show usage without restarting.

The choice applies to the restarted process. It does not persist a preference
or change the parent shell. A new independent invocation uses that shell's
`OMP_LANG` value or the default English.

## External pack and release assets

`OMP_LOCALE_DIR` selects a directory containing `ko.json`. Otherwise source and
npm-bundled runs read adjacent assets, while compiled runs read `locales/ko.json`
beside the executable. The normal bundle and compile paths stage the Korean
pack at these locations. The catalog is external rather than statically
included in English JavaScript bundles.

Edit translated values while preserving keys, semantic context suffixes, and
numbered placeholders. Missing entries use English. Invalid or unreadable packs
produce a generic warning and retain English without printing rejected data.
SDK and worker imports perform no pack I/O; application initialization is explicit.

## Scope in 18.14.0

CLI/TUI, authentication prompts, and compatible collaboration UI can use Korean.
Command descriptions and browser labels are evaluated after language selection,
using top-level imports rather than dynamic UI entry imports.

The changed statistics bundle and hosted HTML export remain upstream English
in this proposal. The export loader's URL and integrity manifest are preserved;
this change does not publish a replacement hosted viewer or claim those
surfaces are localized. User/model messages and model-facing tool results are
not translated. Distribution-specific installers and rebuild updaters are
outside this upstream proposal.
