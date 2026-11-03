"""A FUSE filesystem that answers every lookup and read after a delay.

Usage: python3 slow-fuse.py <mountpoint> <delay seconds>

Mounts through fusermount3 (no root), prints "MOUNT_READY" once mounted, and
serves until it is killed or unmounted. Every name in the root directory looks
like a small regular file; lookups and reads sleep <delay> seconds first, so a
caller that touches the mount blocks in the kernel for that long.
"""

import array
import errno
import os
import socket
import stat
import struct
import subprocess
import sys
import time

FUSE_LOOKUP = 1
FUSE_GETATTR = 3
FUSE_OPEN = 14
FUSE_READ = 15
FUSE_INIT = 26
FUSE_DESTROY = 38
FUSE_RELEASE = 18
FUSE_FLUSH = 25
FUSE_OPENDIR = 27
FUSE_RELEASEDIR = 29
FUSE_FORGET = 2
FUSE_BATCH_FORGET = 42
FUSE_ACCESS = 34

mount = sys.argv[1]
delay = float(sys.argv[2])
os.makedirs(mount, exist_ok=True)

parent, child = socket.socketpair()
env = dict(os.environ, _FUSE_COMMFD=str(child.fileno()))
mounter = subprocess.Popen(
    ["fusermount3", "-o", "rw,nosuid,nodev,fsname=slow-fuse,subtype=slow", "--", mount],
    env=env,
    pass_fds=[child.fileno()],
)
child.close()
_, ancillary, _, _ = parent.recvmsg(1, socket.CMSG_SPACE(4))
fds = array.array("i")
for level, kind, data in ancillary:
    if level == socket.SOL_SOCKET and kind == socket.SCM_RIGHTS:
        fds.frombytes(data[:4])
mounter.wait()
if not fds:
    print("MOUNT_FAILED", flush=True)
    sys.exit(1)
fd = fds[0]


def attr(node):
    now = int(time.time())
    mode = (stat.S_IFDIR | 0o700) if node == 1 else (stat.S_IFREG | 0o600)
    size = 4096 if node == 1 else 5
    links = 2 if node == 1 else 1
    return struct.pack(
        "<QQQQQQIIIIIIIIII", node, size, 8, now, now, now, 0, 0, 0, mode, links, os.getuid(), os.getgid(), 0, 4096, 0
    )


def reply(unique, body=b"", err=0):
    os.write(fd, struct.pack("<IiQ", 16 + len(body), -err, unique) + body)


print("MOUNT_READY", flush=True)
try:
    while True:
        data = os.read(fd, 131072)
        if not data:
            break
        _, op, unique, node, _, _, _, _ = struct.unpack_from("<IIQQIIII", data)
        body = data[40:]
        if op == FUSE_INIT:
            reply(unique, struct.pack("<IIIIHHIIHHI7I", 7, 31, 0, 0, 16, 12, 65536, 1, 0, 0, 0, *([0] * 7)))
        elif op == FUSE_LOOKUP:
            time.sleep(delay)
            reply(unique, struct.pack("<QQQQII", 2, 1, 0, 0, 0, 0) + attr(2))
        elif op == FUSE_GETATTR:
            reply(unique, struct.pack("<QII", 0, 0, 0) + attr(node))
        elif op in (FUSE_OPEN, FUSE_OPENDIR):
            reply(unique, struct.pack("<QII", 1, 1, 0))
        elif op == FUSE_READ:
            _, offset, size = struct.unpack_from("<QQI", body)
            time.sleep(delay)
            reply(unique, b"stop\n"[offset : offset + size])
        elif op in (FUSE_RELEASE, FUSE_FLUSH, FUSE_RELEASEDIR, FUSE_ACCESS):
            reply(unique)
        elif op in (FUSE_FORGET, FUSE_BATCH_FORGET):
            pass
        elif op == FUSE_DESTROY:
            reply(unique)
            break
        else:
            reply(unique, err=errno.ENOSYS)
except OSError:
    pass
finally:
    os.close(fd)
