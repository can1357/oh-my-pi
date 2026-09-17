# 01 — Host preparation & single-node k3s cluster

This guide takes a fresh Linux host from bare OS to a **working single-node [k3s](https://k3s.io) cluster** that is ready to run Kata-isolated CI runners. It covers host prerequisites (hardware virtualization, kernel modules, time sync, the nginx port constraint), the exact k3s install, kubeconfig setup, cluster networking (Flannel CNI, CIDRs, CoreDNS), and pod-to-internet egress via host firewalld NAT.

Read [README.md](README.md) first for the overall architecture and the placeholder/redaction table. When this guide is done, continue with **[02-kata-runtime.md](02-kata-runtime.md)** to install the Kata Containers runtime and register the `kata-qemu` RuntimeClass.

All configs below are copied from the live reference host and then redacted. Substitute the placeholders from the [README redaction table](README.md#redaction--placeholders) (notably `<CI_HOST>`, `<PUBLIC_IP>`, `<EXT_IFACE>`, `<TAILNET_IP>`) with your own values. CIDRs (`10.42.0.0/16`, `10.43.0.0/16`), the CoreDNS IP (`10.43.0.10`), and version numbers are kept as-is.

The reference host is a bare-metal **CentOS Stream 10** box, 32 vCPU / 125 GiB RAM, AMD CPU, running **k3s `v1.35.5+k3s1`** (bundled containerd `v2.2.3-k3s1`). Commands are shown for RHEL-family (`dnf` / `firewalld`); adapt package and firewall commands for your distro.

---

## 1. Host prerequisites

### 1.1 Hardware virtualization / KVM

Every CI job boots its own QEMU/KVM microVM, so the host **must** expose working KVM. On bare metal this means VT-x (Intel) or AMD-V (AMD) enabled in firmware; on a VM you need working *nested* virtualization.

Check the CPU virtualization flag (`vmx` = Intel, `svm` = AMD) and that the KVM device and modules are present:

```bash
# CPU supports virtualization? (non-zero count = yes)
grep -E -c '(vmx|svm)' /proc/cpuinfo

# which flavor
grep -E -om1 '(vmx|svm)' /proc/cpuinfo      # reference host prints: svm  (AMD)
lscpu | grep -i virtualization

# /dev/kvm must exist and be accessible
ls -l /dev/kvm                              # crw-rw-rw-. 1 root kvm 10, 232 ... /dev/kvm

# KVM kernel modules loaded
lsmod | grep -E '^kvm'                      # kvm_amd ... kvm   (or kvm_intel on Intel)
```

On the reference host this yields:

```
$ ls -l /dev/kvm
crw-rw-rw-. 1 root kvm 10, 232 /dev/kvm

$ lsmod | grep -E '^kvm'
kvm_amd               237568  99
kvm                  1470464  78 kvm_amd
```

The module loads automatically when the CPU flag is present; if `/dev/kvm` is missing, load it explicitly and persist it:

```bash
modprobe kvm_amd        # or: modprobe kvm_intel
echo kvm_amd > /etc/modules-load.d/kvm.conf
```

On Debian/Ubuntu you can instead run `kvm-ok` (from the `cpu-checker` package); on RHEL-family the checks above are the equivalent.

> Kata also needs the `vhost_vsock` and `vhost_net` modules for its agent vsock channel and VM networking. Those are part of the Kata runtime setup and are covered in [02-kata-runtime.md](02-kata-runtime.md); the KVM availability above is the only virtualization prerequisite for this guide.

### 1.2 Kernel modules and sysctls for k3s networking

k3s needs the `br_netfilter` and `overlay` modules and a couple of sysctls so that bridged pod traffic is seen by iptables and so the host can route/NAT pod traffic. The k3s systemd unit loads the modules on start (`ExecStartPre=-/sbin/modprobe br_netfilter` / `overlay`) and the installer sets the sysctls, but set them explicitly so they survive reboots and are correct before install:

```bash
cat >/etc/modules-load.d/k3s.conf <<'EOF'
br_netfilter
overlay
EOF
modprobe br_netfilter overlay

cat >/etc/sysctl.d/90-k3s.conf <<'EOF'
net.ipv4.ip_forward = 1
net.bridge.bridge-nf-call-iptables = 1
EOF
sysctl --system
```

Verify (these are the live values on the reference host):

```
$ sysctl net.ipv4.ip_forward net.bridge.bridge-nf-call-iptables
net.ipv4.ip_forward = 1
net.bridge.bridge-nf-call-iptables = 1

$ lsmod | grep -E 'br_netfilter|overlay'
br_netfilter           36864  0
bridge                409600  1 br_netfilter
overlay               229376  49
```

`net.ipv4.ip_forward = 1` is what lets the host route (and NAT — see [section 5](#5-cluster-networking-cni-cidrs--nat-egress)) pod traffic out to the internet.

### 1.3 SELinux

The reference host runs SELinux in **Permissive** mode:

```
$ getenforce
Permissive
```

The k3s installer installs an SELinux policy (`k3s-selinux`) when SELinux is Enforcing on RHEL-family hosts, so Enforcing also works; Permissive is used here to keep the Kata/QEMU + virtio-fs path unencumbered during bring-up. Pick one consistently — if you run Enforcing, make sure `container-selinux` / `k3s-selinux` are installed (the k3s installer pulls them).

### 1.4 Base packages

The k3s install script needs only `curl`; everything else (its own containerd, CNI, kubectl) is bundled. Make sure the host has current packages and the basics:

```bash
dnf -y update
dnf -y install curl tar iptables
```

> Do **not** pre-install a separate containerd/Docker for k3s to use — k3s ships and manages its own containerd v2. (A separate Docker install can coexist for *building* the runner image; that is covered in [03-runner-image.md](03-runner-image.md).)

### 1.5 Time synchronization

Clock skew breaks TLS to the Kubernetes API and to GitHub. Keep an NTP client running. The reference host uses `chrony`:

```bash
dnf -y install chrony
systemctl enable --now chronyd
timedatectl                       # "System clock synchronized: yes", "NTP service: active"
```

### 1.6 The nginx port constraint (why Traefik and servicelb are disabled)

The reference host **also runs nginx**, which owns ports 80 and 443:

```
$ systemctl is-active nginx
active

$ ss -tlnp | grep -E ':80 |:443 '
LISTEN 0 511 0.0.0.0:80   0.0.0.0:* users:(("nginx",...))
LISTEN 0 511 0.0.0.0:443  0.0.0.0:* users:(("nginx",...))
```

A default k3s install would deploy **Traefik** (an ingress controller that wants :80/:443) and **servicelb** (the Klipper load-balancer, which binds `LoadBalancer` service ports directly on the host). Both would collide with nginx. We therefore disable both at install time (next section). k3s' own API server listens on **:6443**, which does not conflict with nginx, so the cluster is fully functional without those two add-ons.

> Note on swap: the reference host has swap enabled (`/dev/md1`, 16 GiB) and k3s runs fine with it. If you prefer the upstream-Kubernetes convention of swap-off, disabling it is also supported — it is not required here.

---

## 2. Install k3s

Install k3s as a single-node server, pinning the version and disabling Traefik and servicelb. This is the exact configuration baked into the reference host's systemd unit:

```bash
curl -sfL https://get.k3s.io | \
  INSTALL_K3S_VERSION=v1.35.5+k3s1 \
  INSTALL_K3S_EXEC="server --disable=traefik --disable=servicelb" \
  sh -
```

What each piece does:

| Token | Meaning |
| --- | --- |
| `INSTALL_K3S_VERSION=v1.35.5+k3s1` | Pin the exact k3s release (reproducible installs; omit to track the stable channel). |
| `server` | Run this node as a **control-plane + worker** (single-node cluster — it both schedules and runs pods). |
| `--disable=traefik` | Do **not** deploy the bundled Traefik ingress controller, so nothing tries to bind host :80/:443 (owned by nginx — see [1.6](#16-the-nginx-port-constraint-why-traefik-and-servicelb-are-disabled)). |
| `--disable=servicelb` | Do **not** deploy Klipper servicelb, so `LoadBalancer` services do not bind host ports. Runners need no inbound `LoadBalancer`; the ARC listener reaches GitHub via **outbound** long-poll. |

Everything else is left at k3s defaults *on purpose* — those defaults are what the rest of this doc set relies on:

| Default (not overridden) | Value | Why we keep it |
| --- | --- | --- |
| CNI | **Flannel**, VXLAN backend | Simple single-node overlay; see [section 5](#5-cluster-networking-cni-cidrs--nat-egress). |
| `--cluster-cidr` (pod network) | `10.42.0.0/16` | Pod IP range. |
| `--service-cidr` (service network) | `10.43.0.0/16` | ClusterIP range. |
| `--cluster-dns` (CoreDNS) | `10.43.0.10` | In-cluster DNS resolver. |
| Container runtime | bundled **containerd v2** | Kata is wired into *this* containerd in [02-kata-runtime.md](02-kata-runtime.md). |

Because we do not pass `--node-ip` / `--flannel-iface`, k3s auto-detects the host's primary interface and uses its address as the node IP (the public IPv4 on the reference host). If your host has multiple NICs, set `--node-ip` / `--flannel-iface` explicitly.

The installer writes the systemd unit `/etc/systemd/system/k3s.service`. On the reference host its `ExecStart` is exactly:

```ini
ExecStartPre=-/sbin/modprobe br_netfilter
ExecStartPre=-/sbin/modprobe overlay
ExecStart=/usr/local/bin/k3s \
    server \
	'--disable=traefik' \
	'--disable=servicelb' \
```

There is **no** `/etc/rancher/k3s/config.yaml` on the host — the two `--disable` flags above are the *only* customization; everything else is the default set listed above.

Enable and check the service:

```bash
systemctl enable --now k3s
systemctl status k3s --no-pager
journalctl -u k3s -f          # follow startup logs until the node is Ready
```

Confirm the version:

```
$ k3s --version
k3s version v1.35.5+k3s1 (6a4781ad)
go version go1.25.9
```

---

## 3. kubeconfig

k3s writes an admin kubeconfig to `/etc/rancher/k3s/k3s.yaml`. Point `kubectl` at it:

```bash
export KUBECONFIG=/etc/rancher/k3s/k3s.yaml
# persist for future shells:
echo 'export KUBECONFIG=/etc/rancher/k3s/k3s.yaml' >> ~/.bashrc
```

The file targets the local API server over loopback (TLS material redacted):

```yaml
apiVersion: v1
clusters:
- cluster:
    certificate-authority-data: <REDACTED>
    server: https://127.0.0.1:6443
  name: default
contexts:
- context:
    cluster: default
    user: default
  name: default
current-context: default
kind: Config
users:
- name: default
  user:
    client-certificate-data: <REDACTED>
    client-key-data: <REDACTED>
```

> This kubeconfig embeds cluster-admin credentials. Treat the file as a secret (`chmod 600`, root-only). To administer the cluster from another machine, copy the file and replace `127.0.0.1` with the host's reachable address — on the reference host that is done over **Tailscale** (`tailscale0`), so the API server is never exposed on the public interface. Do not commit this file.

Quick check that the client can talk to the server:

```bash
kubectl version            # client + server versions
kubectl cluster-info
```

---

## 4. Verify the node and system pods

Wait until the node reports `Ready`:

```bash
kubectl get nodes -o wide
```

Reference output (redacted — `<CI_HOST>` is the hostname, `<PUBLIC_IP>` the auto-detected node IP):

```
NAME        STATUS   ROLES                  AGE   VERSION        INTERNAL-IP   EXTERNAL-IP   OS-IMAGE                      KERNEL-VERSION                  CONTAINER-RUNTIME
<CI_HOST>   Ready    control-plane,master   ...   v1.35.5+k3s1   <PUBLIC_IP>   <none>        CentOS Stream 10 (Coughlan)   7.0.10-1.el10.elrepo.x86_64     containerd://2.2.3-k3s1
```

Then confirm the core system pods are running:

```bash
kubectl get pods -A
```

You should see the k3s base set in `kube-system` (these are what remain after disabling Traefik and servicelb):

```
NAMESPACE     NAME                                       READY   STATUS    RESTARTS   AGE
kube-system   coredns-<hash>                             1/1     Running   0          ...
kube-system   local-path-provisioner-<hash>              1/1     Running   0          ...
kube-system   metrics-server-<hash>                      1/1     Running   0          ...
```

`local-path-provisioner` is the default storage class (used later for the RustFS cache PVC in [04-arc-and-caching.md](04-arc-and-caching.md)); `coredns` is cluster DNS; `metrics-server` backs `kubectl top`. There is intentionally **no** `traefik` or `svclb-*` pod.

---

## 5. Cluster networking (CNI, CIDRs & NAT egress)

### 5.1 Flannel CNI

k3s installs Flannel and writes its CNI config to `/var/lib/rancher/k3s/agent/etc/cni/net.d/10-flannel.conflist`. This file is generated by k3s — copied here verbatim (no secrets; nothing to redact):

```json
{
  "name":"cbr0",
  "cniVersion":"1.0.0",
  "plugins":[
    {
      "type":"flannel",
      "delegate":{
        "hairpinMode":true,
        "forceAddress":true,
        "isDefaultGateway":true
      }
    },
    {
      "type":"portmap",
      "capabilities":{
        "portMappings":true
      }
    },
    {
      "type":"bandwidth",
      "capabilities":{
        "bandwidth":true
      }
    }
  ]
}
```

- `flannel` delegates to the `bridge` plugin (`cbr0`), with `isDefaultGateway` so the pod's default route points at the node — this is the path pod egress takes to reach the host's NAT.
- `portmap` and `bandwidth` are standard chained plugins (host-port mapping and per-pod bandwidth shaping).
- The backend is Flannel's default **VXLAN** (we did not override it at install). On a single node, pod-to-pod traffic stays on the local bridge.

### 5.2 Address ranges

The cluster uses the k3s defaults — keep these as-is (they are referenced throughout the doc set):

| Range | CIDR | Notes |
| --- | --- | --- |
| Pod network (cluster-cidr) | `10.42.0.0/16` | Single node carves a `/24` from this: `kubectl get node -o jsonpath='{.items[0].spec.podCIDR}'` → `10.42.0.0/24`. |
| Service network (service-cidr) | `10.43.0.0/16` | ClusterIP services. |
| CoreDNS service IP | `10.43.0.10` | Cluster DNS resolver (`kube-dns` Service). |

Confirm CoreDNS:

```
$ kubectl -n kube-system get svc kube-dns
NAME       TYPE        CLUSTER-IP   EXTERNAL-IP   PORT(S)                  AGE
kube-dns   ClusterIP   10.43.0.10   <none>        53/UDP,53/TCP,9153/TCP   ...
```

### 5.3 Pod-to-internet egress via host firewalld NAT

Runner microVMs need outbound internet (to reach GitHub, fetch toolchains, etc.) but the host must **not** expose the cluster on its public interface. The path is:

```
pod (10.42.0.0/16) --default route--> cbr0/flannel --> host routing --> firewalld masquerade (SNAT) --> <EXT_IFACE> --> internet (as <PUBLIC_IP>)
```

This relies on `net.ipv4.ip_forward = 1` (set in [1.2](#12-kernel-modules-and-sysctls-for-k3s-networking)) plus firewalld **masquerade** (SNAT) and **forwarding** on the public zone. On the reference host the external interface lives in the default `public` zone with masquerade enabled:

```
$ firewall-cmd --list-all
public (default, active)
  target: default
  icmp-block-inversion: no
  interfaces: <EXT_IFACE>
  sources:
  services: cockpit dhcpv6-client http https ssh
  ports:
  protocols:
  forward: yes
  masquerade: yes
  forward-ports:
  source-ports:
  icmp-blocks:
  rich rules:
```

The two lines that make pod egress work are **`masquerade: yes`** (SNAT pod source IPs to `<PUBLIC_IP>` on the way out) and **`forward: yes`** (allow routing between interfaces). The `services` list (`ssh`, `http`, `https`, `cockpit`, `dhcpv6-client`) is the host's own inbound allow-list and is unrelated to pod egress — note that `http`/`https` here are for the **host nginx**, not k3s.

The pod and service CIDRs (plus the Tailscale admin interface) are placed in the **trusted** zone so intra-cluster and admin traffic is accepted without per-rule firewalling:

```
$ firewall-cmd --zone=trusted --list-all
trusted (active)
  target: ACCEPT
  interfaces: tailscale0
  sources: 10.42.0.0/16 10.43.0.0/16
  forward: yes
  masquerade: no
  ...
```

```
$ firewall-cmd --get-active-zones
public (default)
  interfaces: <EXT_IFACE>
trusted
  interfaces: tailscale0
  sources: 10.42.0.0/16 10.43.0.0/16
docker        # br-* bridges from the separate Docker stack (unrelated to k3s)
  interfaces: ...
```

To reproduce this NAT setup on a fresh host (replace `<EXT_IFACE>` with your public NIC, e.g. `eth0`):

```bash
# external interface in the public zone with NAT + forwarding
firewall-cmd --permanent --zone=public --change-interface=<EXT_IFACE>
firewall-cmd --permanent --zone=public --add-masquerade
firewall-cmd --permanent --zone=public --add-forward          # firewalld >= 0.9

# trust intra-cluster traffic (pod + service CIDRs) and the Tailscale admin iface
firewall-cmd --permanent --zone=trusted --add-source=10.42.0.0/16
firewall-cmd --permanent --zone=trusted --add-source=10.43.0.0/16
firewall-cmd --permanent --zone=trusted --change-interface=tailscale0

firewall-cmd --reload
```

Verify masquerade and forwarding are live:

```
$ firewall-cmd --query-masquerade
yes
$ firewall-cmd --query-forward
yes
```

> This is host-level NAT only. A second, finer-grained layer — the `runner-egress-lockdown` Kubernetes **NetworkPolicy** — restricts *which* destinations runner pods may reach (it blocks `<PUBLIC_IP>`, the tailnet `100.64.0.0/10`, RFC-1918 ranges, etc., while allowing the public internet and cluster DNS). That policy is part of the runner setup and is documented in [04-arc-and-caching.md](04-arc-and-caching.md).

---

## 6. Verification: DNS & egress smoke test

The system pods being `Running` (section 4) already prove in-cluster networking. To prove **DNS resolution** and **pod-to-internet egress** end to end, run a throwaway pod (delete it afterward):

```bash
# in-cluster DNS: resolve the kubernetes Service via CoreDNS (10.43.0.10)
kubectl run dns-test --image=busybox:1.36 --restart=Never --rm -it -- \
  nslookup kubernetes.default.svc.cluster.local

# external DNS + egress: resolve and reach the internet through host NAT
kubectl run egress-test --image=busybox:1.36 --restart=Never --rm -it -- \
  sh -c 'nslookup github.com && wget -qO- https://api.github.com/zen'
```

Expected: the first command resolves to a `10.43.x.x` ClusterIP; the second resolves a public name and prints a line of text fetched from the internet (proving SNAT/masquerade works). If DNS fails, recheck CoreDNS (`kubectl -n kube-system get pods`); if egress fails, recheck `ip_forward`, `masquerade`, and `forward` from [section 5.3](#53-pod-to-internet-egress-via-host-firewalld-nat).

> On the live reference host, the ARC scale-set **listener** pod (in `arc-systems`) is itself continuous proof of working egress: it stays `Running` only because it can reach GitHub outbound through this exact NAT path.

---

## Next steps

The host now runs a healthy single-node k3s cluster with working networking and NAT egress, and Traefik/servicelb disabled so nginx keeps :80/:443. Continue with:

- **[02-kata-runtime.md](02-kata-runtime.md)** — install Kata Containers, wire it into k3s' bundled containerd, and register the `kata-qemu` RuntimeClass.
- [README.md](README.md) — architecture overview, full component map, and the placeholder/redaction reference.
