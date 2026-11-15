// agy-transport owns the TLS and HTTP/1.1 connection, not authentication.
// A measured ClientHello is required; fingerprint similarity is not attestation.
package main

import (
	"bufio"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/rand"
	"crypto/subtle"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"

	utls "github.com/refraction-networking/utls"
)

type handshake struct {
	Port  int    `json:"port"`
	Token string `json:"token"`
}
type transport struct {
	hello  []byte
	roots  *x509.CertPool
	dialer net.Dialer
}

func (t *transport) dialTLS(ctx context.Context, network, address string) (net.Conn, error) {
	host, _, err := net.SplitHostPort(address)
	if err != nil {
		return nil, err
	}
	target := &url.URL{Scheme: "https", Host: address}
	proxy, err := http.ProxyFromEnvironment(&http.Request{URL: target})
	if err != nil {
		return nil, err
	}
	destination := address
	if proxy != nil {
		if proxy.Scheme != "http" && proxy.Scheme != "https" {
			return nil, fmt.Errorf("unsupported proxy scheme %q", proxy.Scheme)
		}
		destination = proxy.Host
		if proxy.Port() == "" {
			port := "80"
			if proxy.Scheme == "https" {
				port = "443"
			}
			destination = net.JoinHostPort(proxy.Hostname(), port)
		}
	}
	connection, err := t.dialer.DialContext(ctx, network, destination)
	if err != nil {
		return nil, err
	}
	successful := false
	defer func() {
		if !successful {
			connection.Close()
		}
	}()
	stop := context.AfterFunc(ctx, func() { connection.Close() })
	defer stop()
	if proxy != nil {
		if proxy.Scheme == "https" {
			encrypted := tls.Client(connection, &tls.Config{ServerName: proxy.Hostname(), RootCAs: t.roots, MinVersion: tls.VersionTLS12})
			if err = encrypted.HandshakeContext(ctx); err != nil {
				return nil, err
			}
			connection = encrypted
		}
		request := &http.Request{Method: http.MethodConnect, URL: &url.URL{Opaque: address}, Host: address, Header: make(http.Header)}
		if proxy.User != nil {
			password, _ := proxy.User.Password()
			request.SetBasicAuth(proxy.User.Username(), password)
			request.Header.Set("Proxy-Authorization", request.Header.Get("Authorization"))
			request.Header.Del("Authorization")
		}
		if err = request.Write(connection); err != nil {
			return nil, err
		}
		reader := bufio.NewReader(connection)
		response, readErr := http.ReadResponse(reader, request)
		if readErr != nil {
			return nil, readErr
		}
		if response.StatusCode != http.StatusOK {
			response.Body.Close()
			return nil, fmt.Errorf("proxy CONNECT returned %d", response.StatusCode)
		}
		if reader.Buffered() != 0 {
			return nil, errors.New("unexpected bytes following proxy CONNECT")
		}
	}
	spec, err := (&utls.Fingerprinter{}).RawClientHello(t.hello)
	if err != nil {
		return nil, fmt.Errorf("unsupported reference ClientHello: %w", err)
	}
	client := utls.UClient(connection, &utls.Config{ServerName: host, RootCAs: t.roots, MinVersion: utls.VersionTLS12, NextProtos: []string{"http/1.1"}}, utls.HelloCustom)
	if err = client.ApplyPreset(spec); err != nil {
		return nil, err
	}
	if err = client.HandshakeContext(ctx); err != nil {
		return nil, err
	}
	if protocol := client.ConnectionState().NegotiatedProtocol; protocol != "" && protocol != "http/1.1" {
		return nil, fmt.Errorf("reference negotiated unsupported application protocol %q", protocol)
	}
	successful = true
	return client, nil
}

func main() {
	if err := run(); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
func run() error {
	var profile struct {
		Version    string `json:"version"`
		Changelist string `json:"changelist"`
	}
	if err := json.Unmarshal(clientProfileData, &profile); err != nil {
		return err
	}
	helloFile := flag.String("client-hello", "", "override the embedded AGY 1.5.9 consumer ClientHello with a measured TLS record")
	caFile := flag.String("ca", "", "additional trusted CA PEM for a controlled capture endpoint")
	serialize := flag.Bool("serialize", false, "read one CCPA generation JSON value from stdin and emit the native protobuf JSON dialect")
	userAgent := flag.String("user-agent", "antigravity/cli/"+profile.Version+" (aidev_client; os_type="+runtime.GOOS+"; arch="+runtime.GOARCH+"; cl="+profile.Changelist+"; auth_method=consumer)", "captured CLI User-Agent for this account/profile")
	quotaProject := flag.String("quota-project", "", "explicit user-owned quota project; never inferred from the CCPA project")
	flag.Parse()
	descriptor, err := requestDescriptor()
	if err != nil {
		return err
	}
	if *serialize {
		input, readErr := io.ReadAll(os.Stdin)
		if readErr != nil {
			return readErr
		}
		body, marshalErr := marshalCCPA(descriptor, input)
		if marshalErr != nil {
			return marshalErr
		}
		_, err = os.Stdout.Write(body)
		return err
	}
	hello := consumerClientHello
	if *helloFile != "" {
		hello, err = os.ReadFile(*helloFile)
		if err != nil {
			return err
		}
	}
	spec, err := (&utls.Fingerprinter{}).RawClientHello(hello)
	if err != nil {
		return err
	}
	hasHTTP1 := false
	for _, extension := range spec.Extensions {
		if alpn, ok := extension.(*utls.ALPNExtension); ok {
			hasHTTP1 = len(alpn.AlpnProtocols) == 1 && alpn.AlpnProtocols[0] == "http/1.1"
		}
	}
	if !hasHTTP1 {
		return errors.New("reference must advertise exactly http/1.1, not the AGY updater HTTP/2 profile")
	}
	roots, err := x509.SystemCertPool()
	if err != nil {
		return err
	}
	if *caFile != "" {
		pem := []byte(strings.ReplaceAll(*caFile, "\\n", "\n"))
		if !bytes.Contains(pem, []byte("-----BEGIN CERTIFICATE-----")) {
			var readErr error
			pem, readErr = os.ReadFile(*caFile)
			if readErr != nil {
				return readErr
			}
		}
		if !roots.AppendCertsFromPEM(pem) {
			return errors.New("CA file contains no certificates")
		}
	}
	native := &transport{hello: hello, roots: roots, dialer: net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}}
	pool := &http.Transport{DialTLSContext: native.dialTLS, MaxIdleConns: 100, MaxIdleConnsPerHost: 100, IdleConnTimeout: 90 * time.Second, TLSNextProto: map[string]func(string, *tls.Conn) http.RoundTripper{}, ForceAttemptHTTP2: false}
	// Native CLI process exit releases pooled sockets without close_notify.
	// Let process teardown close them instead of adding a synthetic TLS record.
	secret := make([]byte, 32)
	if _, err = rand.Read(secret); err != nil {
		return err
	}
	token := hex.EncodeToString(secret)
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		return err
	}
	server := &http.Server{ReadHeaderTimeout: 10 * time.Second, Handler: http.HandlerFunc(func(writer http.ResponseWriter, request *http.Request) {
		writer.Header().Set("X-AGY-Bridge-Error", "validation")
		if subtle.ConstantTimeCompare([]byte(request.Header.Get("X-AGY-Bridge-Token")), []byte(token)) != 1 {
			http.Error(writer, "unauthorized local bridge request", 401)
			return
		}
		target, parseErr := url.Parse(request.Header.Get("X-AGY-Bridge-Target"))
		if parseErr != nil || target == nil || target.Scheme != "https" || target.Host == "" || target.User != nil || target.Fragment != "" {
			http.Error(writer, "absolute HTTPS target required", 400)
			return
		}
		encodedHeaders := request.Header.Get("X-AGY-Bridge-Headers")
		var headers [][2]string
		if json.Unmarshal([]byte(encodedHeaders), &headers) != nil {
			http.Error(writer, "invalid outbound headers", 400)
			return
		}
		input, readErr := io.ReadAll(request.Body)
		if readErr != nil {
			http.Error(writer, readErr.Error(), 400)
			return
		}
		var payload io.Reader = bytes.NewReader(input)
		generation := target.Path == "/v1internal:streamGenerateContent" || target.Path == "/v1internal:generateContent"
		streamingGeneration := target.Path == "/v1internal:streamGenerateContent"
		ccpa := strings.HasPrefix(target.Path, "/v1internal:")
		if generation {
			serialized, marshalErr := marshalCCPA(descriptor, input)
			if marshalErr != nil {
				writer.Header().Set("X-AGY-Bridge-Error", "serialization")
				http.Error(writer, marshalErr.Error(), 400)
				return
			}
			input = serialized
			payload = bytes.NewReader(serialized)
			if streamingGeneration {
				payload = io.NopCloser(bytes.NewReader(serialized))
			}
		}
		if !ccpa {
			for index, pair := range headers {
				if strings.EqualFold(pair[0], "Content-Type") && strings.HasPrefix(pair[1], "application/x-www-form-urlencoded") {
					form, parseErr := url.ParseQuery(string(input))
					if parseErr != nil {
						http.Error(writer, "invalid OAuth form body", 400)
						return
					}
					payload = strings.NewReader(form.Encode())
					headers[index][1] = "application/x-www-form-urlencoded"
					break
				}
			}
		}
		outgoing, createErr := http.NewRequestWithContext(request.Context(), request.Method, target.String(), payload)
		if createErr != nil {
			http.Error(writer, createErr.Error(), 400)
			return
		}
		for _, pair := range headers {
			name := pair[0]
			switch strings.ToLower(name) {
			case "host":
				outgoing.Host = pair[1]
			case "content-length", "transfer-encoding", "connection", "proxy-authorization", "proxy-connection":
				http.Error(writer, "transport-owned header", 400)
				return
			default:
				outgoing.Header.Add(name, pair[1])
			}
		}
		if ccpa {
			outgoing.Header.Set("User-Agent", *userAgent)
			if outgoing.Method == http.MethodPost {
				outgoing.Header.Set("Content-Type", "application/json")
			}
			outgoing.Header.Del("Accept")
			outgoing.Header.Del("Accept-Encoding")
			if *quotaProject != "" {
				outgoing.Header.Set("X-Goog-User-Project", *quotaProject)
			}
		}
		writer.Header().Del("X-AGY-Bridge-Error")
		response, roundErr := pool.RoundTrip(outgoing)
		if roundErr != nil {
			writer.Header().Set("X-AGY-Bridge-Error", "transport")
			http.Error(writer, roundErr.Error(), 502)
			return
		}
		defer response.Body.Close()
		hasResponseBody := outgoing.Method != http.MethodHead && response.StatusCode != http.StatusNoContent && response.StatusCode != http.StatusResetContent && response.StatusCode != http.StatusNotModified
		continueStream := streamingGeneration && hasResponseBody && response.StatusCode >= 200 && response.StatusCode < 300
		var body io.Reader = response.Body
		if hasResponseBody && !continueStream && response.Header.Get("Content-Encoding") == "gzip" {
			decompressor, gzipErr := gzip.NewReader(response.Body)
			if gzipErr != nil {
				writer.Header().Set("X-AGY-Bridge-Error", "gzip")
				http.Error(writer, gzipErr.Error(), 502)
				return
			}
			defer decompressor.Close()
			body = decompressor
			response.Header.Del("Content-Encoding")
			response.Header.Del("Content-Length")
		}
		for key, values := range response.Header {
			if continueStream && (strings.EqualFold(key, "Content-Length") || strings.EqualFold(key, "Content-Encoding")) {
				continue
			}
			switch strings.ToLower(key) {
			case "connection", "transfer-encoding", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "upgrade":
				continue
			}
			for _, value := range values {
				writer.Header().Add(key, value)
			}
		}
		writer.Header().Set("X-AGY-Bridge-URL", target.String())
		writer.WriteHeader(response.StatusCode)
		flusher, _ := writer.(http.Flusher)
		if flusher != nil {
			flusher.Flush()
		}
		if continueStream {
			if err := streamCCPA(request.Context(), writer, pool, outgoing, response, input, descriptor); err != nil {
				if request.Context().Err() != nil {
					return
				}
				if writeErr := writeCCPAError(writer, ccpaError{Message: "CCPA stream failed: " + err.Error()}); writeErr != nil {
					panic(http.ErrAbortHandler)
				}
			}
			return
		}
		buffer := make([]byte, 32*1024)
		for {
			n, readErr := body.Read(buffer)
			if n > 0 {
				if _, writeErr := writer.Write(buffer[:n]); writeErr != nil {
					return
				}
				if flusher != nil {
					flusher.Flush()
				}
			}
			if readErr != nil {
				if readErr != io.EOF {
					panic(http.ErrAbortHandler)
				}
				return
			}
		}
	})}
	if err = json.NewEncoder(os.Stdout).Encode(handshake{Port: listener.Addr().(*net.TCPAddr).Port, Token: token}); err != nil {
		listener.Close()
		return err
	}
	go func() { io.Copy(io.Discard, os.Stdin); server.Close() }()
	err = server.Serve(listener)
	if errors.Is(err, http.ErrServerClosed) {
		return nil
	}
	return err
}
