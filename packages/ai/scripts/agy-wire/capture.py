#!/usr/bin/env python3
"""Loopback-only TLS/HTTP capture endpoint. Never forwards traffic upstream.

Requires h2==4.3.0. Captures contain exact request bytes and may contain credentials;
use an isolated reference profile and keep the output directory out of Git.
Route fixtures map request paths to {status, headers, body} responses. Missing
routes return 501, never a fabricated successful provider response.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import socket
import socketserver
import ssl
import threading
import time

import h2.config
import h2.connection
import h2.events


def atomic_json(path, value):
    temporary = path.with_suffix(".tmp")
    descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(descriptor, "w", encoding="utf-8") as output:
        json.dump(value, output, indent=2)
        output.write("\n")
    temporary.replace(path)


class CaptureServer(socketserver.ThreadingTCPServer):
    allow_reuse_address = True
    daemon_threads = True

    def __init__(self, args, context, routes):
        self.args = args
        self.context = context
        self.routes = routes
        self.lock = threading.Lock()
        self.count = 0
        self.route_positions = {}
        super().__init__(("127.0.0.1", args.port), CaptureHandler)

    def allocate(self):
        with self.lock:
            self.count += 1
            return self.count


class CaptureHandler(socketserver.BaseRequestHandler):
    def handle(self):
        server = self.server
        number = server.allocate()
        self.path = Path(server.args.out) / f"connection-{number:04d}.json"
        self.record = {
            "schemaVersion": 1,
            "label": server.args.label,
            "referenceVersion": server.args.version,
            "binarySha256": server.args.binary_sha256,
            "startedAt": time.time(),
            "peer": list(self.client_address),
            "local": list(self.request.getsockname()),
            "clientRecordsHex": "",
            "clientPlaintextHex": "",
            "requests": [],
            "attestation": "not-observed-local-capture",
        }
        self.wire = bytearray()
        self.plaintext = bytearray()
        self.request.settimeout(server.args.timeout)
        try:
            self.capture()
        except (OSError, ssl.SSLError, ValueError, h2.exceptions.H2Error) as error:
            self.record["error"] = str(error)
        finally:
            self.record["closedAt"] = time.time()
            self.save()

    def save(self):
        self.record["clientRecordsHex"] = self.wire.hex()
        self.record["clientPlaintextHex"] = self.plaintext.hex()
        atomic_json(self.path, self.record)

    def response(self, path):
        fixture = self.server.routes.get(path)
        if fixture is None:
            return 501, [("content-type", "application/json")], b'{"error":"No capture response fixture for this path"}'
        if "responses" in fixture:
            with self.server.lock:
                position = self.server.route_positions.get(path, 0)
                self.server.route_positions[path] = position + 1
            responses = fixture["responses"]
            if position >= len(responses):
                return 501, [("content-type", "application/json")], b'{"error":"Capture response sequence exhausted"}'
            fixture = responses[position]
        body = fixture.get("body", "")
        if not isinstance(body, str):
            body = json.dumps(body, separators=(",", ":"))
        return int(fixture.get("status", 200)), fixture.get("headers", [("content-type", "application/json")]), body.encode("utf-8")

    def capture(self):
        # Peek without consuming TLS bytes. A CONNECT proxy preserves the actual
        # client handshake; unlike a forwarding HTTP proxy it does not originate it.
        if self.request.recv(1, socket.MSG_PEEK) != b"\x16":
            connect = bytearray()
            while not connect.endswith(b"\r\n\r\n"):
                byte = self.request.recv(1)
                if not byte or len(connect) >= 65536:
                    raise ValueError("Incomplete or oversized CONNECT request")
                connect.extend(byte)
            first = bytes(connect).split(b"\r\n", 1)[0].split(b" ")
            if len(first) != 3 or first[0] != b"CONNECT":
                raise ValueError("Only TLS or HTTP CONNECT is accepted")
            self.record["connectAuthority"] = first[1].decode("ascii")
            self.request.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")
        incoming, outgoing = ssl.MemoryBIO(), ssl.MemoryBIO()
        tls = self.server.context.wrap_bio(incoming, outgoing, server_side=True)

        def flush():
            while outgoing.pending:
                self.request.sendall(outgoing.read())

        def receive():
            data = self.request.recv(65536)
            if not data:
                incoming.write_eof()
                return False
            self.wire.extend(data)
            incoming.write(data)
            return True

        while True:
            try:
                tls.do_handshake()
                flush()
                break
            except ssl.SSLWantReadError:
                flush()
                if not receive():
                    raise ValueError("Client closed during TLS handshake")
        self.record["alpn"] = tls.selected_alpn_protocol()
        self.record["tlsVersion"] = tls.version()
        self.record["cipher"] = list(tls.cipher())
        protocol = None
        streams = {}
        http1 = bytearray()
        if tls.selected_alpn_protocol() == "h2":
            protocol = h2.connection.H2Connection(config=h2.config.H2Configuration(client_side=False, header_encoding="utf-8"))
            protocol.initiate_connection()
            tls.write(protocol.data_to_send())
            flush()
        while True:
            try:
                data = tls.read(65536)
                if not data:
                    break
            except ssl.SSLWantReadError:
                flush()
                if not receive():
                    break
                continue
            except ssl.SSLZeroReturnError:
                break
            self.plaintext.extend(data)
            if protocol is not None:
                for event in protocol.receive_data(data):
                    if isinstance(event, h2.events.RequestReceived):
                        streams[event.stream_id] = {"headers": [list(pair) for pair in event.headers], "body": bytearray()}
                    elif isinstance(event, h2.events.DataReceived):
                        streams[event.stream_id]["body"].extend(event.data)
                        protocol.acknowledge_received_data(event.flow_controlled_length, event.stream_id)
                    elif isinstance(event, h2.events.StreamEnded):
                        request = streams.pop(event.stream_id)
                        request["bodyHex"] = bytes(request.pop("body")).hex()
                        request["streamId"] = event.stream_id
                        self.record["requests"].append(request)
                        path = dict(request["headers"])[":path"]
                        status, headers, body = self.response(path)
                        protocol.send_headers(event.stream_id, [(":status", str(status)), *headers, ("content-length", str(len(body)))], end_stream=not body)
                        # Fixtures are deliberately bounded to one initial window.
                        if len(body) > 65535:
                            raise ValueError("Response fixture exceeds initial HTTP/2 flow-control window")
                        for offset in range(0, len(body), protocol.max_outbound_frame_size):
                            end = offset + protocol.max_outbound_frame_size
                            protocol.send_data(event.stream_id, body[offset:end], end_stream=end >= len(body))
                outbound = protocol.data_to_send()
                if outbound:
                    tls.write(outbound)
            else:
                http1.extend(data)
                while b"\r\n\r\n" in http1:
                    header_end = http1.index(b"\r\n\r\n") + 4
                    rows = bytes(http1[:header_end - 4]).split(b"\r\n")
                    method, path, version = rows[0].decode("ascii").split(" ")
                    headers = [row.decode("latin1").split(":", 1) for row in rows[1:]]
                    headers = [[name, value.lstrip(" \t")] for name, value in headers]
                    fields = {name.lower(): value for name, value in headers}
                    if "transfer-encoding" in fields:
                        if fields["transfer-encoding"].lower() != "chunked" or "content-length" in fields:
                            raise ValueError("Unsupported or ambiguous HTTP/1 transfer framing")
                        position = header_end
                        chunks = []
                        complete = False
                        while b"\r\n" in http1[position:]:
                            line_end = http1.index(b"\r\n", position)
                            size_text = bytes(http1[position:line_end]).split(b";", 1)[0]
                            if not size_text or any(c not in b"0123456789abcdefABCDEF" for c in size_text):
                                raise ValueError("Invalid HTTP/1 chunk size")
                            size = int(size_text, 16)
                            position = line_end + 2
                            if size == 0:
                                if http1[position:position + 2] == b"\r\n":
                                    position += 2
                                    complete = True
                                elif b"\r\n\r\n" in http1[position:]:
                                    position = http1.index(b"\r\n\r\n", position) + 4
                                    complete = True
                                break
                            if len(http1) < position + size + 2:
                                break
                            if http1[position + size:position + size + 2] != b"\r\n":
                                raise ValueError("Invalid HTTP/1 chunk terminator")
                            chunks.append(bytes(http1[position:position + size]))
                            position += size + 2
                        if not complete:
                            break
                        body = b"".join(chunks)
                        del http1[:position]
                    else:
                        length = int(fields.get("content-length", "0"))
                        if length < 0:
                            raise ValueError("Negative content length")
                        if len(http1) < header_end + length:
                            break
                        body = bytes(http1[header_end:header_end + length])
                        del http1[:header_end + length]
                    self.record["requests"].append({"method": method, "path": path, "version": version, "headers": headers, "bodyHex": body.hex()})
                    status, response_headers, response_body = self.response(path)
                    response = f"HTTP/1.1 {status} Capture\r\n".encode("ascii")
                    for name, value in [*response_headers, ("content-length", str(len(response_body)))]:
                        response += f"{name}: {value}\r\n".encode("latin1")
                    tls.write(response + b"\r\n" + response_body)
            flush()
            self.save()
        if streams or http1:
            self.record["incompleteRequests"] = True


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--port", type=int, default=18443)
    parser.add_argument("--cert", required=True)
    parser.add_argument("--key", required=True)
    parser.add_argument("--out", required=True)
    parser.add_argument("--routes", required=True)
    parser.add_argument("--label", required=True)
    parser.add_argument("--version", default="unknown")
    parser.add_argument("--binary-sha256")
    parser.add_argument("--timeout", type=float, default=30)
    args = parser.parse_args()
    os.umask(0o077)
    Path(args.out).mkdir(mode=0o700, parents=True, exist_ok=True)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.minimum_version = ssl.TLSVersion.TLSv1_2
    context.load_cert_chain(args.cert, args.key)
    context.set_alpn_protocols(["h2", "http/1.1"])
    routes = json.loads(Path(args.routes).read_text(encoding="utf-8"))
    with CaptureServer(args, context, routes) as server:
        print(json.dumps({"listening": list(server.server_address), "out": args.out, "mode": "local-fixtures-no-upstream"}), flush=True)
        try:
            server.serve_forever()
        except KeyboardInterrupt:
            pass


if __name__ == "__main__":
    main()
