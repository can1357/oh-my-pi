#!/bin/bash
set -euo pipefail

# Start RBE node.
docker run \
    -d \
    --mount type=bind,source=/var/run/docker.sock,target=/var/run/docker.sock \
    --volume /base/data/buildbuddy:/buildbuddy \
    gcr.io/flame-public/buildbuddy-executor-enterprise@sha256:1728288399813d480bb4ae50dd17ed6c10d0f7faf88b9ab7b462f749c76feb13 \
    --executor.docker_socket=/var/run/docker.sock \
    --executor.host_root_directory=/base/data/buildbuddy \
    --executor.app_target=grpcs://oh-my-pi.buildbuddy.io \
    --executor.api_key=$BUILDBUDDY_APIKEY
