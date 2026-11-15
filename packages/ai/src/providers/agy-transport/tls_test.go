//go:build protolegacy

package main

import (
	"bytes"
	"context"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/mldsa"
	"crypto/rand"
	"crypto/rsa"
	"crypto/tls"
	"crypto/x509"
	"crypto/x509/pkix"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"math/big"
	"net"
	"strings"
	"testing"
	"time"

	utls "github.com/refraction-networking/utls"
)

const tlsTestTimeout = 10 * time.Second

// A successful advertisement is insufficient: each server accepts only one
// group, so unsupported key generation, HRR, or shared-secret derivation makes
// a consumer connection fail before any application bytes can be exchanged.
func TestDialTLSNegotiatesEveryConsumerGroup(t *testing.T) {
	certificate, roots, _ := tlsTestIdentity(t, tls.ECDSAWithP256AndSHA256)
	spec, err := (&utls.Fingerprinter{}).RawClientHello(consumerClientHello)
	if err != nil {
		t.Fatal(err)
	}
	initialShares := make(map[utls.CurveID]bool)
	for _, extension := range spec.Extensions {
		if shares, ok := extension.(*utls.KeyShareExtension); ok {
			for _, share := range shares.KeyShares {
				initialShares[share.Group] = true
			}
		}
	}
	for _, group := range []tls.CurveID{
		tls.X25519MLKEM768, tls.SecP256r1MLKEM768, tls.SecP384r1MLKEM1024,
		tls.X25519, tls.CurveP256, tls.CurveP384, tls.CurveP521,
	} {
		t.Run(group.String(), func(t *testing.T) {
			config := tlsTestConfig(certificate, tls.VersionTLS13)
			config.CurvePreferences = []tls.CurveID{group}
			client, server := tlsTestRoundTrip(t, roots, config, "http/1.1")
			if client.CurveID != utls.CurveID(group) || server.CurveID != group {
				t.Fatalf("negotiated group: client=%v server=%v, want %v", client.CurveID, server.CurveID, group)
			}
			wantRetry := !initialShares[utls.CurveID(group)]
			if client.HelloRetryRequest != wantRetry || server.HelloRetryRequest != wantRetry {
				t.Fatalf("HRR: client=%v server=%v, want %v for selected group %v", client.HelloRetryRequest, server.HelloRetryRequest, wantRetry, group)
			}
		})
	}
}

// Pin both the certificate key and its sole permitted CertificateVerify scheme.
// ML-DSA roots also sign the leaf, exercising X.509 verification as well as the
// TLS signature path. Classical rows cover distinct key/hash implementations.
func TestDialTLSVerifiesConsumerTLS13Signatures(t *testing.T) {
	for _, scheme := range []tls.SignatureScheme{
		tls.MLDSA44, tls.MLDSA65, tls.MLDSA87,
		tls.PSSWithSHA256, tls.PSSWithSHA384, tls.PSSWithSHA512,
		tls.ECDSAWithP256AndSHA256, tls.ECDSAWithP384AndSHA384,
		tls.ECDSAWithP521AndSHA512, tls.Ed25519,
	} {
		t.Run(scheme.String(), func(t *testing.T) {
			certificate, roots, signatures := tlsTestIdentity(t, scheme)
			client, _ := tlsTestRoundTrip(t, roots, tlsTestConfig(certificate, tls.VersionTLS13), "http/1.1")
			leaf := client.PeerCertificates[0]
			if leaf.SignatureAlgorithm != certificate.Leaf.SignatureAlgorithm {
				t.Fatalf("verified certificate signature = %v, want %v", leaf.SignatureAlgorithm, certificate.Leaf.SignatureAlgorithm)
			}
			select {
			case options := <-signatures:
				wantHash := tlsTestSignatureHash(scheme)
				if options.HashFunc() != wantHash {
					t.Fatalf("handshake signer hash = %v, want %v", options.HashFunc(), wantHash)
				}
				if scheme == tls.PSSWithSHA256 || scheme == tls.PSSWithSHA384 || scheme == tls.PSSWithSHA512 {
					pss, ok := options.(*rsa.PSSOptions)
					if !ok || pss.SaltLength != rsa.PSSSaltLengthEqualsHash {
						t.Fatalf("handshake did not use TLS RSA-PSS options: %#v", options)
					}
				}
			default:
				t.Fatal("successful handshake never invoked the certificate signer")
			}
			if params, ok := tlsTestMLDSAParameters(scheme); ok {
				public, ok := leaf.PublicKey.(*mldsa.PublicKey)
				if !ok || public.Parameters() != params {
					t.Fatalf("verified peer did not use %v public key: %T", params, leaf.PublicKey)
				}
			}
		})
	}
}

func TestDialTLSVerifiesConsumerTLS12PKCS1Signatures(t *testing.T) {
	for _, scheme := range []tls.SignatureScheme{tls.PKCS1WithSHA256, tls.PKCS1WithSHA384, tls.PKCS1WithSHA512} {
		t.Run(scheme.String(), func(t *testing.T) {
			certificate, roots, signatures := tlsTestIdentity(t, scheme)
			tlsTestRoundTrip(t, roots, tlsTestConfig(certificate, tls.VersionTLS12), "http/1.1")
			select {
			case options := <-signatures:
				if _, pss := options.(*rsa.PSSOptions); pss || options.HashFunc() != tlsTestSignatureHash(scheme) {
					t.Fatalf("TLS 1.2 did not use the required PKCS#1 hash: %#v", options)
				}
			default:
				t.Fatal("TLS 1.2 handshake never invoked the required signer")
			}
		})
	}
}

// An endpoint constrained to any advertised TLS 1.2 ECDHE cipher must remain
// usable; AES key sizes, GCM/CBC, ChaCha20, and RSA/ECDSA authentication differ.
func TestDialTLSNegotiatesConsumerTLS12Ciphers(t *testing.T) {
	ecdsaCertificate, ecdsaRoots, _ := tlsTestIdentity(t, tls.ECDSAWithP256AndSHA256)
	rsaCertificate, rsaRoots, _ := tlsTestIdentity(t, tls.PSSWithSHA256)
	for _, row := range []struct {
		cipher uint16
		rsa    bool
	}{
		{tls.TLS_ECDHE_ECDSA_WITH_AES_128_GCM_SHA256, false},
		{tls.TLS_ECDHE_ECDSA_WITH_AES_256_GCM_SHA384, false},
		{tls.TLS_ECDHE_ECDSA_WITH_CHACHA20_POLY1305_SHA256, false},
		{tls.TLS_ECDHE_ECDSA_WITH_AES_128_CBC_SHA, false},
		{tls.TLS_ECDHE_ECDSA_WITH_AES_256_CBC_SHA, false},
		{tls.TLS_ECDHE_RSA_WITH_AES_128_GCM_SHA256, true},
		{tls.TLS_ECDHE_RSA_WITH_AES_256_GCM_SHA384, true},
		{tls.TLS_ECDHE_RSA_WITH_CHACHA20_POLY1305_SHA256, true},
		{tls.TLS_ECDHE_RSA_WITH_AES_128_CBC_SHA, true},
		{tls.TLS_ECDHE_RSA_WITH_AES_256_CBC_SHA, true},
	} {
		t.Run(tls.CipherSuiteName(row.cipher), func(t *testing.T) {
			certificate, roots := ecdsaCertificate, ecdsaRoots
			if row.rsa {
				certificate, roots = rsaCertificate, rsaRoots
			}
			config := tlsTestConfig(certificate, tls.VersionTLS12)
			config.CipherSuites = []uint16{row.cipher}
			config.CurvePreferences = []tls.CurveID{tls.X25519}
			client, server := tlsTestRoundTrip(t, roots, config, "http/1.1")
			if client.CipherSuite != row.cipher || server.CipherSuite != row.cipher {
				t.Fatalf("negotiated cipher: client=%#x server=%#x, want %#x", client.CipherSuite, server.CipherSuite, row.cipher)
			}
		})
	}
}

func TestDialTLSRejectsUntrustedCA(t *testing.T) {
	certificate, _, _ := tlsTestIdentity(t, tls.ECDSAWithP256AndSHA256)
	address, result := tlsTestListen(t, func(connection net.Conn) tlsTestServerResult {
		server := tls.Server(connection, tlsTestConfig(certificate, tls.VersionTLS13))
		return tlsTestServerResult{err: server.Handshake()}
	})
	ctx, cancel := context.WithTimeout(t.Context(), tlsTestTimeout)
	defer cancel()
	client := &transport{hello: consumerClientHello, roots: x509.NewCertPool()}
	connection, err := client.dialTLS(ctx, "tcp", address)
	if connection != nil {
		connection.Close()
		t.Fatal("untrusted server returned a usable connection")
	}
	var unknownAuthority x509.UnknownAuthorityError
	if !errors.As(err, &unknownAuthority) {
		t.Fatalf("want certificate authority verification failure, got %v", err)
	}
	if server := tlsTestAwait(t, result); server.err == nil {
		t.Fatal("server completed a handshake with an untrusted certificate")
	}
}

func TestDialTLSCancellationInterruptsInFlightHandshake(t *testing.T) {
	receivedHello := make(chan struct{})
	address, result := tlsTestListen(t, func(connection net.Conn) tlsTestServerResult {
		var header [5]byte
		if _, err := io.ReadFull(connection, header[:]); err != nil {
			return tlsTestServerResult{err: err}
		}
		if header[0] != 22 {
			return tlsTestServerResult{err: fmt.Errorf("first record is not a handshake: %d", header[0])}
		}
		if _, err := io.CopyN(io.Discard, connection, int64(binary.BigEndian.Uint16(header[3:]))); err != nil {
			return tlsTestServerResult{err: err}
		}
		close(receivedHello)
		// Never send ServerHello. Cancellation must close the socket rather
		// than waiting for the server or the outer safety timeout.
		_, err := io.Copy(io.Discard, connection)
		return tlsTestServerResult{err: err}
	})
	ctx, cancel := context.WithCancel(t.Context())
	defer cancel()
	dialed := make(chan error, 1)
	go func() {
		client := &transport{hello: consumerClientHello, roots: x509.NewCertPool()}
		connection, err := client.dialTLS(ctx, "tcp", address)
		if connection != nil {
			connection.Close()
		}
		dialed <- err
	}()
	select {
	case <-receivedHello:
	case err := <-dialed:
		t.Fatalf("dial ended before in-flight cancellation: %v", err)
	case <-time.After(tlsTestTimeout):
		t.Fatal("server did not receive ClientHello")
	}
	cancel()
	select {
	case err := <-dialed:
		if !errors.Is(err, context.Canceled) {
			t.Fatalf("want context cancellation, got %v", err)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("cancellation did not interrupt TLS handshake")
	}
	if server := tlsTestAwait(t, result); server.err != nil {
		t.Fatalf("canceled client did not close its TCP connection cleanly: %v", server.err)
	}
}

func TestDialTLSRejectsActuallyNegotiatedHTTP2(t *testing.T) {
	certificate, roots, _ := tlsTestIdentity(t, tls.ECDSAWithP256AndSHA256)
	config := tlsTestConfig(certificate, tls.VersionTLS13)
	config.NextProtos = []string{"h2"}
	address, result := tlsTestListen(t, func(connection net.Conn) tlsTestServerResult {
		server := tls.Server(connection, config)
		err := server.Handshake()
		return tlsTestServerResult{state: server.ConnectionState(), err: err}
	})
	ctx, cancel := context.WithTimeout(t.Context(), tlsTestTimeout)
	defer cancel()
	// Exercise the supported reference override path. An h2-only server with
	// the unmodified h1 hello can fall back to no ALPN in Go and does not prove
	// the transport's negotiated-protocol rejection branch.
	client := &transport{hello: tlsTestHTTP2Hello(t), roots: roots}
	connection, err := client.dialTLS(ctx, "tcp", address)
	if connection != nil {
		connection.Close()
		t.Fatal("transport exposed an HTTP/2 connection to the HTTP/1 caller")
	}
	if err == nil || !strings.Contains(err.Error(), "unsupported application protocol") {
		t.Fatalf("want negotiated-protocol rejection after a valid handshake, got %v", err)
	}
	server := tlsTestAwait(t, result)
	if server.err != nil || !server.state.HandshakeComplete || server.state.NegotiatedProtocol != "h2" {
		t.Fatalf("HTTP/2 was not actually negotiated: state=%+v error=%v", server.state, server.err)
	}
}

func TestDialTLSAllowsHTTP1WithoutALPN(t *testing.T) {
	certificate, roots, _ := tlsTestIdentity(t, tls.ECDSAWithP256AndSHA256)
	config := tlsTestConfig(certificate, tls.VersionTLS13)
	config.NextProtos = nil
	tlsTestRoundTrip(t, roots, config, "")
}

func tlsTestConfig(certificate tls.Certificate, version uint16) *tls.Config {
	return &tls.Config{
		Certificates:           []tls.Certificate{certificate},
		MinVersion:             version,
		MaxVersion:             version,
		NextProtos:             []string{"http/1.1"},
		SessionTicketsDisabled: true,
	}
}

type tlsTestServerResult struct {
	state tls.ConnectionState
	err   error
}

// Loopback literals bypass ProxyFromEnvironment without changing process-wide
// environment/cache state. All peers and keys exist only for the current test.
func tlsTestListen(t *testing.T, serve func(net.Conn) tlsTestServerResult) (string, <-chan tlsTestServerResult) {
	t.Helper()
	listener, err := net.Listen("tcp4", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan tlsTestServerResult, 1)
	done := make(chan struct{})
	go func() {
		defer close(done)
		connection, err := listener.Accept()
		if err != nil {
			result <- tlsTestServerResult{err: err}
			return
		}
		defer connection.Close()
		stop := context.AfterFunc(ctx, func() { connection.Close() })
		defer stop()
		if err := connection.SetDeadline(time.Now().Add(tlsTestTimeout)); err != nil {
			result <- tlsTestServerResult{err: err}
			return
		}
		result <- serve(connection)
	}()
	t.Cleanup(func() {
		cancel()
		listener.Close()
		select {
		case <-done:
		case <-time.After(tlsTestTimeout):
			t.Error("local TLS peer did not stop")
		}
	})
	return listener.Addr().String(), result
}

func tlsTestAwait(t *testing.T, result <-chan tlsTestServerResult) tlsTestServerResult {
	t.Helper()
	select {
	case server := <-result:
		return server
	case <-time.After(tlsTestTimeout):
		t.Fatal("local TLS peer did not finish")
		return tlsTestServerResult{}
	}
}

func tlsTestRoundTrip(t *testing.T, roots *x509.CertPool, config *tls.Config, protocol string) (utls.ConnectionState, tls.ConnectionState) {
	t.Helper()
	request := []byte("consumer application bytes\x00\xff")
	response := []byte("server application response\xff\x00")
	address, result := tlsTestListen(t, func(connection net.Conn) tlsTestServerResult {
		server := tls.Server(connection, config)
		if err := server.Handshake(); err != nil {
			return tlsTestServerResult{err: err}
		}
		state := server.ConnectionState()
		got := make([]byte, len(request))
		if _, err := io.ReadFull(server, got); err != nil {
			return tlsTestServerResult{state: state, err: err}
		}
		if !bytes.Equal(got, request) {
			return tlsTestServerResult{state: state, err: fmt.Errorf("server application bytes = %x, want %x", got, request)}
		}
		_, err := server.Write(response)
		return tlsTestServerResult{state: state, err: err}
	})
	ctx, cancel := context.WithTimeout(t.Context(), tlsTestTimeout)
	defer cancel()
	clientTransport := &transport{hello: consumerClientHello, roots: roots}
	connection, err := clientTransport.dialTLS(ctx, "tcp", address)
	if err != nil {
		t.Fatalf("consumer TLS handshake: %v", err)
	}
	defer connection.Close()
	if err := connection.SetDeadline(time.Now().Add(tlsTestTimeout)); err != nil {
		t.Fatal(err)
	}
	client, ok := connection.(*utls.UConn)
	if !ok {
		t.Fatalf("dialTLS returned %T, cannot inspect negotiated connection", connection)
	}
	state := client.ConnectionState()
	if !state.HandshakeComplete || state.Version != config.MinVersion || state.DidResume {
		t.Fatalf("unexpected client handshake: complete=%v version=%#x resumed=%v", state.HandshakeComplete, state.Version, state.DidResume)
	}
	if len(state.VerifiedChains) == 0 || len(state.PeerCertificates) == 0 {
		t.Fatal("connection did not verify the peer certificate chain")
	}
	if !bytes.Equal(state.PeerCertificates[0].Raw, config.Certificates[0].Certificate[0]) {
		t.Fatal("verified certificate differs from the pinned server certificate")
	}
	if _, err := connection.Write(request); err != nil {
		t.Fatal(err)
	}
	got := make([]byte, len(response))
	if _, err := io.ReadFull(connection, got); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(got, response) {
		t.Fatalf("client application bytes = %x, want %x", got, response)
	}
	server := tlsTestAwait(t, result)
	if server.err != nil {
		t.Fatalf("server exchange: %v", server.err)
	}
	if !server.state.HandshakeComplete || server.state.Version != config.MinVersion || server.state.DidResume {
		t.Fatalf("unexpected server handshake: complete=%v version=%#x resumed=%v", server.state.HandshakeComplete, server.state.Version, server.state.DidResume)
	}
	if state.NegotiatedProtocol != protocol || server.state.NegotiatedProtocol != protocol {
		t.Fatalf("ALPN: client=%q server=%q, want %q", state.NegotiatedProtocol, server.state.NegotiatedProtocol, protocol)
	}
	return state, server.state
}

type tlsTestSigner struct {
	crypto.Signer
	signatures chan crypto.SignerOpts
}

func (signer *tlsTestSigner) Sign(random io.Reader, digest []byte, options crypto.SignerOpts) ([]byte, error) {
	signature, err := signer.Signer.Sign(random, digest, options)
	if err == nil {
		select {
		case signer.signatures <- options:
		default:
		}
	}
	return signature, err
}

func tlsTestIdentity(t *testing.T, scheme tls.SignatureScheme) (tls.Certificate, *x509.CertPool, <-chan crypto.SignerOpts) {
	t.Helper()
	rootKey, algorithm := tlsTestKey(t, scheme)
	leafKey, _ := tlsTestKey(t, scheme)
	now := time.Now()
	rootTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(1),
		Subject:      pkix.Name{CommonName: "AGY local test CA"},
		NotBefore:    now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
		IsCA: true, BasicConstraintsValid: true,
		KeyUsage:           x509.KeyUsageCertSign,
		SignatureAlgorithm: algorithm,
	}
	rootDER, err := x509.CreateCertificate(rand.Reader, rootTemplate, rootTemplate, rootKey.Public(), rootKey)
	if err != nil {
		t.Fatal(err)
	}
	root, err := x509.ParseCertificate(rootDER)
	if err != nil {
		t.Fatal(err)
	}
	leafTemplate := &x509.Certificate{
		SerialNumber: big.NewInt(2),
		Subject:      pkix.Name{CommonName: "AGY loopback TLS server"},
		NotBefore:    now.Add(-time.Hour), NotAfter: now.Add(time.Hour),
		IPAddresses:        []net.IP{net.ParseIP("127.0.0.1")},
		KeyUsage:           x509.KeyUsageDigitalSignature,
		ExtKeyUsage:        []x509.ExtKeyUsage{x509.ExtKeyUsageServerAuth},
		SignatureAlgorithm: algorithm,
	}
	leafDER, err := x509.CreateCertificate(rand.Reader, leafTemplate, root, leafKey.Public(), rootKey)
	if err != nil {
		t.Fatal(err)
	}
	leaf, err := x509.ParseCertificate(leafDER)
	if err != nil {
		t.Fatal(err)
	}
	roots := x509.NewCertPool()
	roots.AddCert(root)
	signatures := make(chan crypto.SignerOpts, 1)
	return tls.Certificate{
		Certificate:                  [][]byte{leafDER},
		PrivateKey:                   &tlsTestSigner{Signer: leafKey, signatures: signatures},
		SupportedSignatureAlgorithms: []tls.SignatureScheme{scheme},
		Leaf:                         leaf,
	}, roots, signatures
}

func tlsTestKey(t *testing.T, scheme tls.SignatureScheme) (crypto.Signer, x509.SignatureAlgorithm) {
	t.Helper()
	var key crypto.Signer
	var algorithm x509.SignatureAlgorithm
	var err error
	switch scheme {
	case tls.MLDSA44, tls.MLDSA65, tls.MLDSA87:
		params, _ := tlsTestMLDSAParameters(scheme)
		key, err = mldsa.GenerateKey(params)
		algorithm = map[tls.SignatureScheme]x509.SignatureAlgorithm{
			tls.MLDSA44: x509.MLDSA44, tls.MLDSA65: x509.MLDSA65, tls.MLDSA87: x509.MLDSA87,
		}[scheme]
	case tls.PSSWithSHA256, tls.PSSWithSHA384, tls.PSSWithSHA512:
		key, err = rsa.GenerateKey(rand.Reader, 2048)
		algorithm = map[tls.SignatureScheme]x509.SignatureAlgorithm{
			tls.PSSWithSHA256: x509.SHA256WithRSAPSS, tls.PSSWithSHA384: x509.SHA384WithRSAPSS, tls.PSSWithSHA512: x509.SHA512WithRSAPSS,
		}[scheme]
	case tls.PKCS1WithSHA256, tls.PKCS1WithSHA384, tls.PKCS1WithSHA512:
		key, err = rsa.GenerateKey(rand.Reader, 2048)
		algorithm = map[tls.SignatureScheme]x509.SignatureAlgorithm{
			tls.PKCS1WithSHA256: x509.SHA256WithRSA, tls.PKCS1WithSHA384: x509.SHA384WithRSA, tls.PKCS1WithSHA512: x509.SHA512WithRSA,
		}[scheme]
	case tls.ECDSAWithP256AndSHA256:
		key, err = ecdsa.GenerateKey(elliptic.P256(), rand.Reader)
		algorithm = x509.ECDSAWithSHA256
	case tls.ECDSAWithP384AndSHA384:
		key, err = ecdsa.GenerateKey(elliptic.P384(), rand.Reader)
		algorithm = x509.ECDSAWithSHA384
	case tls.ECDSAWithP521AndSHA512:
		key, err = ecdsa.GenerateKey(elliptic.P521(), rand.Reader)
		algorithm = x509.ECDSAWithSHA512
	case tls.Ed25519:
		_, key, err = ed25519.GenerateKey(rand.Reader)
		algorithm = x509.PureEd25519
	default:
		t.Fatalf("unsupported test signature scheme %v", scheme)
	}
	if err != nil {
		t.Fatal(err)
	}
	return key, algorithm
}

func tlsTestMLDSAParameters(scheme tls.SignatureScheme) (mldsa.Parameters, bool) {
	switch scheme {
	case tls.MLDSA44:
		return mldsa.MLDSA44(), true
	case tls.MLDSA65:
		return mldsa.MLDSA65(), true
	case tls.MLDSA87:
		return mldsa.MLDSA87(), true
	default:
		return mldsa.Parameters{}, false
	}
}

func tlsTestSignatureHash(scheme tls.SignatureScheme) crypto.Hash {
	switch scheme {
	case tls.PSSWithSHA256, tls.PKCS1WithSHA256, tls.ECDSAWithP256AndSHA256:
		return crypto.SHA256
	case tls.PSSWithSHA384, tls.PKCS1WithSHA384, tls.ECDSAWithP384AndSHA384:
		return crypto.SHA384
	case tls.PSSWithSHA512, tls.PKCS1WithSHA512, tls.ECDSAWithP521AndSHA512:
		return crypto.SHA512
	default:
		return crypto.Hash(0)
	}
}

func tlsTestHTTP2Hello(t *testing.T) []byte {
	t.Helper()
	spec, err := (&utls.Fingerprinter{}).RawClientHello(consumerClientHello)
	if err != nil {
		t.Fatal(err)
	}
	found := false
	for _, extension := range spec.Extensions {
		if alpn, ok := extension.(*utls.ALPNExtension); ok {
			alpn.AlpnProtocols = []string{"h2"}
			found = true
		}
	}
	if !found {
		t.Fatal("consumer hello has no ALPN extension to override")
	}
	connection, peer := net.Pipe()
	defer connection.Close()
	defer peer.Close()
	client := utls.UClient(connection, &utls.Config{ServerName: "localhost", NextProtos: []string{"h2"}}, utls.HelloCustom)
	if err := client.ApplyPreset(spec); err != nil {
		t.Fatal(err)
	}
	if err := client.BuildHandshakeState(); err != nil {
		t.Fatal(err)
	}
	raw := client.HandshakeState.Hello.Raw
	record := make([]byte, 5+len(raw))
	record[0], record[1], record[2] = 22, 3, 1
	binary.BigEndian.PutUint16(record[3:5], uint16(len(raw)))
	copy(record[5:], raw)
	return record
}
