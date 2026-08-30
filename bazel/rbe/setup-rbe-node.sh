#!/bin/bash
set -euo pipefail

echo "Upgrading apt deps...";
apt update && apt upgrade -y;

echo "Installing Docker Engine...";
apt install -y ca-certificates curl wget unzip git;
install -m 0755 -d /etc/apt/keyrings;
curl -fsSL https://download.docker.com/linux/ubuntu/gpg -o /etc/apt/keyrings/docker.asc;
chmod a+r /etc/apt/keyrings/docker.asc;

tee /etc/apt/sources.list.d/docker.sources <<EOF
Types: deb
URIs: https://download.docker.com/linux/debian
Suites: $(. /etc/os-release && echo "$VERSION_CODENAME")
Components: stable
Architectures: $(dpkg --print-architecture)
Signed-By: /etc/apt/keyrings/docker.asc
EOF

apt update;
apt install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin;

systemctl enable docker;
systemctl start docker;

mkdir -p /base/data;
chgrp docker -R /base/data;

echo "Docker ready.";
