#!/usr/bin/env bash
# Idempotent bazel-remote cache bootstrap. Run ON the CI host (root), with the
# two YAML files from this directory next to it:
#
#   ./setup.sh
#
# What it does (safe to re-run; every step is guarded or apply-based):
#   1. Generates a self-signed CA + server cert (SANs: in-cluster service DNS
#      plus the host's private admin name) under $STATE_DIR.
#   2. Creates/updates secrets:
#        bazel-cache/bazel-remote-tls    - server cert + key (kubernetes.io/tls)
#        bazel-cache/bazel-remote-auth   - htpasswd (bcrypt, user `ci`)
#        arc-runners/bazel-remote-ci     - BAZEL_REMOTE_USER / BAZEL_REMOTE_PASSWORD
#   3. Applies bazel-remote.yaml (namespace, PVC, Deployment, ClusterIP service).
#   4. Appends the bazel-cache:9092 egress rule to the arc-runners
#      runner-egress-lockdown NetworkPolicy (guarded, via runner-egress-patch.yaml).
#   5. Removes the retired public exposure if present (NodePort service +
#      firewalld 30992/tcp): the cache is strictly cluster-internal; nothing
#      about this infrastructure is reachable from — or committed to — the
#      public repo beyond the CA certificate.
#   6. Prints the CA cert (commit it as infra/bazel-remote/ca.crt).
#
# Env knobs:
#   KUBECONFIG   kubeconfig path                  [/etc/rancher/k3s/k3s.yaml]
#   STATE_DIR    where CA/certs/password persist  [/root/bazel-remote-cache]
#   ADMIN_SAN    optional extra DNS SAN for host-side debugging [can.internal]
#   CERT_DAYS    CA + server cert lifetime        [3650]
set -euo pipefail

export KUBECONFIG="${KUBECONFIG:-/etc/rancher/k3s/k3s.yaml}"
STATE_DIR="${STATE_DIR:-/root/bazel-remote-cache}"
ADMIN_SAN="${ADMIN_SAN:-can.internal}"
CERT_DAYS="${CERT_DAYS:-3650}"
NS=bazel-cache
ARC_NS=arc-runners

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
for f in bazel-remote.yaml runner-egress-patch.yaml; do
  [ -f "$here/$f" ] || { echo "missing $here/$f (run from a checkout of infra/bazel-remote/)" >&2; exit 1; }
done
for bin in kubectl openssl jq; do
  command -v "$bin" >/dev/null || { echo "missing required tool: $bin" >&2; exit 1; }
done
if ! command -v htpasswd >/dev/null; then
  echo "==> htpasswd missing; installing httpd-tools/apache2-utils"
  if command -v dnf >/dev/null; then dnf install -y httpd-tools
  elif command -v apt-get >/dev/null; then apt-get update && apt-get install -y apache2-utils
  else echo "cannot install htpasswd (no dnf/apt-get); install it manually" >&2; exit 1
  fi
fi

mkdir -p "$STATE_DIR"
chmod 700 "$STATE_DIR"
cd "$STATE_DIR"

# --- 1. CA + server certificate -------------------------------------------
if [ ! -s ca.crt ] || [ ! -s ca.key ]; then
  echo "==> [1/6] generating CA"
  openssl req -x509 -newkey rsa:4096 -sha256 -nodes -days "$CERT_DAYS" \
    -keyout ca.key -out ca.crt \
    -subj "/CN=bazel-remote-ca" \
    -addext "basicConstraints=critical,CA:TRUE" \
    -addext "keyUsage=critical,keyCertSign,cRLSign"
  chmod 600 ca.key
else
  echo "==> [1/6] reusing existing CA ($STATE_DIR/ca.crt)"
fi

if [ ! -s server.crt ] || [ ! -s server.key ]; then
  echo "==> [1/6] generating server certificate"
  openssl req -newkey rsa:4096 -sha256 -nodes \
    -keyout server.key -out server.csr \
    -subj "/CN=bazel-remote.${NS}.svc.cluster.local"
  cat > server.ext <<EOF
basicConstraints=CA:FALSE
keyUsage=critical,digitalSignature,keyEncipherment
extendedKeyUsage=serverAuth
subjectAltName=DNS:bazel-remote.${NS}.svc.cluster.local,DNS:bazel-remote.${NS}.svc,DNS:${ADMIN_SAN}
EOF
  openssl x509 -req -sha256 -days "$CERT_DAYS" \
    -in server.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -extfile server.ext -out server.crt
  rm -f server.csr server.ext
  chmod 600 server.key
else
  echo "==> [1/6] reusing existing server certificate"
fi

# --- 2. Credentials + secrets ----------------------------------------------
if [ ! -s ci-password ]; then
  echo "==> [2/6] generating ci password"
  openssl rand -base64 24 | tr -d '/+=' > ci-password
  chmod 600 ci-password
else
  echo "==> [2/6] reusing existing ci password"
fi
CI_PASSWORD="$(cat ci-password)"
htpasswd -Bbc htpasswd ci "$CI_PASSWORD" >/dev/null 2>&1
chmod 600 htpasswd

echo "==> [2/6] applying secrets"
kubectl create namespace "$NS" --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NS" create secret tls bazel-remote-tls \
  --cert=server.crt --key=server.key \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$NS" create secret generic bazel-remote-auth \
  --from-file=htpasswd=htpasswd \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl -n "$ARC_NS" create secret generic bazel-remote-ci \
  --from-literal=BAZEL_REMOTE_USER=ci \
  --from-literal=BAZEL_REMOTE_PASSWORD="$CI_PASSWORD" \
  --dry-run=client -o yaml | kubectl apply -f -

# --- 3. bazel-remote itself -------------------------------------------------
echo "==> [3/6] applying bazel-remote.yaml"
kubectl apply -f "$here/bazel-remote.yaml"

# --- 4. Runner egress: allow bazel-cache:9092 -------------------------------
echo "==> [4/6] patching runner-egress-lockdown (bazel-cache:9092)"
if kubectl -n "$ARC_NS" get networkpolicy runner-egress-lockdown -o json \
  | jq -e '.spec.egress[].to[]? | select(.namespaceSelector.matchLabels["kubernetes.io/metadata.name"] == "bazel-cache")' >/dev/null; then
  echo "    egress rule already present; skipping"
else
  kubectl -n "$ARC_NS" patch networkpolicy runner-egress-lockdown \
    --type=json --patch-file="$here/runner-egress-patch.yaml"
fi

# --- 5. Retire any previous public exposure -----------------------------------
echo "==> [5/6] ensuring the cache is cluster-internal only"
if kubectl -n "$NS" get service bazel-remote-public >/dev/null 2>&1; then
  kubectl -n "$NS" delete service bazel-remote-public
  echo "    removed retired NodePort service bazel-remote-public"
fi
if firewall-cmd --permanent --query-port=30992/tcp >/dev/null 2>&1; then
  firewall-cmd --permanent --remove-port=30992/tcp
  firewall-cmd --reload
  echo "    closed retired firewalld port 30992/tcp"
fi

# --- 6. Operator hand-off -----------------------------------------------------
echo "==> [6/6] done. Manual follow-ups:"
echo
echo "1. Commit the CA cert into the repo as infra/bazel-remote/ca.crt"
echo "   (this script cannot commit; the cert is public, only ca.key is secret):"
echo "   --- $STATE_DIR/ca.crt ---"
cat ca.crt
echo "   --- end ca.crt ---"
echo
echo "2. Runner pods need 'envFrom: [{secretRef: {name: bazel-remote-ci}}]'."
echo "   infra/reload-runner.sh now inserts this into the ARC values file on the"
echo "   next reload; to wire it without an image reload, add under"
echo "   template.spec.containers[0].envFrom in /root/arc-omp-values.yaml:"
echo "         - secretRef:"
echo "             name: bazel-remote-ci"
echo "   then re-run the helm upgrade from infra/docs/04-arc-and-caching.md §3."
echo
echo "Endpoint: grpcs://bazel-remote.${NS}.svc.cluster.local:9092 (in-cluster only)"
