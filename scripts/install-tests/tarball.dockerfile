# Test tarball install (simulates npm publish flow)
# Uses verdaccio as local registry to test full publish/install cycle
FROM debian:bookworm-slim

RUN apt-get update && apt-get install -y curl ca-certificates unzip jq procps build-essential && rm -rf /var/lib/apt/lists/*

# Install bun
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:$PATH"

# Install Rust — the host native addon builds through the default
# cargo/napi-rs backend, so no bazelisk is needed.
RUN curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs | sh -s -- -y --default-toolchain nightly
ENV PATH="/root/.cargo/bin:$PATH"

# Install Node.js (needed for verdaccio and npm)
RUN curl -fsSL https://deb.nodesource.com/setup_22.x | bash - \
    && apt-get install -y nodejs \
    && rm -rf /var/lib/apt/lists/*

# Install verdaccio (local npm registry)
RUN npm install -g verdaccio

# Copy local repo
WORKDIR /repo
COPY . .

# Build the project
RUN bun install --frozen-lockfile
RUN bun --cwd=packages/natives run build

# Create verdaccio config (allow anonymous publish)
RUN mkdir -p /root/.config/verdaccio && cat > /root/.config/verdaccio/config.yaml <<'EOF'
storage: /verdaccio/storage
auth:
  htpasswd:
    file: /verdaccio/htpasswd
    max_users: -1
uplinks:
  npmjs:
    url: https://registry.npmjs.org/
packages:
  '@oh-my-pi/*':
    access: $all
    publish: $all
    unpublish: $all
  '**':
    access: $all
    publish: $all
    unpublish: $all
    proxy: npmjs
publish:
  allow_offline: true
security:
  api:
    legacy: true
log: { type: stdout, format: pretty, level: warn }
EOF

# Create storage and htpasswd
RUN mkdir -p /verdaccio/storage && touch /verdaccio/htpasswd

# Create .npmrc with auth token
RUN echo '//localhost:4873/:_authToken="fake-token"' > /root/.npmrc

# Create script to resolve workspace:* versions and publish
RUN cat > /repo/scripts/publish-local.sh <<'SCRIPT'
#!/bin/bash
set -e

REGISTRY="http://localhost:4873"
PACKAGES=(utils natives ai agent tui stats coding-agent)

# Build version map from all package.json files
declare -A VERSION_MAP
for pkg in "${PACKAGES[@]}"; do
    name=$(jq -r '.name' "packages/$pkg/package.json")
    version=$(jq -r '.version' "packages/$pkg/package.json")
    VERSION_MAP[$name]=$version
    echo "Found $name@$version"
done

# Resolve workspace:* in each package.json and publish
for pkg in "${PACKAGES[@]}"; do
    echo ""
    echo "=== Publishing packages/$pkg ==="
    cd "/repo/packages/$pkg"
    
    # Backup original
    cp package.json package.json.bak
    
    # Resolve workspace:* references
    for dep_name in "${!VERSION_MAP[@]}"; do
        dep_version="${VERSION_MAP[$dep_name]}"
        # Replace "workspace:*" with actual version for this dependency
        jq --arg name "$dep_name" --arg ver "$dep_version" \
            '(.dependencies[$name] // empty) |= (if . == "workspace:*" then $ver else . end) |
             (.devDependencies[$name] // empty) |= (if . == "workspace:*" then $ver else . end) |
             (.peerDependencies[$name] // empty) |= (if . == "workspace:*" then $ver else . end)' \
            package.json > package.json.tmp && mv package.json.tmp package.json
    done
    
    # Show what we're publishing
    echo "Dependencies:"
    jq '.dependencies | to_entries[] | select(.value | startswith("@oh-my-pi") or startswith("workspace"))' package.json 2>/dev/null || true
    
    # Publish
    npm publish --registry "$REGISTRY"
    
    # Restore original
    mv package.json.bak package.json
    
    cd /repo
done

echo ""
echo "=== All packages published ==="
SCRIPT
RUN chmod +x /repo/scripts/publish-local.sh

# Start verdaccio and publish all packages
RUN verdaccio --config /root/.config/verdaccio/config.yaml &>/dev/null & \
    sleep 3 && \
    /repo/scripts/publish-local.sh && \
    pkill -f verdaccio

# Clean install in fresh directory
WORKDIR /test
RUN verdaccio --config /root/.config/verdaccio/config.yaml &>/dev/null & \
    sleep 3 && \
    bun add @oh-my-pi/pi-coding-agent --registry http://localhost:4873 && \
    pkill -f verdaccio

# Verify the installed package works
ENV PATH="/test/node_modules/.bin:$PATH"
RUN omp --version
