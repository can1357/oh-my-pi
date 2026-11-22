"""Relay 127.0.0.1:PORT to a unix socket so an offline container reaches the omp auth gateway.

The container runs with `--network none`; the runner bind-mounts an SSH-forwarded
socket that ends at the host's auth gateway, so provider credentials never enter
the container. Usage: gw-relay.py SOCKET PORT
"""

import socket
import sys
import threading


def pump(src: socket.socket, dst: socket.socket) -> None:
    try:
        while data := src.recv(65536):
            dst.sendall(data)
    except OSError:
        pass
    try:
        dst.shutdown(socket.SHUT_WR)
    except OSError:
        pass


def handle(client: socket.socket, path: str) -> None:
    with client:
        upstream = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        with upstream:
            try:
                upstream.connect(path)
            except OSError:
                return
            back = threading.Thread(target=pump, args=(upstream, client), daemon=True)
            back.start()
            pump(client, upstream)
            back.join()


def main() -> None:
    path, port = sys.argv[1], int(sys.argv[2])
    server = socket.create_server(("127.0.0.1", port))
    while True:
        client, _ = server.accept()
        threading.Thread(target=handle, args=(client, path), daemon=True).start()


if __name__ == "__main__":
    main()
