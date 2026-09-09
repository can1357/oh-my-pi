#!/bin/bash
# warmup.sh — one-shot SSH bring-up for a fresh Google Colab VM.
# Runs INSIDE the Colab notebook (pasted into a code cell or executed
# cell-by-cell by the /colab-ssh command). Takes ~60-90s.
#
# Result: VM joins your tailnet; `ssh -p 2222 root@<hostname>` from any
# tailnet member. Tested on a stock Colab CPU runtime.
#
# Env:
#   AUTHKEY     (required) Tailscale auth key, e.g. tskey-auth-... (ephemeral recommended)
#   SSH_PASS    root password to set            (default: P-K-Haxx1!)
#   TS_HOSTNAME tailnet hostname                (default: colab-pkherdr)
#   TS_VER      tailscale version to install    (default: 1.90.5, known-good)
set -u
SSH_PASS="${SSH_PASS:-P-K-Haxx1!}"
TS_HOSTNAME="${TS_HOSTNAME:-colab-pkherdr}"
TS_VER="${TS_VER:-1.90.5}"
: "${AUTHKEY:?Set AUTHKEY env var to your tskey-auth-... key}"

echo "--- 1/4 sshd: password + root login ---"
echo "root:${SSH_PASS}" | chpasswd && echo "password set"
mkdir -p /run/sshd
sed -i 's/^PasswordAuthentication.*/PasswordAuthentication yes/' /etc/ssh/sshd_config
sed -i 's/^PermitRootLogin.*/PermitRootLogin yes/' /etc/ssh/sshd_config
printf 'PermitRootLogin yes\nPasswordAuthentication yes\n' > /etc/ssh/sshd_config.d/00-colab.conf || true
service ssh restart
sleep 1
sshd -T 2>/dev/null | grep -Ei 'permitrootlogin|passwordauthentication'
# NOTE: stock Colab sshd listens on 2222, not 22. Do NOT change the Port line.

echo "--- 2/4 tailscale install ---"
curl -fsSL "https://pkgs.tailscale.com/stable/tailscale_${TS_VER}_amd64.tgz" -o /tmp/ts.tgz
tar -xzf /tmp/ts.tgz -C /tmp
cp "/tmp/tailscale_${TS_VER}_amd64/tailscale" "/tmp/tailscale_${TS_VER}_amd64/tailscaled" /usr/local/bin/
tailscale --version

echo "--- 3/6 tailscaled (userspace: Colab has no /dev/net/tun) ---"
pkill -x tailscaled 2>/dev/null || true
nohup tailscaled --tun=userspace-networking --state=/tmp/ts.state --socket=/tmp/ts.sock >/tmp/ts.log 2>&1 &
sleep 4

echo "--- 4/6 tailnet join ---"
tailscale --socket=/tmp/ts.sock up --authkey="${AUTHKEY}" --hostname="${TS_HOSTNAME}"
IP4="$(tailscale --socket=/tmp/ts.sock ip -4 | head -1)"
echo "TAILNET_IP=${IP4}"
tailscale --socket=/tmp/ts.sock status | head -5

echo "--- 5/6 oh-my-pk (prebuilt binary) ---"
if [ "${INSTALL_OMPK:-1}" = "1" ]; then
  # Download prebuilt standalone binary with embedded native Rust addons
  curl -fsSL https://oh-my-pk.pkking.computer/install.sh | sh -s -- --binary
  mkdir -p /root/.local/bin
  ln -sf /root/.local/bin/oh-my-pk /usr/local/bin/oh-my-pk 2>/dev/null || true
  ln -sf /root/.local/bin/omp /usr/local/bin/omp 2>/dev/null || true
  ln -sf /root/.local/bin/ompk /usr/local/bin/ompk 2>/dev/null || true
  rm -f /root/.bun/bin/oh-my-pk /root/.bun/bin/omp /root/.bun/bin/ompk 2>/dev/null || true
  if ! grep -q '/root/.local/bin' /root/.bashrc 2>/dev/null; then
    echo 'export PATH="/root/.local/bin:$PATH"' >> /root/.bashrc
  fi
  export PATH="/root/.local/bin:$PATH"
  ompk --version 2>&1 | head -2
else
  echo "INSTALL_OMPK=0, skipping"
fi

echo "--- 6/6 login reminder banner ---"
cat > /etc/motd <<EOF
==============================================
 Colab ephemeral VM - tailnet SSH active
 Reconnect:  ssh -p 2222 root@${TS_HOSTNAME}
   (this session IP: ${IP4})
 Agent ready: ompk / oh-my-pk
 VM dies with the Colab session (idle ~90min)
==============================================
EOF
# Colab's sshd sets PrintMotd no and its PAM stack never prints /etc/motd,
# so hook interactive shells instead (verified: shows on real SSH logins).
if ! grep -q COLAB_BANNER_SHOWN /root/.bashrc 2>/dev/null; then
cat >> /root/.bashrc <<'HOOK'
# colab-ssh login reminder
if [ -n "$SSH_CONNECTION" ] && [ -z "$COLAB_BANNER_SHOWN" ]; then cat /etc/motd 2>/dev/null; export COLAB_BANNER_SHOWN=1; fi
HOOK
fi
echo ""
echo "=============================================="
echo " CONNECT:  ssh -p 2222 root@${TS_HOSTNAME}"
echo "   (or root@${IP4}, password as configured)"
echo "=============================================="
