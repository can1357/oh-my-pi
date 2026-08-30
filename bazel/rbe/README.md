
## Bazel RBE

This directory defines some resources for Bazel Remote Build Execution (RBE).

- [`apko.yaml`](./apko.yaml) [apko](https://github.com/chainguard-dev/apko) config for building the RBE base image.
- [`setup-rbe-node.sh`](./setup-rbe-node.sh), which is run on a new instance (debian) to prepare RBE.
- [`start-rbe-node.sh`](./start-rbe-node.sh), which starts the RBE node via Docker.

> [!NOTE]
> API keys are needed for BuildBuddy to use `start-rbe-node.sh`. Define `BUILDBUDDY_APIKEY=...` before running.
