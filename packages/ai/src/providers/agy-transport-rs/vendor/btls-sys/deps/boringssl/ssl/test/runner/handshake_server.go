// Copyright 2009 The Go Authors. All rights reserved.
// Use of this source code is governed by a BSD-style
// license that can be found in the LICENSE file.

package runner

import (
	"bytes"
	"crypto"
	"crypto/ecdsa"
	"crypto/ed25519"
	"crypto/elliptic"
	"crypto/rsa"
	"crypto/subtle"
	"crypto/x509"
	"errors"
	"fmt"
	"io"
	"math/big"
	"slices"
	"time"

	"boringssl.googlesource.com/boringssl.git/ssl/test/runner/hpke"
	"boringssl.googlesource.com/boringssl.git/ssl/test/runner/spake2plus"
	"golang.org/x/crypto/cryptobyte"
)

// serverHandshakeState contains details of a server handshake in progress.
// It's discarded once the handshake has completed.
type serverHandshakeState struct {
	c               *Conn
	clientHello     *clientHelloMsg
	hello           *serverHelloMsg
	suite           *cipherSuite
	ellipticOk      bool
	ecdsaOk         bool
	sessionState    *sessionState
	finishedHash    finishedHash
	masterSecret    []byte
	certsFromClient [][]byte
	cert            *Credential
	finishedBytes   []byte
	echHPKEContext  *hpke.Context
	echConfigID     uint8
}

// serverHandshake performs a TLS handshake as a server.
func (c *Conn) serverHandshake() error {
	config := c.config

	// If this is the first server handshake, we generate a random key to
	// encrypt the tickets with.
	config.serverInitOnce.Do(config.serverInit)

	c.sendHandshakeSeq = 0
	c.recvHandshakeSeq = 0

	hs := serverHandshakeState{
		c: c,
	}
	if err := hs.readClientHello(); err != nil {
		return err
	}

	if c.vers >= VersionTLS13 {
		if err := hs.doTLS13Handshake(); err != nil {
			return err
		}
	} else {
		isResume, err := hs.processClientHello()
		if err != nil {
			return err
		}

		// We only implement enough of SSL 3.0 to test that the client doesn't:
		// if negotiated (possibly with the NegotiateVersion bug), we send a
		// ServerHello and look for the resulting client protocol_version alert.
		if c.vers == VersionSSL30 {
			c.writeRecord(recordTypeHandshake, hs.hello.marshal())
			if err := c.flushHandshake(); err != nil {
				return err
			}
			if _, err := c.readHandshake(); err != nil {
				return err
			}
			return errors.New("tls: client did not reject an SSL 3.0 ServerHello")
		}

		// For an overview of TLS handshaking, see https://tools.ietf.org/html/rfc5246#section-7.3
		if isResume {
			// The client has included a session ticket and so we do an abbreviated handshake.
			if err := hs.doResumeHandshake(); err != nil {
				return err
			}
			if err := hs.establishKeys(); err != nil {
				return err
			}
			if c.config.Bugs.RenewTicketOnResume {
				if err := hs.sendSessionTicket(); err != nil {
					return err
				}
			}
			if err := hs.sendFinished(c.firstFinished[:], isResume); err != nil {
				return err
			}
			if err := hs.readFinished(nil, isResume); err != nil {
				return err
			}
			if err := c.ackHandshake(); err != nil {
				return err
			}
			c.didResume = true
		} else {
			// The client didn't include a session ticket, or it wasn't
			// valid so we do a full handshake.
			if err := hs.doFullHandshake(); err != nil {
				return err
			}
			if err := hs.establishKeys(); err != nil {
				return err
			}
			if err := hs.readFinished(c.firstFinished[:], isResume); err != nil {
				return err
			}
			if c.config.Bugs.AlertBeforeFalseStartTest != 0 {
				c.sendAlert(c.config.Bugs.AlertBeforeFalseStartTest)
			}
			if c.config.Bugs.ExpectFalseStart {
				if err := c.readRecord(recordTypeApplicationData); err != nil {
					return fmt.Errorf("tls: peer did not false start: %s", err)
				}
			}
			if err := hs.sendSessionTicket(); err != nil {
				return err
			}
			if err := hs.sendFinished(nil, isResume); err != nil {
				return err
			}
		}

		c.exporterSecret = hs.masterSecret
	}
	c.handshakeComplete = true
	copy(c.clientRandom[:], hs.clientHello.random)
	copy(c.serverRandom[:], hs.hello.random)

	return nil
}

func (c *Conn) shouldSendHelloVerifyRequest() bool {
	if !c.isDTLS {
		return false
	}
	if c.config.Bugs.ForceHelloVerifyRequest {
		return true
	}
	if c.config.Bugs.SkipHelloVerifyRequest {
		return false
	}
	// Don't send HVR for DTLS 1.3; do send it for DTLS <= 1.2.
	return c.vers < VersionTLS13
}

// readClientHello reads a ClientHello message from the client and determines
// the protocol version.
func (hs *serverHandshakeState) readClientHello() error {
	config := hs.c.config
	c := hs.c

	var err error
	hs.clientHello, err = readHandshakeType[clientHelloMsg](c)
	if err != nil {
		return err
	}
	if config.Bugs.CheckClientHello != nil {
		if err = config.Bugs.CheckClientHello(hs.clientHello); err != nil {
			return err
		}
	}
	if size := config.Bugs.RequireClientHelloSize; size != 0 && len(hs.clientHello.raw) != size {
		return fmt.Errorf("tls: ClientHello record size is %d, but expected %d", len(hs.clientHello.raw), size)
	}
	if isAllZero(hs.clientHello.random) {
		// If the client forgets to fill in the client random, it will likely be
		// all zero.
		return errors.New("tls: ClientHello random was all zero")
	}

	if expected := config.Bugs.ExpectOuterServerName; len(expected) != 0 && expected != hs.clientHello.serverName {
		return fmt.Errorf("tls: unexpected ClientHelloOuter server name: wanted %q, got %q", expected, hs.clientHello.serverName)
	}

	// We check this both before and after decrypting ECH.
	if !hs.clientHello.hasGREASEExtension && config.Bugs.ExpectGREASE {
		return errors.New("tls: no GREASE extension found")
	}

	if config.Bugs.ExpectClientECH && hs.clientHello.echOuter == nil {
		return errors.New("tls: expected client to offer ECH")
	}
	if config.Bugs.ExpectNoClientECH && hs.clientHello.echOuter != nil {
		return errors.New("tls: expected client not to offer ECH")
	}

	if echOuter := hs.clientHello.echOuter; echOuter != nil {
		for _, candidate := range config.ServerECHConfigs {
			if candidate.ECHConfig.ConfigID != echOuter.configID {
				continue
			}
			var found bool
			for _, suite := range candidate.ECHConfig.CipherSuites {
				if echOuter.kdfID == suite.KDF && echOuter.aeadID == suite.AEAD {
					found = true
					break
				}
			}
			if !found {
				continue
			}
			info := []byte("tls ech\x00")
			info = append(info, candidate.ECHConfig.Raw...)
			hs.echHPKEContext, err = hpke.SetupBaseReceiverX25519(echOuter.kdfID, echOuter.aeadID, echOuter.enc, candidate.Key, info)
			if err != nil {
				continue
			}
			clientHelloInner, err := hs.decryptClientHello(hs.clientHello)
			if err != nil {
				if _, ok := err.(*echDecryptError); ok {
					continue
				}
				c.sendAlert(alertDecryptError)
				return fmt.Errorf("tls: error decrypting ClientHello: %s", err)
			}
			if config.Bugs.UseInnerSessionWithClientHelloOuter {
				hs.clientHello.pskIdentities = clientHelloInner.pskIdentities
			} else {
				c.echAccepted = true
				hs.clientHello = clientHelloInner
				hs.echConfigID = echOuter.configID
			}
		}
	}

	c.clientVersion = hs.clientHello.vers

	// Use the versions extension if supplied, otherwise use the legacy ClientHello version.
	if len(hs.clientHello.supportedVersions) == 0 {
		if c.isDTLS {
			if hs.clientHello.vers <= VersionDTLS12 {
				hs.clientHello.supportedVersions = append(hs.clientHello.supportedVersions, VersionDTLS12)
			}
			if hs.clientHello.vers <= VersionDTLS10 {
				hs.clientHello.supportedVersions = append(hs.clientHello.supportedVersions, VersionDTLS10)
			}
		} else {
			if hs.clientHello.vers >= VersionTLS12 {
				hs.clientHello.supportedVersions = append(hs.clientHello.supportedVersions, VersionTLS12)
			}
			if hs.clientHello.vers >= VersionTLS11 {
				hs.clientHello.supportedVersions = append(hs.clientHello.supportedVersions, VersionTLS11)
			}
			if hs.clientHello.vers >= VersionTLS10 {
				hs.clientHello.supportedVersions = append(hs.clientHello.supportedVersions, VersionTLS10)
			}
			if hs.clientHello.vers >= VersionSSL30 {
				hs.clientHello.supportedVersions = append(hs.clientHello.supportedVersions, VersionSSL30)
			}
		}
	} else if config.Bugs.ExpectGREASE && !containsGREASE(hs.clientHello.supportedVersions) {
		return errors.New("tls: no GREASE version value found")
	}

	if !c.haveVers {
		if config.Bugs.NegotiateVersion != 0 {
			c.wireVersion = config.Bugs.NegotiateVersion
		} else {
			var found bool
			for _, vers := range hs.clientHello.supportedVersions {
				if _, ok := config.isSupportedVersion(vers, c.isDTLS); ok {
					c.wireVersion = vers
					found = true
					break
				}
			}
			if !found {
				c.sendAlert(alertProtocolVersion)
				return errors.New("tls: client did not offer any supported protocol versions")
			}
		}
	} else if config.Bugs.NegotiateVersionOnRenego != 0 {
		c.wireVersion = config.Bugs.NegotiateVersionOnRenego
	}

	var ok bool
	c.vers, ok = wireToVersion(c.wireVersion, c.isDTLS)
	if !ok {
		panic("Could not map wire version")
	}

	clientProtocol, clientProtocolOK := wireToVersion(c.clientVersion, c.isDTLS)

	if c.shouldSendHelloVerifyRequest() {
		// Per RFC 6347, the version field in HelloVerifyRequest SHOULD
		// be always DTLS 1.0
		cookieLen := c.config.Bugs.HelloVerifyRequestCookieLength
		if cookieLen == 0 {
			cookieLen = 32
		}
		if c.config.Bugs.EmptyHelloVerifyRequestCookie {
			cookieLen = 0
		}
		helloVerifyRequest := &helloVerifyRequestMsg{
			vers:   VersionDTLS10,
			cookie: make([]byte, cookieLen),
		}
		if _, err := io.ReadFull(c.config.rand(), helloVerifyRequest.cookie); err != nil {
			c.sendAlert(alertInternalError)
			return errors.New("dtls: short read from Rand: " + err.Error())
		}
		c.writeRecord(recordTypeHandshake, helloVerifyRequest.marshal())
		if err := c.flushHandshake(); err != nil {
			return err
		}

		newClientHello, err := readHandshakeType[clientHelloMsg](c)
		if err != nil {
			return err
		}
		if !bytes.Equal(newClientHello.cookie, helloVerifyRequest.cookie) {
			return errors.New("dtls: invalid cookie")
		}
		// Allow the client to recompute the pre_shared_key extension. It is
		// possible we'll want to remove this and instead require the client
		// keep it unchanged. (Either by remembering it or hashing the
		// ClientHello funny.) See discussion at
		// https://mailarchive.ietf.org/arch/msg/tls/HSTgV2voS9tn03oasGmBAdwazWA/
		if err := checkClientHellosEqual(hs.clientHello.raw, newClientHello.raw, c.isDTLS, []uint16{extensionPreSharedKey}); err != nil {
			return err
		}
		hs.clientHello = newClientHello
	}
	// The version for the connection is selected before sending
	// HelloVerifyRequest, but haveVers isn't set until after we send it and
	// receive the second ClientHello. This is intentional because once the
	// version for the Conn has been negotiated, we enforce that the version
	// in the record layer matches the negotiated version.
	//
	// At the time the server has selected a version and decided to send a
	// HelloVerifyRequest to the client, only the server knows the selected
	// version. Even though there is a version field in HelloVerifyRequest,
	// it is only used to indicate packet formatting and is not part of
	// version negotiation. Thus, when the client sends its second
	// ClientHello (in response to HelloVerifyRequest), it does not know the
	// version selected for this connection. Therefore, this server can't
	// enforce that the client used the correct version in the record layer.
	c.haveVers = true

	if config.Bugs.RequireSameRenegoClientVersion && c.clientVersion != 0 {
		if c.clientVersion != hs.clientHello.vers {
			return fmt.Errorf("tls: client offered different version on renego")
		}
	}

	if config.Bugs.FailIfPostQuantumOffered && slices.ContainsFunc(hs.clientHello.supportedCurves, isPqGroup) {
		return errors.New("tls: post-quantum group was offered")
	}

	if expected := config.Bugs.ExpectedKeyShares; expected != nil {
		if len(expected) != len(hs.clientHello.keyShares) {
			return fmt.Errorf("tls: expected %d key shares, but found %d", len(expected), len(hs.clientHello.keyShares))
		}

		for i, group := range expected {
			if found := hs.clientHello.keyShares[i].group; found != group {
				return fmt.Errorf("tls: key share #%d is for group %d, not %d", i, found, group)
			}
		}
	}

	// Reject < 1.2 ClientHellos with signature_algorithms.
	if clientProtocolOK && clientProtocol < VersionTLS12 && len(hs.clientHello.signatureAlgorithms) > 0 {
		return fmt.Errorf("tls: client included signature_algorithms before TLS 1.2")
	}

	// Check the client cipher list is consistent with the version.
	if clientProtocolOK && clientProtocol < VersionTLS12 && slices.ContainsFunc(hs.clientHello.cipherSuites, isTLS12Cipher) {
		return fmt.Errorf("tls: client offered TLS 1.2 cipher before TLS 1.2")
	}

	if config.Bugs.MockQUICTransport != nil && len(hs.clientHello.sessionID) > 0 {
		return fmt.Errorf("tls: QUIC client did not disable compatibility mode")
	}
	if config.Bugs.ExpectNoSessionID && len(hs.clientHello.sessionID) > 0 {
		return fmt.Errorf("tls: client offered an unexpected session ID")
	}
	if config.Bugs.ExpectNoTLS12Session {
		if len(hs.clientHello.sessionID) > 0 {
			if _, ok := config.ServerSessionCache.Get(string(hs.clientHello.sessionID)); ok {
				return fmt.Errorf("tls: client offered an unexpected TLS 1.2 session")
			}
		}
		if len(hs.clientHello.sessionTicket) > 0 {
			return fmt.Errorf("tls: client offered an unexpected session ticket")
		}
	}
	if config.Bugs.ExpectNoTLS12TicketSupport && hs.clientHello.ticketSupported {
		return fmt.Errorf("tls: client sent unexpected session ticket extension")
	}

	if config.Bugs.ExpectNoTLS13PSK && len(hs.clientHello.pskIdentities) > 0 {
		return fmt.Errorf("tls: client offered unexpected PSK identities")
	}

	scsvFound := slices.Contains(hs.clientHello.cipherSuites, fallbackSCSV)
	if !scsvFound && config.Bugs.FailIfNotFallbackSCSV {
		return errors.New("tls: no fallback SCSV found when expected")
	} else if scsvFound && !config.Bugs.FailIfNotFallbackSCSV {
		return errors.New("tls: fallback SCSV found when not expected")
	}

	if config.Bugs.ExpectGREASE && !containsGREASE(hs.clientHello.cipherSuites) {
		return errors.New("tls: no GREASE cipher suite value found")
	}

	var greaseFound bool
	for _, curve := range hs.clientHello.supportedCurves {
		if isGREASEValue(uint16(curve)) {
			greaseFound = true
			break
		}
	}

	if !greaseFound && config.Bugs.ExpectGREASE {
		return errors.New("tls: no GREASE curve value found")
	}

	if len(hs.clientHello.keyShares) > 0 {
		greaseFound = false
		for _, keyShare := range hs.clientHello.keyShares {
			if isGREASEValue(uint16(keyShare.group)) {
				greaseFound = true
				break
			}
		}

		if !greaseFound && config.Bugs.ExpectGREASE {
			return errors.New("tls: no GREASE curve value found")
		}
	}

	if len(hs.clientHello.sessionID) == 0 && c.config.Bugs.ExpectClientHelloSessionID {
		return errors.New("tls: expected non-empty session ID from client")
	}

	if expected := c.config.Bugs.ExpectPeerRequestedTrustAnchors; expected != nil {
		if hs.clientHello.trustAnchors == nil {
			return errors.New("tls: client did not send trust anchors")
		}
		if !slices.EqualFunc(expected, hs.clientHello.trustAnchors, slices.Equal) {
			return fmt.Errorf("tls: client offered trust anchors %v, but expected %v", hs.clientHello.trustAnchors, expected)
		}
	}

	applyBugsToClientHello(hs.clientHello, config)

	return nil
}

func applyBugsToClientHello(clientHello *clientHelloMsg, config *Config) {
	if config.Bugs.IgnorePeerSignatureAlgorithmPreferences {
		clientHello.signatureAlgorithms = config.Credential.signatureAlgorithms()
	}
	if config.Bugs.IgnorePeerCurvePreferences {
		clientHello.supportedCurves = config.curvePreferences()
	}
	if config.Bugs.IgnorePeerCipherPreferences {
		clientHello.cipherSuites = config.cipherSuites()
	}
}

type echDecryptError struct {
	error
}

func (hs *serverHandshakeState) decryptClientHello(helloOuter *clientHelloMsg) (helloInner *clientHelloMsg, err error) {
	// ClientHelloOuterAAD is ClientHelloOuter with the payload replaced by
	// zeros. See draft-ietf-tls-esni-13, section 5.2.
	aad := make([]byte, len(helloOuter.raw)-4)
	copy(aad, helloOuter.raw[4:helloOuter.echPayloadStart])
	copy(aad[helloOuter.echPayloadEnd-4:], helloOuter.raw[helloOuter.echPayloadEnd:])

	// In fuzzer mode, the payload is cleartext.
	encoded := helloOuter.echOuter.payload
	if !hs.c.config.Bugs.NullAllCiphers {
		var err error
		encoded, err = hs.echHPKEContext.Open(helloOuter.echOuter.payload, aad)
		if err != nil {
			// Wrap |err| so the caller can implement trial decryption.
			return nil, &echDecryptError{err}
		}
	}

	helloInner, err = decodeClientHelloInner(hs.c.config, encoded, helloOuter)
	if err != nil {
		return nil, err
	}

	if isAllZero(helloInner.random) {
		// If the client forgets to fill in the client random, it will likely be
		// all zero.
		return nil, errors.New("tls: ClientHelloInner random was all zero")
	}
	if bytes.Equal(helloInner.random, helloOuter.random) {
		return nil, errors.New("tls: ClientHelloOuter and ClientHelloInner have the same random values")
	}
	// ClientHelloInner should not offer TLS 1.2 and below.
	if len(helloInner.supportedVersions) == 0 {
		return nil, errors.New("tls: ClientHelloInner did not offer supported_versions")
	}
	for _, vers := range helloInner.supportedVersions {
		switch vers {
		case VersionSSL30, VersionTLS10, VersionTLS11, VersionTLS12, VersionDTLS10, VersionDTLS12:
			return nil, fmt.Errorf("tls: ClientHelloInner offered invalid version: %04x", vers)
		}
	}
	// ClientHelloInner should omit TLS-1.2-only extensions.
	if helloInner.nextProtoNeg || len(helloInner.supportedPoints) != 0 || helloInner.ticketSupported || helloInner.secureRenegotiation != nil || helloInner.extendedMasterSecret {
		return nil, errors.New("tls: ClientHelloInner included a TLS-1.2-only extension")
	}
	if !helloInner.echInner {
		return nil, errors.New("tls: ClientHelloInner missing inner encrypted_client_hello extension")
	}

	return helloInner, nil
}

func (hs *serverHandshakeState) doTLS13Handshake() error {
	c := hs.c
	config := c.config

	// We've read the ClientHello, so the next record must be preceded with ChangeCipherSpec.
	c.expectTLS13ChangeCipherSpec = true
	sessionID := hs.clientHello.sessionID
	if c.isDTLS && !config.Bugs.DTLS13EchoSessionID {
		sessionID = nil
	}

	hs.hello = &serverHelloMsg{
		isDTLS:                c.isDTLS,
		vers:                  c.wireVersion,
		sessionID:             sessionID,
		compressionMethod:     config.Bugs.SendCompressionMethod,
		versOverride:          config.Bugs.SendServerHelloVersion,
		supportedVersOverride: config.Bugs.SendServerSupportedVersionExtension,
		omitSupportedVers:     config.Bugs.OmitServerSupportedVersionExtension,
		customExtension:       config.Bugs.CustomUnencryptedExtension,
		unencryptedALPN:       config.Bugs.SendUnencryptedALPN,
	}

	hs.hello.random = make([]byte, 32)
	if _, err := io.ReadFull(config.rand(), hs.hello.random); err != nil {
		c.sendAlert(alertInternalError)
		return err
	}

	// TLS 1.3 forbids clients from advertising any non-null compression.
	if len(hs.clientHello.compressionMethods) != 1 || hs.clientHello.compressionMethods[0] != compressionNone {
		return errors.New("tls: client sent compression method other than null for TLS 1.3")
	}

	// Prepare an EncryptedExtensions message, but do not send it yet.
	encryptedExtensions := new(encryptedExtensionsMsg)
	encryptedExtensions.empty = config.Bugs.EmptyEncryptedExtensions
	if err := hs.processClientExtensions(&encryptedExtensions.extensions); err != nil {
		return err
	}

	// Select the cipher suite.
	var preferenceList, supportedList []uint16
	if config.PreferServerCipherSuites {
		preferenceList = config.cipherSuites()
		supportedList = hs.clientHello.cipherSuites
	} else {
		preferenceList = hs.clientHello.cipherSuites
		supportedList = config.cipherSuites()
	}

	for _, id := range preferenceList {
		if hs.suite = c.tryCipherSuite(id, supportedList, c.vers, true, true); hs.suite != nil {
			break
		}
	}

	if hs.suite == nil {
		c.sendAlert(alertHandshakeFailure)
		return errors.New("tls: no cipher suite supported by both client and server")
	}

	hs.hello.cipherSuite = hs.suite.id
	if c.config.Bugs.SendCipherSuite != 0 {
		hs.hello.cipherSuite = c.config.Bugs.SendCipherSuite
	}

	hs.finishedHash = newFinishedHash(c.wireVersion, c.isDTLS, hs.suite)
	hs.finishedHash.discardHandshakeBuffer()
	hs.writeClientHash(hs.clientHello.marshal())

	pskIdentities := hs.clientHello.pskIdentities
	pskKEModes := hs.clientHello.pskKEModes

	var replacedPSKIdentities bool
	if len(pskIdentities) == 0 && len(hs.clientHello.sessionTicket) > 0 && c.config.Bugs.AcceptAnySession {
		// Pick up the ticket from the TLS 1.2 extension, to test the
		// client does not get in a mixed up state.
		psk := pskIdentity{
			ticket: hs.clientHello.sessionTicket,
		}
		pskIdentities = []pskIdentity{psk}
		pskKEModes = []byte{pskDHEKEMode}
		replacedPSKIdentities = true
	}
	if config.Bugs.UseInnerSessionWithClientHelloOuter {
		replacedPSKIdentities = true
	}

	var pskIndex int
	foundKEMode := bytes.IndexByte(pskKEModes, pskDHEKEMode) >= 0
	if foundKEMode && !config.SessionTicketsDisabled {
		for i, pskIdentity := range pskIdentities {
			// TODO(svaldez): Check the obfuscatedTicketAge before accepting 0-RTT.
			sessionState, ok := c.decryptTicket(pskIdentity.ticket)
			if !ok {
				continue
			}

			if !config.Bugs.AcceptAnySession {
				if sessionState.vers != c.vers {
					continue
				}
				if sessionState.ticketExpiration.Before(c.config.time()) {
					continue
				}
				sessionCipher := cipherSuiteFromID(sessionState.cipherSuite)
				if sessionCipher == nil || sessionCipher.hash() != hs.suite.hash() {
					continue
				}
			}

			clientTicketAge := time.Duration(uint32(pskIdentity.obfuscatedTicketAge-sessionState.ticketAgeAdd)) * time.Millisecond
			if config.Bugs.ExpectTicketAge != 0 && clientTicketAge != config.Bugs.ExpectTicketAge {
				c.sendAlert(alertHandshakeFailure)
				return errors.New("tls: invalid ticket age")
			}

			if !replacedPSKIdentities {
				binderToVerify := hs.clientHello.pskBinders[i]
				if err := verifyPSKBinder(c.wireVersion, c.isDTLS, hs.clientHello, sessionState, binderToVerify, []byte{}, []byte{}); err != nil {
					return err
				}
			}

			hs.sessionState = sessionState
			hs.hello.hasPSKIdentity = true
			hs.hello.pskIdentity = uint16(i)
			pskIndex = i
			if config.Bugs.SelectPSKIdentityOnResume != 0 {
				hs.hello.pskIdentity = config.Bugs.SelectPSKIdentityOnResume
			}
			c.didResume = true
			break
		}
	}

	if config.Bugs.AlwaysSelectPSKIdentity {
		hs.hello.hasPSKIdentity = true
		hs.hello.pskIdentity = 0
	}

	// Resolve PSK and compute the early secret.
	if hs.sessionState != nil {
		hs.finishedHash.addEntropy(hs.sessionState.secret)
	} else {
		hs.finishedHash.addEntropy(hs.finishedHash.zeroSecret())
	}

	if hs.clientHello.hasEarlyData && c.isDTLS {
		return errors.New("tls: early data extension received in DTLS")
	}

	// Decide whether to use key_share.
	hs.hello.hasKeyShare = config.Credential.Type != CredentialTypeSPAKE2PlusV1 && config.Bugs.UnsolicitedPAKE == 0
	if hs.sessionState != nil && config.Bugs.NegotiatePSKResumption {
		hs.hello.hasKeyShare = false
	}
	if config.Bugs.MissingKeyShare {
		hs.hello.hasKeyShare = false
	}

	// Decide whether a HelloRetryRequest is needed.
	sendHelloRetryRequest := config.Bugs.AlwaysSendHelloRetryRequest
	cipherSuite := hs.suite.id
	if config.Bugs.SendHelloRetryRequestCipherSuite != 0 {
		cipherSuite = config.Bugs.SendHelloRetryRequestCipherSuite
	}
	helloRetryRequest := &helloRetryRequestMsg{
		isDTLS:              c.isDTLS,
		vers:                c.wireVersion,
		sessionID:           hs.clientHello.sessionID,
		cipherSuite:         cipherSuite,
		compressionMethod:   config.Bugs.SendCompressionMethod,
		duplicateExtensions: config.Bugs.DuplicateHelloRetryRequestExtensions,
	}

	if config.Bugs.SendHelloRetryRequestCookie != nil {
		sendHelloRetryRequest = true
		helloRetryRequest.cookie = config.Bugs.SendHelloRetryRequestCookie
	}

	if len(config.Bugs.CustomHelloRetryRequestExtension) > 0 {
		sendHelloRetryRequest = true
		helloRetryRequest.customExtension = config.Bugs.CustomHelloRetryRequestExtension
	}

	var selectedCurve CurveID
	var selectedKeyShare *keyShareEntry
	if hs.hello.hasKeyShare {
		// Select the matching curve.
		supportedCurve := false
		preferredCurves := config.curvePreferences()
		for _, curve := range hs.clientHello.supportedCurves {
			if slices.Contains(preferredCurves, curve) {
				supportedCurve = true
				selectedCurve = curve
				break
			}
		}
		if !supportedCurve {
			c.sendAlert(alertHandshakeFailure)
			return errors.New("tls: no curve supported by both client and server")
		}

		// Look for the key share corresponding to our selected curve.
		for i := range hs.clientHello.keyShares {
			if hs.clientHello.keyShares[i].group == selectedCurve {
				selectedKeyShare = &hs.clientHello.keyShares[i]
				break
			}
		}

		if config.Bugs.ExpectMissingKeyShare && selectedKeyShare != nil {
			return errors.New("tls: expected missing key share")
		}

		if selectedKeyShare == nil {
			helloRetryRequest.hasSelectedGroup = true
			helloRetryRequest.selectedGroup = selectedCurve
			sendHelloRetryRequest = true
		}
	}

	if config.Bugs.SendHelloRetryRequestCurve != 0 {
		helloRetryRequest.hasSelectedGroup = true
		helloRetryRequest.selectedGroup = config.Bugs.SendHelloRetryRequestCurve
		sendHelloRetryRequest = true
	}

	if config.Bugs.SkipHelloRetryRequest {
		sendHelloRetryRequest = false
	}

	if config.Bugs.SendPAKEInHelloRetryRequest {
		helloRetryRequest.pakeID = spakeID
		helloRetryRequest.pakeMessage = []byte{1}
		sendHelloRetryRequest = true
	}

	if sendHelloRetryRequest {
		hs.finishedHash.UpdateForHelloRetryRequest()

		// Emit the ECH confirmation signal when requested.
		if hs.clientHello.echInner {
			helloRetryRequest.echConfirmation = make([]byte, 8)
			helloRetryRequest.echConfirmation = hs.finishedHash.echAcceptConfirmation(hs.clientHello.random, echAcceptConfirmationHRRLabel, helloRetryRequest.marshal())
			helloRetryRequest.raw = nil
		} else if config.Bugs.AlwaysSendECHHelloRetryRequest {
			// When solicited, a random ECH confirmation string should be ignored.
			helloRetryRequest.echConfirmation = make([]byte, 8)
			if _, err := io.ReadFull(config.rand(), helloRetryRequest.echConfirmation); err != nil {
				c.sendAlert(alertInternalError)
				return fmt.Errorf("tls: short read from Rand: %s", err)
			}
		}

		hs.writeServerHash(helloRetryRequest.marshal())
		if c.config.Bugs.PartialServerHelloWithHelloRetryRequest {
			data := helloRetryRequest.marshal()
			c.writeRecord(recordTypeHandshake, append(data[:len(data):len(data)], typeServerHello))
		} else {
			c.writeRecord(recordTypeHandshake, helloRetryRequest.marshal())
		}
		if err := c.flushHandshake(); err != nil {
			return err
		}

		if !c.config.Bugs.SkipChangeCipherSpec {
			c.writeRecord(recordTypeChangeCipherSpec, []byte{1})
		}

		if hs.clientHello.hasEarlyData {
			c.setSkipEarlyData()
		}

		// Read new ClientHello.
		newClientHello, err := readHandshakeType[clientHelloMsg](c)
		if err != nil {
			return err
		}

		if expected := config.Bugs.ExpectOuterServerName; len(expected) != 0 && expected != newClientHello.serverName {
			return fmt.Errorf("tls: unexpected ClientHelloOuter server name: wanted %q, got %q", expected, newClientHello.serverName)
		}

		if c.echAccepted {
			if newClientHello.echOuter == nil {
				c.sendAlert(alertMissingExtension)
				return errors.New("tls: second ClientHelloOuter had no encrypted_client_hello extension")
			}
			if newClientHello.echOuter.configID != hs.echConfigID ||
				newClientHello.echOuter.kdfID != hs.echHPKEContext.KDF() ||
				newClientHello.echOuter.aeadID != hs.echHPKEContext.AEAD() {
				c.sendAlert(alertIllegalParameter)
				return errors.New("tls: ECH parameters changed in second ClientHelloOuter")
			}
			if len(newClientHello.echOuter.enc) != 0 {
				c.sendAlert(alertIllegalParameter)
				return errors.New("tls: second ClientHelloOuter had non-empty ECH enc")
			}
			newClientHello, err = hs.decryptClientHello(newClientHello)
			if err != nil {
				c.sendAlert(alertDecryptError)
				return fmt.Errorf("tls: error decrypting ClientHello: %s", err)
			}
		}

		hs.writeClientHash(newClientHello.marshal())

		if config.Bugs.ExpectNoTLS13PSKAfterHRR && len(newClientHello.pskIdentities) > 0 {
			return fmt.Errorf("tls: client offered unexpected PSK identities after HelloRetryRequest")
		}

		applyBugsToClientHello(newClientHello, config)

		// Check that the new ClientHello matches the old ClientHello,
		// except for relevant modifications. See RFC 8446, section 4.1.2.
		ignoreExtensions := []uint16{extensionPadding}

		if helloRetryRequest.hasSelectedGroup {
			newKeyShares := newClientHello.keyShares
			if len(newKeyShares) != 1 || newKeyShares[0].group != helloRetryRequest.selectedGroup {
				return errors.New("tls: KeyShare from HelloRetryRequest not in new ClientHello")
			}
			selectedKeyShare = &newKeyShares[0]
			ignoreExtensions = append(ignoreExtensions, extensionKeyShare)
		}

		if len(helloRetryRequest.cookie) > 0 {
			if !bytes.Equal(newClientHello.tls13Cookie, helloRetryRequest.cookie) {
				return errors.New("tls: cookie from HelloRetryRequest not present in new ClientHello")
			}
			ignoreExtensions = append(ignoreExtensions, extensionCookie)
		}

		// The second ClientHello refreshes binders, and may drop PSK identities
		// that are no longer consistent with the cipher suite.
		oldPSKIdentities := hs.clientHello.pskIdentities
		for _, identity := range newClientHello.pskIdentities {
			// Skip to the matching PSK identity in oldPSKIdentities.
			for len(oldPSKIdentities) > 0 && !bytes.Equal(oldPSKIdentities[0].ticket, identity.ticket) {
				oldPSKIdentities = oldPSKIdentities[1:]
			}
			// The identity now either matches, or oldPSKIdentities is empty.
			if len(oldPSKIdentities) == 0 {
				return errors.New("tls: unexpected PSK identity in second ClientHello")
			}
			oldPSKIdentities = oldPSKIdentities[1:]
		}
		ignoreExtensions = append(ignoreExtensions, extensionPreSharedKey)

		// Update the index for the identity we resumed. The client may have
		// dropped some entries.
		if hs.sessionState != nil {
			var found bool
			ticket := hs.clientHello.pskIdentities[pskIndex].ticket
			for i, identity := range newClientHello.pskIdentities {
				if bytes.Equal(identity.ticket, ticket) {
					found = true
					pskIndex = i
					break
				}
			}
			if found {
				binderToVerify := newClientHello.pskBinders[pskIndex]
				if err := verifyPSKBinder(c.wireVersion, c.isDTLS, newClientHello, hs.sessionState, binderToVerify, hs.clientHello.marshal(), helloRetryRequest.marshal()); err != nil {
					return err
				}
			} else if !config.Bugs.AcceptAnySession {
				// If AcceptAnySession is set, the client may have already noticed
				// the selected session is incompatible with the HelloRetryRequest
				// and correctly dropped the PSK identity. We may also have
				// attempted to resume a session from the TLS 1.2 extension.
				return errors.New("tls: second ClientHello is missing selected session")
			}
		}

		// The second ClientHello must stop offering early data.
		if newClientHello.hasEarlyData {
			return errors.New("tls: EarlyData sent in new ClientHello")
		}
		ignoreExtensions = append(ignoreExtensions, extensionEarlyData)

		if err := checkClientHellosEqual(hs.clientHello.raw, newClientHello.raw, c.isDTLS, ignoreExtensions); err != nil {
			return err
		}

		if config.Bugs.SecondHelloRetryRequest {
			c.writeRecord(recordTypeHandshake, helloRetryRequest.marshal())
			// The peer should reject this. Read from the connection to pick up the alert.
			_, err := c.readHandshake()
			if err != nil {
				return err
			}
			return errors.New("tls: client sent message instead of alert")
		}
	}

	// Decide whether or not to accept early data.
	if !sendHelloRetryRequest && hs.clientHello.hasEarlyData {
		if !config.Bugs.AlwaysRejectEarlyData && hs.sessionState != nil {
			if hs.sessionState.cipherSuite == hs.suite.id &&
				c.clientProtocol == string(hs.sessionState.earlyALPN) &&
				c.hasApplicationSettings == hs.sessionState.hasApplicationSettings &&
				bytes.Equal(c.localApplicationSettings, hs.sessionState.localApplicationSettings) &&
				c.hasApplicationSettingsOld == hs.sessionState.hasApplicationSettingsOld &&
				bytes.Equal(c.localApplicationSettingsOld, hs.sessionState.localApplicationSettingsOld) {
				encryptedExtensions.extensions.hasEarlyData = true
			}
			if config.Bugs.AlwaysAcceptEarlyData {
				encryptedExtensions.extensions.hasEarlyData = true
			}
		}
		if encryptedExtensions.extensions.hasEarlyData {
			earlyTrafficSecret := hs.finishedHash.deriveSecret(earlyTrafficLabel)
			c.earlyExporterSecret = hs.finishedHash.deriveSecret(earlyExporterLabel)

			// Applications are implicit with early data.
			if !config.Bugs.SendApplicationSettingsWithEarlyData {
				encryptedExtensions.extensions.hasApplicationSettings = false
				encryptedExtensions.extensions.applicationSettings = nil
				encryptedExtensions.extensions.hasApplicationSettingsOld = false
				encryptedExtensions.extensions.applicationSettingsOld = nil
			}

			sessionCipher := cipherSuiteFromID(hs.sessionState.cipherSuite)
			if err := c.useInTrafficSecret(uint16(encryptionEarlyData), c.wireVersion, sessionCipher, earlyTrafficSecret); err != nil {
				return err
			}

			for _, expectedMsg := range config.Bugs.ExpectEarlyData {
				if err := c.readRecord(recordTypeApplicationData); err != nil {
					return err
				}
				if !bytes.Equal(c.input.Bytes(), expectedMsg) {
					return fmt.Errorf("tls: got early data record %x, wanted %x", c.input.Bytes(), expectedMsg)
				}
				c.input.Reset()
			}
		} else {
			c.setSkipEarlyData()
		}
	}

	if config.Bugs.SendEarlyDataExtension {
		encryptedExtensions.extensions.hasEarlyData = true
	}

	// Resolve ECDHE and compute the handshake secret.
	if hs.hello.hasKeyShare {
		// Once a curve has been selected and a key share identified,
		// the server needs to generate a public value and send it in
		// the ServerHello.
		kem, ok := kemForCurveID(selectedCurve, config)
		if !ok {
			panic("tls: server failed to look up curve ID")
		}
		c.curveID = selectedCurve

		var peerKey []byte
		if config.Bugs.SkipHelloRetryRequest {
			// If skipping HelloRetryRequest, use a random key to
			// avoid crashing.
			kem2, _ := kemForCurveID(selectedCurve, config)
			var err error
			peerKey, err = kem2.generate(config)
			if err != nil {
				return err
			}
		} else {
			peerKey = selectedKeyShare.keyExchange
		}

		ciphertext, ecdheSecret, err := kem.encap(config, peerKey)
		if err != nil {
			c.sendAlert(alertHandshakeFailure)
			return err
		}
		hs.finishedHash.nextSecret()
		hs.finishedHash.addEntropy(ecdheSecret)
		hs.hello.hasKeyShare = true

		curveID := selectedCurve
		if c.config.Bugs.SendCurve != 0 {
			curveID = config.Bugs.SendCurve
		}

		hs.hello.keyShare = keyShareEntry{
			group:       curveID,
			keyExchange: ciphertext,
		}

		if config.Bugs.EncryptedExtensionsWithKeyShare {
			encryptedExtensions.extensions.hasKeyShare = true
			encryptedExtensions.extensions.keyShare = keyShareEntry{
				group:       curveID,
				keyExchange: ciphertext,
			}
		}
	} else if hs.cert.Type == CredentialTypeSPAKE2PlusV1 {
		if len(hs.clientHello.pakeShares) == 0 {
			return errors.New("tls: client not configured with PAKE")
		}
		if !bytes.Equal(hs.clientHello.pakeClientID, hs.cert.PAKEClientID) ||
			!bytes.Equal(hs.clientHello.pakeServerID, hs.cert.PAKEServerID) {
			return fmt.Errorf("tls: client configured with different PAKE identities: got (%x, %x), wanted (%x, %x)", hs.clientHello.pakeClientID, hs.clientHello.pakeServerID, hs.cert.PAKEClientID, hs.cert.PAKEServerID)
		}
		var pakeMessage []byte
		for _, pake := range hs.clientHello.pakeShares {
			if pake.id == spakeID {
				pakeMessage = pake.msg
			}
		}
		if pakeMessage == nil {
			return errors.New("tls: client does not support SPAKE2+")
		}
		w0, _, registrationRecord, err := spake2plus.Register(hs.cert.PAKEPassword, hs.cert.PAKEClientID, hs.cert.PAKEServerID)
		if err != nil {
			return err
		}
		pake, err := spake2plus.NewVerifier(hs.cert.PAKEContext, hs.cert.PAKEClientID, hs.cert.PAKEServerID, w0, registrationRecord)
		if err != nil {
			return err
		}
		share, confirm, sharedSecret, err := pake.ProcessProverShare(pakeMessage)
		if err != nil {
			c.sendAlert(alertHandshakeFailure)
			return fmt.Errorf("while processing SPAKE2+ prover share: %w", err)
		}
		hs.finishedHash.nextSecret()
		hs.finishedHash.addEntropy(sharedSecret)
		hs.hello.pakeID = spakeID
		if hs.cert.OverridePAKECodepoint != 0 {
			hs.hello.pakeID = hs.cert.OverridePAKECodepoint
		}
		hs.hello.pakeMessage = slices.Concat(share, confirm)
		if c.config.Bugs.TruncatePAKEMessage {
			hs.hello.pakeMessage = hs.hello.pakeMessage[:len(hs.hello.pakeMessage)-1]
		}
	} else if config.Bugs.UnsolicitedPAKE != 0 {
		hs.finishedHash.nextSecret()
		hs.finishedHash.addEntropy(hs.finishedHash.zeroSecret())
		hs.hello.pakeID = config.Bugs.UnsolicitedPAKE
		hs.hello.pakeMessage = []byte{1}
	} else {
		hs.finishedHash.nextSecret()
		hs.finishedHash.addEntropy(hs.finishedHash.zeroSecret())
	}

	// Emit the ECH confirmation signal when requested.
	if hs.clientHello.echInner && !config.Bugs.OmitServerHelloECHConfirmation {
		randomSuffix := hs.hello.random[len(hs.hello.random)-echAcceptConfirmationLength:]
		clear(randomSuffix)
		copy(randomSuffix, hs.finishedHash.echAcceptConfirmation(hs.clientHello.random, echAcceptConfirmationLabel, hs.hello.marshal()))
		hs.hello.raw = nil
	}

	// Send unencrypted ServerHello.
	helloBytes := hs.hello.marshal()
	hs.writeServerHash(helloBytes)
	if config.Bugs.PartialServerHelloWithHelloRetryRequest {
		// The first byte has already been written.
		helloBytes = helloBytes[1:]
	}
	if config.Bugs.PartialEncryptedExtensionsWithServerHello {
		c.writeRecord(recordTypeHandshake, append(helloBytes[:len(helloBytes):len(helloBytes)], typeEncryptedExtensions))
	} else {
		c.writeRecord(recordTypeHandshake, helloBytes)
	}

	if !c.config.Bugs.SkipChangeCipherSpec && !sendHelloRetryRequest && !c.isDTLS {
		c.writeRecord(recordTypeChangeCipherSpec, []byte{1})
	}

	for i := 0; i < c.config.Bugs.SendExtraChangeCipherSpec; i++ {
		c.writeRecord(recordTypeChangeCipherSpec, []byte{1})
	}

	if config.Bugs.UnencryptedEncryptedExtensions {
		c.writeRecord(recordTypeHandshake, encryptedExtensions.marshal())
	}

	// Switch to handshake traffic keys.
	serverHandshakeTrafficSecret := hs.finishedHash.deriveSecret(serverHandshakeTrafficLabel)
	c.useOutTrafficSecret(uint16(encryptionHandshake), c.wireVersion, hs.suite, serverHandshakeTrafficSecret)
	// Derive handshake traffic read key, but don't switch yet.
	clientHandshakeTrafficSecret := hs.finishedHash.deriveSecret(clientHandshakeTrafficLabel)

	// Send EncryptedExtensions.
	hs.writeServerHash(encryptedExtensions.marshal())
	if config.Bugs.PartialEncryptedExtensionsWithServerHello {
		// The first byte has already been sent.
		c.writeRecord(recordTypeHandshake, encryptedExtensions.marshal()[1:])
	} else if !config.Bugs.UnencryptedEncryptedExtensions {
		c.writeRecord(recordTypeHandshake, encryptedExtensions.marshal())
	}

	var requestClientCert bool
	if (hs.sessionState == nil && hs.cert.Type != CredentialTypeSPAKE2PlusV1) || config.Bugs.AlwaysSendCertificateRequest {
		requestClientCert = config.ClientAuth >= RequestClientCert
	}
	if requestClientCert {
		// Request a client certificate
		certReq := &certificateRequestMsg{
			vers:                  c.wireVersion,
			hasSignatureAlgorithm: !config.Bugs.OmitCertificateRequestAlgorithms,
			hasRequestContext:     true,
			requestContext:        config.Bugs.SendRequestContext,
			customExtension:       config.Bugs.SendCustomCertificateRequest,
		}
		if !config.Bugs.NoSignatureAlgorithms {
			certReq.signatureAlgorithms = config.verifySignatureAlgorithms()
		}

		// An empty list of certificateAuthorities signals to
		// the client that it may send any certificate in response
		// to our request. When we know the CAs we trust, then
		// we can send them down, so that the client can choose
		// an appropriate certificate to give to us.
		if config.ClientCAs != nil {
			certReq.certificateAuthorities = config.ClientCAs.Subjects()
		}
		hs.writeServerHash(certReq.marshal())
		c.writeRecord(recordTypeHandshake, certReq.marshal())
	}

	if (hs.sessionState == nil && hs.cert.Type != CredentialTypeSPAKE2PlusV1) || config.Bugs.AlwaysSendCertificate {
		useCert := hs.cert
		if config.Bugs.UseCertificateCredential != nil {
			useCert = config.Bugs.UseCertificateCredential
		}
		certMsg := &certificateMsg{
			hasRequestContext: true,
		}
		certMsg.sendTrustAnchorWrongCertificate = config.Bugs.SendTrustAnchorWrongCertificate
		certMsg.sendNonEmptyTrustAnchorMatch = config.Bugs.SendNonEmptyTrustAnchorMatch
		if config.Bugs.AlwaysMatchTrustAnchorID {
			certMsg.matchedTrustAnchor = true
		} else {
			if hs.clientHello.trustAnchors != nil && useCert.TrustAnchorID != nil {
				for _, id := range hs.clientHello.trustAnchors {
					if bytes.Equal(useCert.TrustAnchorID, id) {
						certMsg.matchedTrustAnchor = true
					}
				}
			}
		}
		if !config.Bugs.EmptyCertificateList {
			for i, certData := range useCert.Certificate {
				cert := certificateEntry{
					data: certData,
				}
				if i == 0 {
					if hs.clientHello.ocspStapling && !c.config.Bugs.NoOCSPStapling {
						cert.ocspResponse = useCert.OCSPStaple
					}
					if hs.clientHello.sctListSupported && !c.config.Bugs.NoSignedCertificateTimestamps {
						cert.sctList = useCert.SignedCertificateTimestampList
					}
					cert.duplicateExtensions = config.Bugs.SendDuplicateCertExtensions
					cert.extraExtension = config.Bugs.SendExtensionOnCertificate
				} else {
					if config.Bugs.SendOCSPOnIntermediates != nil {
						cert.ocspResponse = config.Bugs.SendOCSPOnIntermediates
					}
					if config.Bugs.SendSCTOnIntermediates != nil {
						cert.sctList = config.Bugs.SendSCTOnIntermediates
					}
				}
				certMsg.certificates = append(certMsg.certificates, cert)
			}
		}
		certMsgBytes := certMsg.marshal()
		sentCompressedCertMsg := false

		for id, alg := range c.config.CertCompressionAlgs {
			if slices.Contains(hs.clientHello.compressedCertAlgs, id) {
				if expected := config.Bugs.ExpectedCompressedCert; expected != 0 && expected != id {
					return fmt.Errorf("tls: expected to send compressed cert with alg %d, but picked %d", expected, id)
				}
				if config.Bugs.ExpectUncompressedCert {
					return errors.New("tls: expected to send uncompressed cert")
				}

				if override := config.Bugs.SendCertCompressionAlgID; override != 0 {
					id = override
				}

				uncompressed := certMsgBytes[4:]
				uncompressedLen := uint32(len(uncompressed))
				if override := config.Bugs.SendCertUncompressedLength; override != 0 {
					uncompressedLen = override
				}

				compressedCertMsgBytes := (&compressedCertificateMsg{
					algID:              id,
					uncompressedLength: uncompressedLen,
					compressed:         alg.Compress(uncompressed),
				}).marshal()

				hs.writeServerHash(compressedCertMsgBytes)
				c.writeRecord(recordTypeHandshake, compressedCertMsgBytes)
				sentCompressedCertMsg = true
				break
			}
		}

		if !sentCompressedCertMsg {
			if config.Bugs.ExpectedCompressedCert != 0 {
				return errors.New("tls: unexpectedly sent uncompressed certificate")
			}
			hs.writeServerHash(certMsgBytes)
			c.writeRecord(recordTypeHandshake, certMsgBytes)
		}

		certVerify := &certificateVerifyMsg{
			hasSignatureAlgorithm: true,
		}

		// Determine the hash to sign.
		var err error
		certVerify.signatureAlgorithm, err = selectSignatureAlgorithm(c.isClient, c.vers, useCert, config, hs.clientHello.signatureAlgorithms)
		if err != nil {
			c.sendAlert(alertInternalError)
			return err
		}

		privKey := useCert.PrivateKey
		input := hs.finishedHash.certificateVerifyInput(serverCertificateVerifyContextTLS13)
		certVerify.signature, err = signMessage(c.isClient, c.vers, privKey, c.config, certVerify.signatureAlgorithm, input)
		if err != nil {
			c.sendAlert(alertInternalError)
			return err
		}

		if config.Bugs.SendSignatureAlgorithm != 0 {
			certVerify.signatureAlgorithm = config.Bugs.SendSignatureAlgorithm
		}

		if !config.Bugs.SkipCertificateVerify {
			hs.writeServerHash(certVerify.marshal())
			c.writeRecord(recordTypeHandshake, certVerify.marshal())
		}
	} else if hs.sessionState != nil {
		// Pick up certificates from the session instead.
		if len(hs.sessionState.certificates) > 0 {
			if _, err := hs.processCertsFromClient(hs.sessionState.certificates); err != nil {
				return err
			}
		}
	}

	finished := new(finishedMsg)
	finished.verifyData = hs.finishedHash.serverSum(serverHandshakeTrafficSecret)
	if config.Bugs.BadFinished {
		finished.verifyData[0]++
	}
	hs.writeServerHash(finished.marshal())
	c.writeRecord(recordTypeHandshake, finished.marshal())
	if c.config.Bugs.SendExtraFinished {
		c.writeRecord(recordTypeHandshake, finished.marshal())
	}

	// The various secrets do not incorporate the client's final leg, so
	// derive them now before updating the handshake context.
	hs.finishedHash.nextSecret()
	hs.finishedHash.addEntropy(hs.finishedHash.zeroSecret())

	clientTrafficSecret := hs.finishedHash.deriveSecret(clientApplicationTrafficLabel)
	serverTrafficSecret := hs.finishedHash.deriveSecret(serverApplicationTrafficLabel)
	c.exporterSecret = hs.finishedHash.deriveSecret(exporterLabel)

	if data := c.config.Bugs.AppDataBeforeTLS13KeyChange; data != nil {
		c.writeRecord(recordTypeApplicationData, data)
	}

	// Switch to application data keys on write. In particular, any alerts
	// from the client certificate are sent over these keys.
	c.useOutTrafficSecret(uint16(encryptionApplication), c.wireVersion, hs.suite, serverTrafficSecret)

	// In TLS, we need to consume EndOfEarlyData, and also test early data that
	// was only partially written while reading the ServerHello. Both of these
	// require flushing ServerHello first. Neither of these apply to DTLS, where
	// we need to flush after installing handshake keys.
	if encryptedExtensions.extensions.hasEarlyData && !c.isDTLS {
		if err := c.flushHandshake(); err != nil {
			return err
		}
		for _, expectedMsg := range config.Bugs.ExpectLateEarlyData {
			if err := c.readRecord(recordTypeApplicationData); err != nil {
				return err
			}
			if !bytes.Equal(c.input.Bytes(), expectedMsg) {
				return fmt.Errorf("tls: got late early data record %x, wanted %x", c.input.Bytes(), expectedMsg)
			}
			c.input.Reset()
		}
		if c.usesEndOfEarlyData() {
			endOfEarlyData, err := readHandshakeType[endOfEarlyDataMsg](c)
			if err != nil {
				return err
			}
			hs.writeClientHash(endOfEarlyData.marshal())
		}
	}

	// Switch input stream to handshake traffic keys.
	if err := c.useInTrafficSecret(uint16(encryptionHandshake), c.wireVersion, hs.suite, clientHandshakeTrafficSecret); err != nil {
		return err
	}

	// DTLS testing requires this flush occur after installing handshake keys,
	// so that we can process ACKs.
	if err := c.flushHandshake(); err != nil {
		return err
	}

	// If we sent an ALPS extension, the client must respond with a single EncryptedExtensions.
	if encryptedExtensions.extensions.hasApplicationSettings || encryptedExtensions.extensions.hasApplicationSettingsOld {
		clientEncryptedExtensions, err := readHandshakeType[clientEncryptedExtensionsMsg](c)
		if err != nil {
			return err
		}
		hs.writeClientHash(clientEncryptedExtensions.marshal())

		// Expect client send new application settings not old.
		if encryptedExtensions.extensions.hasApplicationSettings {
			if !clientEncryptedExtensions.hasApplicationSettings {
				c.sendAlert(alertMissingExtension)
				return errors.New("tls: client didn't provide new application settings")
			}
			if clientEncryptedExtensions.hasApplicationSettingsOld {
				c.sendAlert(alertUnsupportedExtension)
				return errors.New("tls: client shouldn't provide old application settings")
			}
			c.peerApplicationSettings = clientEncryptedExtensions.applicationSettings
		}

		// Expect client send old application settings not new.
		if encryptedExtensions.extensions.hasApplicationSettingsOld {
			if !clientEncryptedExtensions.hasApplicationSettingsOld {
				c.sendAlert(alertMissingExtension)
				return errors.New("tls: client didn't provide old application settings")
			}
			if clientEncryptedExtensions.hasApplicationSettings {
				c.sendAlert(alertUnsupportedExtension)
				return errors.New("tls: client shouldn't provide new application settings")
			}
			c.peerApplicationSettingsOld = clientEncryptedExtensions.applicationSettingsOld
		}
	} else if encryptedExtensions.extensions.hasEarlyData {
		// 0-RTT sessions carry application settings over.
		c.peerApplicationSettings = hs.sessionState.peerApplicationSettings
		c.peerApplicationSettingsOld = hs.sessionState.peerApplicationSettingsOld
	}

	// If we requested a client certificate, then the client must send a
	// certificate message, even if it's empty.
	if requestClientCert {
		certMsg, err := readHandshakeType[certificateMsg](c)
		if err != nil {
			return err
		}
		hs.writeClientHash(certMsg.marshal())

		if len(certMsg.certificates) == 0 {
			// The client didn't actually send a certificate
			switch config.ClientAuth {
			case RequireAnyClientCert, RequireAndVerifyClientCert:
				c.sendAlert(alertCertificateRequired)
				return errors.New("tls: client didn't provide a certificate")
			}
		}

		var certs [][]byte
		for _, cert := range certMsg.certificates {
			certs = append(certs, cert.data)
			// OCSP responses and SCT lists are not negotiated in
			// client certificates.
			if cert.ocspResponse != nil || cert.sctList != nil {
				c.sendAlert(alertUnsupportedExtension)
				return errors.New("tls: unexpected extensions in the client certificate")
			}
		}
		pub, err := hs.processCertsFromClient(certs)
		if err != nil {
			return err
		}

		if len(c.peerCertificates) > 0 {
			certVerify, err := readHandshakeType[certificateVerifyMsg](c)
			if err != nil {
				return err
			}
			c.peerSignatureAlgorithm = certVerify.signatureAlgorithm
			input := hs.finishedHash.certificateVerifyInput(clientCertificateVerifyContextTLS13)
			if err := verifyMessage(c.isClient, c.vers, pub, config, certVerify.signatureAlgorithm, input, certVerify.signature); err != nil {
				c.sendAlert(alertBadCertificate)
				return err
			}
			hs.writeClientHash(certVerify.marshal())
		}
	}

	if encryptedExtensions.extensions.channelIDRequested {
		channelIDMsg, err := readHandshakeType[channelIDMsg](c)
		if err != nil {
			return err
		}
		channelIDHash := crypto.SHA256.New()
		channelIDHash.Write(hs.finishedHash.certificateVerifyInput(channelIDContextTLS13))
		channelID, err := verifyChannelIDMessage(channelIDMsg, channelIDHash.Sum(nil))
		if err != nil {
			return err
		}
		c.channelID = channelID

		hs.writeClientHash(channelIDMsg.marshal())
	}

	// Read the client Finished message.
	clientFinished, err := readHandshakeType[finishedMsg](c)
	if err != nil {
		return err
	}
	verify := hs.finishedHash.clientSum(clientHandshakeTrafficSecret)
	if len(verify) != len(clientFinished.verifyData) ||
		subtle.ConstantTimeCompare(verify, clientFinished.verifyData) != 1 {
		c.sendAlert(alertHandshakeFailure)
		return errors.New("tls: client's Finished message was incorrect")
	}
	hs.writeClientHash(clientFinished.marshal())

	// Switch to application data keys on read.
	if err := c.useInTrafficSecret(uint16(encryptionApplication), c.wireVersion, hs.suite, clientTrafficSecret); err != nil {
		return err
	}

	if err := c.ackHandshake(); err != nil {
		return err
	}

	c.cipherSuite = hs.suite
	c.resumptionSecret = hs.finishedHash.deriveSecret(resumptionLabel)

	// TODO(davidben): Allow configuring the number of tickets sent for
	// testing.
	if !c.config.SessionTicketsDisabled && foundKEMode {
		ticketCount := 2
		for i := 0; i < ticketCount; i++ {
			c.SendNewSessionTicket([]byte{byte(i)})
		}
		if err := c.flushHandshake(); err != nil {
			return err
		}
	}
	return nil
}

// processClientHello processes the ClientHello message from the client and
// decides whether we will perform session resumption.
func (hs *serverHandshakeState) processClientHello() (isResume bool, err error) {
	config := hs.c.config
	c := hs.c

	hs.hello = &serverHelloMsg{
		isDTLS:            c.isDTLS,
		vers:              c.wireVersion,
		versOverride:      config.Bugs.SendServerHelloVersion,
		compressionMethod: config.Bugs.SendCompressionMethod,
		extensions: serverExtensions{
			supportedVersion: config.Bugs.SendServerSupportedVersionExtension,
		},
		omitExtensions:  config.Bugs.OmitExtensions,
		emptyExtensions: config.Bugs.EmptyExtensions,
	}

	hs.hello.random = make([]byte, 32)
	_, err = io.ReadFull(config.rand(), hs.hello.random)
	if err != nil {
		c.sendAlert(alertInternalError)
		return false, err
	}

	_, supportsTLS13 := c.config.isSupportedVersion(VersionTLS13, false)

	// Signal downgrades in the server random, per RFC 8446, section 4.1.3.
	if supportsTLS13 || config.Bugs.SendTLS13DowngradeRandom {
		if c.vers <= VersionTLS12 && config.maxVersion(c.isDTLS) >= VersionTLS13 {
			copy(hs.hello.random[len(hs.hello.random)-8:], downgradeTLS13)
		}
		if c.vers <= VersionTLS11 && config.maxVersion(c.isDTLS) == VersionTLS12 {
			copy(hs.hello.random[len(hs.hello.random)-8:], downgradeTLS12)
		}
	}
	if config.Bugs.SendJDK11DowngradeRandom {
		copy(hs.hello.random[len(hs.hello.random)-8:], downgradeJDK11)
	}

	// We only support null compression, so check that the client offered it.
	if !slices.Contains(hs.clientHello.compressionMethods, compressionNone) {
		c.sendAlert(alertHandshakeFailure)
		return false, errors.New("tls: client does not support uncompressed connections")
	}

	if err := hs.processClientExtensions(&hs.hello.extensions); err != nil {
		return false, err
	}

	supportedCurve := false
	preferredCurves := config.curvePreferences()
	for _, curve := range hs.clientHello.supportedCurves {
		if isPqGroup(curve) && c.vers < VersionTLS13 {
			// Post-quantum is TLS 1.3 only.
			continue
		}

		if slices.Contains(preferredCurves, curve) {
			supportedCurve = true
			break
		}
	}

	supportedPointFormat := slices.Contains(hs.clientHello.supportedPoints, pointFormatUncompressed)
	hs.ellipticOk = supportedCurve && supportedPointFormat

	_, hs.ecdsaOk = hs.cert.PrivateKey.(*ecdsa.PrivateKey)
	// Ed25519 also uses ECDSA certificates.
	_, ed25519Ok := hs.cert.PrivateKey.(ed25519.PrivateKey)
	hs.ecdsaOk = hs.ecdsaOk || ed25519Ok

	// For test purposes, check that the peer never offers a session when
	// renegotiating.
	if c.cipherSuite != nil && len(hs.clientHello.sessionID) > 0 && c.config.Bugs.FailIfResumeOnRenego {
		return false, errors.New("tls: offered resumption on renegotiation")
	}

	if hs.checkForResumption() {
		return true, nil
	}

	var preferenceList, supportedList []uint16
	if c.config.PreferServerCipherSuites {
		preferenceList = c.config.cipherSuites()
		supportedList = hs.clientHello.cipherSuites
	} else {
		preferenceList = hs.clientHello.cipherSuites
		supportedList = c.config.cipherSuites()
	}

	for _, id := range preferenceList {
		if hs.suite = c.tryCipherSuite(id, supportedList, c.vers, hs.ellipticOk, hs.ecdsaOk); hs.suite != nil {
			break
		}
	}

	if hs.suite == nil {
		c.sendAlert(alertHandshakeFailure)
		return false, errors.New("tls: no cipher suite supported by both client and server")
	}

	return false, nil
}

// processClientExtensions processes all ClientHello extensions not directly
// related to cipher suite negotiation and writes responses in serverExtensions.
func (hs *serverHandshakeState) processClientExtensions(serverExtensions *serverExtensions) error {
	config := hs.c.config
	c := hs.c

	if c.vers < VersionTLS13 || config.Bugs.NegotiateRenegotiationInfoAtAllVersions {
		if !bytes.Equal(c.clientVerify, hs.clientHello.secureRenegotiation) {
			c.sendAlert(alertHandshakeFailure)
			return errors.New("tls: renegotiation mismatch")
		}

		if len(c.clientVerify) > 0 && !c.config.Bugs.EmptyRenegotiationInfo {
			serverExtensions.secureRenegotiation = append(serverExtensions.secureRenegotiation, c.clientVerify...)
			serverExtensions.secureRenegotiation = append(serverExtensions.secureRenegotiation, c.serverVerify...)
			if c.config.Bugs.BadRenegotiationInfo {
				serverExtensions.secureRenegotiation[0] ^= 0x80
			}
			if c.config.Bugs.BadRenegotiationInfoEnd {
				serverExtensions.secureRenegotiation[len(serverExtensions.secureRenegotiation)-1] ^= 0x80
			}
		} else {
			serverExtensions.secureRenegotiation = hs.clientHello.secureRenegotiation
		}

		if c.noRenegotiationInfo() {
			serverExtensions.secureRenegotiation = nil
		}
	}

	serverExtensions.duplicateExtension = c.config.Bugs.DuplicateExtension

	if len(hs.clientHello.serverName) > 0 {
		c.serverName = hs.clientHello.serverName
	}
	if config.Credential == nil {
		c.sendAlert(alertInternalError)
		return errors.New("tls: no certificates configured")
	}
	hs.cert = config.Credential
	if expected := c.config.Bugs.ExpectServerName; expected != "" && expected != hs.clientHello.serverName {
		return fmt.Errorf("tls: unexpected server name: wanted %q, got %q", expected, hs.clientHello.serverName)
	}

	if cert := config.Bugs.RenegotiationCertificate; c.cipherSuite != nil && cert != nil {
		hs.cert = cert
	}

	if len(hs.clientHello.alpnProtocols) > 0 {
		// We will never offer ALPN as a client on renegotiation
		// handshakes.
		if len(c.clientVerify) > 0 {
			return errors.New("tls: offered ALPN on renegotiation")
		}
		if proto := c.config.Bugs.ALPNProtocol; proto != nil {
			serverExtensions.alpnProtocol = *proto
			serverExtensions.alpnProtocolEmpty = len(*proto) == 0
			c.clientProtocol = *proto
			c.usedALPN = true
		} else if selectedProto, fallback := mutualProtocol(hs.clientHello.alpnProtocols, c.config.NextProtos); !fallback {
			serverExtensions.alpnProtocol = selectedProto
			c.clientProtocol = selectedProto
			c.usedALPN = true
		}

		var alpsAllowed, alpsAllowedOld bool
		if c.vers >= VersionTLS13 {
			alpsAllowed = slices.Contains(hs.clientHello.alpsProtocols, c.clientProtocol)
			alpsAllowedOld = slices.Contains(hs.clientHello.alpsProtocolsOld, c.clientProtocol)
		}

		if c.config.Bugs.AlwaysNegotiateApplicationSettingsBoth {
			alpsAllowed = true
			alpsAllowedOld = true
		}
		if c.config.Bugs.AlwaysNegotiateApplicationSettingsNew {
			alpsAllowed = true
		}
		if c.config.Bugs.AlwaysNegotiateApplicationSettingsOld {
			alpsAllowedOld = true
		}
		if settings, ok := c.config.ApplicationSettings[c.clientProtocol]; ok && alpsAllowed {
			c.hasApplicationSettings = true
			c.localApplicationSettings = settings
			// Note these fields may later be cleared we accept 0-RTT.
			serverExtensions.hasApplicationSettings = true
			serverExtensions.applicationSettings = settings
		}
		if settings, ok := c.config.ApplicationSettings[c.clientProtocol]; ok && alpsAllowedOld {
			c.hasApplicationSettingsOld = true
			c.localApplicationSettingsOld = settings
			// Note these fields may later be cleared we accept 0-RTT.
			serverExtensions.hasApplicationSettingsOld = true
			serverExtensions.applicationSettingsOld = settings
		}
	}

	if len(c.config.Bugs.SendALPN) > 0 {
		serverExtensions.alpnProtocol = c.config.Bugs.SendALPN
	}

	if c.vers < VersionTLS13 || config.Bugs.NegotiateNPNAtAllVersions {
		if len(hs.clientHello.alpnProtocols) == 0 || c.config.Bugs.NegotiateALPNAndNPN {
			if hs.clientHello.nextProtoNeg && (len(config.NextProtos) > 0 || config.NegotiateNPNWithNoProtos) {
				serverExtensions.nextProtoNeg = true
				serverExtensions.nextProtos = config.NextProtos
				serverExtensions.npnAfterAlpn = config.Bugs.SwapNPNAndALPN
			}
		}
	}

	if len(hs.clientHello.quicTransportParams) > 0 {
		c.quicTransportParams = hs.clientHello.quicTransportParams
	}
	if c.config.QUICTransportParamsUseLegacyCodepoint.IncludeStandard() {
		serverExtensions.quicTransportParams = c.config.QUICTransportParams
	}

	if len(hs.clientHello.quicTransportParamsLegacy) > 0 {
		c.quicTransportParamsLegacy = hs.clientHello.quicTransportParamsLegacy
	}
	if c.config.QUICTransportParamsUseLegacyCodepoint.IncludeLegacy() {
		serverExtensions.quicTransportParamsLegacy = c.config.QUICTransportParams
	}

	if c.vers < VersionTLS13 || config.Bugs.NegotiateEMSAtAllVersions {
		disableEMS := config.Bugs.NoExtendedMasterSecret
		if c.cipherSuite != nil {
			disableEMS = config.Bugs.NoExtendedMasterSecretOnRenegotiation
		}
		serverExtensions.extendedMasterSecret = hs.clientHello.extendedMasterSecret && !disableEMS
	}

	if config.Bugs.AlwaysNegotiateChannelID || (hs.clientHello.channelIDSupported && config.RequestChannelID) {
		serverExtensions.channelIDRequested = true
	}

	if hs.clientHello.srtpProtectionProfiles != nil {
		for _, p := range c.config.SRTPProtectionProfiles {
			if slices.Contains(hs.clientHello.srtpProtectionProfiles, p) {
				serverExtensions.srtpProtectionProfile = p
				c.srtpProtectionProfile = p
				break
			}
		}
	}

	if c.config.Bugs.SendSRTPProtectionProfile != 0 {
		serverExtensions.srtpProtectionProfile = c.config.Bugs.SendSRTPProtectionProfile
	}

	if expected := c.config.Bugs.ExpectedCustomExtension; expected != nil {
		if hs.clientHello.customExtension != *expected {
			return fmt.Errorf("tls: bad custom extension contents %q", hs.clientHello.customExtension)
		}
	}
	serverExtensions.customExtension = config.Bugs.CustomExtension

	if c.config.Bugs.AdvertiseTicketExtension {
		serverExtensions.ticketSupported = true
	}

	if c.config.Bugs.SendSupportedPointFormats != nil {
		serverExtensions.supportedPoints = c.config.Bugs.SendSupportedPointFormats
	}

	if c.config.Bugs.SendServerSupportedCurves {
		serverExtensions.supportedCurves = c.config.curvePreferences()
	}

	if !hs.clientHello.hasGREASEExtension && config.Bugs.ExpectGREASE {
		return errors.New("tls: no GREASE extension found")
	}

	if hs.clientHello.trustAnchors != nil || config.Bugs.AlwaysSendAvailableTrustAnchors {
		serverExtensions.trustAnchors = c.config.AvailableTrustAnchors
	}
	serverExtensions.serverNameAck = c.config.Bugs.SendServerNameAck

	if (c.vers >= VersionTLS13 && hs.clientHello.echOuter != nil) || c.config.Bugs.AlwaysSendECHRetryConfigs {
		if len(config.Bugs.SendECHRetryConfigs) > 0 {
			serverExtensions.echRetryConfigs = config.Bugs.SendECHRetryConfigs
		} else if len(config.ServerECHConfigs) > 0 {
			echConfigs := make([][]byte, len(config.ServerECHConfigs))
			for i, echConfig := range config.ServerECHConfigs {
				echConfigs[i] = echConfig.ECHConfig.Raw
			}
			serverExtensions.echRetryConfigs = CreateECHConfigList(echConfigs...)
		}
	}

	return nil
}

// checkForResumption returns true if we should perform resumption on this connection.
func (hs *serverHandshakeState) checkForResumption() bool {
	c := hs.c

	ticket := hs.clientHello.sessionTicket
	if len(ticket) == 0 && len(hs.clientHello.pskIdentities) > 0 && c.config.Bugs.AcceptAnySession {
		ticket = hs.clientHello.pskIdentities[0].ticket
	}
	if len(ticket) > 0 {
		if c.config.SessionTicketsDisabled {
			return false
		}

		var ok bool
		if hs.sessionState, ok = c.decryptTicket(ticket); !ok {
			return false
		}
	} else {
		if c.config.ServerSessionCache == nil {
			return false
		}

		var ok bool
		sessionID := string(hs.clientHello.sessionID)
		if hs.sessionState, ok = c.config.ServerSessionCache.Get(sessionID); !ok {
			return false
		}
	}

	if c.config.Bugs.AcceptAnySession {
		// Replace the cipher suite with one known to work, to test
		// cross-version resumption attempts.
		hs.sessionState.cipherSuite = TLS_RSA_WITH_AES_128_CBC_SHA
	} else {
		// Never resume a session for a different SSL version.
		if c.vers != hs.sessionState.vers {
			return false
		}

		cipherSuiteOk := false
		// Check that the client is still offering the ciphersuite in the session.
		for _, id := range hs.clientHello.cipherSuites {
			if id == hs.sessionState.cipherSuite {
				cipherSuiteOk = true
				break
			}
		}
		if !cipherSuiteOk {
			return false
		}
	}

	// Check that we also support the ciphersuite from the session.
	hs.suite = c.tryCipherSuite(hs.sessionState.cipherSuite, c.config.cipherSuites(), c.vers, hs.ellipticOk, hs.ecdsaOk)

	if hs.suite == nil {
		return false
	}

	sessionHasClientCerts := len(hs.sessionState.certificates) != 0
	needClientCerts := c.config.ClientAuth == RequireAnyClientCert || c.config.ClientAuth == RequireAndVerifyClientCert
	if needClientCerts && !sessionHasClientCerts {
		return false
	}
	if sessionHasClientCerts && c.config.ClientAuth == NoClientCert {
		return false
	}

	return true
}

func (hs *serverHandshakeState) doResumeHandshake() error {
	c := hs.c

	hs.hello.cipherSuite = hs.suite.id
	if c.config.Bugs.SendCipherSuite != 0 {
		hs.hello.cipherSuite = c.config.Bugs.SendCipherSuite
	}
	// We echo the client's session ID in the ServerHello to let it know
	// that we're doing a resumption.
	hs.hello.sessionID = hs.clientHello.sessionID
	hs.hello.extensions.ticketSupported = c.config.Bugs.RenewTicketOnResume

	if c.config.Bugs.SendSCTListOnResume != nil {
		hs.hello.extensions.sctList = c.config.Bugs.SendSCTListOnResume
	}

	if c.config.Bugs.SendOCSPResponseOnResume != nil {
		// There is no way, syntactically, to send an OCSP response on a
		// resumption handshake.
		hs.hello.extensions.ocspStapling = true
	}

	hs.finishedHash = newFinishedHash(c.wireVersion, c.isDTLS, hs.suite)
	hs.finishedHash.discardHandshakeBuffer()
	hs.writeClientHash(hs.clientHello.marshal())
	hs.writeServerHash(hs.hello.marshal())

	c.writeRecord(recordTypeHandshake, hs.hello.marshal())

	if len(hs.sessionState.certificates) > 0 {
		if _, err := hs.processCertsFromClient(hs.sessionState.certificates); err != nil {
			return err
		}
	}

	hs.masterSecret = hs.sessionState.secret
	c.extendedMasterSecret = hs.sessionState.extendedMasterSecret

	return nil
}

func (hs *serverHandshakeState) doFullHandshake() error {
	config := hs.c.config
	c := hs.c

	isPSK := hs.suite.flags&suitePSK != 0
	if !isPSK && hs.clientHello.ocspStapling && hs.cert.OCSPStaple != nil && !c.config.Bugs.NoOCSPStapling {
		hs.hello.extensions.ocspStapling = true
	}

	if hs.clientHello.sctListSupported && len(hs.cert.SignedCertificateTimestampList) > 0 && !c.config.Bugs.NoSignedCertificateTimestamps {
		hs.hello.extensions.sctList = hs.cert.SignedCertificateTimestampList
	}

	if len(c.clientVerify) > 0 && config.Bugs.SendSCTListOnRenegotiation != nil {
		hs.hello.extensions.sctList = config.Bugs.SendSCTListOnRenegotiation
	}

	hs.hello.extensions.ticketSupported = hs.clientHello.ticketSupported && !config.SessionTicketsDisabled
	hs.hello.cipherSuite = hs.suite.id
	if config.Bugs.SendCipherSuite != 0 {
		hs.hello.cipherSuite = config.Bugs.SendCipherSuite
	}
	c.extendedMasterSecret = hs.hello.extensions.extendedMasterSecret

	// Generate a session ID if we're to save the session.
	if !hs.hello.extensions.ticketSupported && config.ServerSessionCache != nil {
		l := config.Bugs.NewSessionIDLength
		if l == 0 {
			l = 32
		}
		hs.hello.sessionID = make([]byte, l)
		if _, err := io.ReadFull(config.rand(), hs.hello.sessionID); err != nil {
			c.sendAlert(alertInternalError)
			return errors.New("tls: short read from Rand: " + err.Error())
		}
	}
	if config.Bugs.EchoSessionIDInFullHandshake {
		hs.hello.sessionID = hs.clientHello.sessionID
	}

	hs.finishedHash = newFinishedHash(c.wireVersion, c.isDTLS, hs.suite)
	hs.writeClientHash(hs.clientHello.marshal())
	hs.writeServerHash(hs.hello.marshal())

	if config.Bugs.SendSNIWarningAlert {
		c.SendAlert(alertLevelWarning, alertUnrecognizedName)
	}

	c.writeRecord(recordTypeHandshake, hs.hello.marshal())

	if !isPSK {
		certMsg := new(certificateMsg)
		if !config.Bugs.EmptyCertificateList {
			for _, certData := range hs.cert.Certificate {
				certMsg.certificates = append(certMsg.certificates, certificateEntry{
					data: certData,
				})
			}
		}
		if !config.Bugs.UnauthenticatedECDH {
			certMsgBytes := certMsg.marshal()
			hs.writeServerHash(certMsgBytes)
			c.writeRecord(recordTypeHandshake, certMsgBytes)
		}
	}

	if hs.hello.extensions.ocspStapling && !c.config.Bugs.SkipCertificateStatus {
		certStatus := new(certificateStatusMsg)
		certStatus.statusType = statusTypeOCSP
		certStatus.response = hs.cert.OCSPStaple
		if len(c.clientVerify) > 0 && config.Bugs.SendOCSPResponseOnRenegotiation != nil {
			certStatus.response = config.Bugs.SendOCSPResponseOnRenegotiation
		}
		hs.writeServerHash(certStatus.marshal())
		c.writeRecord(recordTypeHandshake, certStatus.marshal())
	}

	keyAgreement := hs.suite.ka(c.vers)
	skx, err := keyAgreement.generateServerKeyExchange(config, hs.cert, hs.clientHello, hs.hello, c.vers)
	if err != nil {
		c.sendAlert(alertHandshakeFailure)
		return err
	}
	if ecdhe, ok := keyAgreement.(*ecdheKeyAgreement); ok {
		c.curveID = ecdhe.curveID
	}
	if skx != nil && !config.Bugs.SkipServerKeyExchange {
		hs.writeServerHash(skx.marshal())
		c.writeRecord(recordTypeHandshake, skx.marshal())
	}

	if config.ClientAuth >= RequestClientCert {
		// Request a client certificate
		certReq := &certificateRequestMsg{
			vers:             c.wireVersion,
			certificateTypes: config.ClientCertificateTypes,
		}
		if certReq.certificateTypes == nil {
			certReq.certificateTypes = []byte{CertTypeRSASign, CertTypeECDSASign}
		}
		if c.vers >= VersionTLS12 {
			certReq.hasSignatureAlgorithm = true
			if !config.Bugs.NoSignatureAlgorithms {
				certReq.signatureAlgorithms = config.verifySignatureAlgorithms()
			}
		}

		// An empty list of certificateAuthorities signals to
		// the client that it may send any certificate in response
		// to our request. When we know the CAs we trust, then
		// we can send them down, so that the client can choose
		// an appropriate certificate to give to us.
		if config.ClientCAs != nil {
			certReq.certificateAuthorities = config.ClientCAs.Subjects()
		}
		hs.writeServerHash(certReq.marshal())
		c.writeRecord(recordTypeHandshake, certReq.marshal())
	}

	helloDone := new(serverHelloDoneMsg)
	helloDoneBytes := helloDone.marshal()
	hs.writeServerHash(helloDoneBytes)
	var toAppend byte
	if config.Bugs.PartialNewSessionTicketWithServerHelloDone {
		toAppend = typeNewSessionTicket
	} else if config.Bugs.PartialFinishedWithServerHelloDone {
		toAppend = typeFinished
	}
	if toAppend != 0 {
		c.writeRecord(recordTypeHandshake, append(helloDoneBytes[:len(helloDoneBytes):len(helloDoneBytes)], toAppend))
	} else {
		c.writeRecord(recordTypeHandshake, helloDoneBytes)
	}
	if err := c.flushHandshake(); err != nil {
		return err
	}

	var pub crypto.PublicKey // public key for client auth, if any

	// If we requested a client certificate, then the client must send a
	// certificate message, even if it's empty.
	if config.ClientAuth >= RequestClientCert {
		certMsg, err := readHandshakeType[certificateMsg](c)
		if err != nil {
			return err
		}
		hs.writeClientHash(certMsg.marshal())

		if len(certMsg.certificates) == 0 {
			// The client didn't actually send a certificate
			switch config.ClientAuth {
			case RequireAnyClientCert, RequireAndVerifyClientCert:
				c.sendAlert(alertBadCertificate)
				return errors.New("tls: client didn't provide a certificate")
			}
		}

		var certificates [][]byte
		for _, cert := range certMsg.certificates {
			certificates = append(certificates, cert.data)
		}

		pub, err = hs.processCertsFromClient(certificates)
		if err != nil {
			return err
		}
	}

	// Get client key exchange
	ckx, err := readHandshakeType[clientKeyExchangeMsg](c)
	if err != nil {
		return err
	}
	hs.writeClientHash(ckx.marshal())

	preMasterSecret, err := keyAgreement.processClientKeyExchange(config, hs.cert, ckx, c.vers)
	if err != nil {
		c.sendAlert(alertHandshakeFailure)
		return err
	}
	if c.extendedMasterSecret {
		hs.masterSecret = extendedMasterFromPreMasterSecret(c.vers, hs.suite, preMasterSecret, hs.finishedHash)
	} else {
		if c.config.Bugs.RequireExtendedMasterSecret {
			return errors.New("tls: extended master secret required but not supported by peer")
		}
		hs.masterSecret = masterFromPreMasterSecret(c.vers, hs.suite, preMasterSecret, hs.clientHello.random, hs.hello.random)
	}

	// If we received a client cert in response to our certificate request message,
	// the client will send us a certificateVerifyMsg immediately after the
	// clientKeyExchangeMsg.  This message is a digest of all preceding
	// handshake-layer messages that is signed using the private key corresponding
	// to the client's certificate. This allows us to verify that the client is in
	// possession of the private key of the certificate.
	if len(c.peerCertificates) > 0 {
		certVerify, err := readHandshakeType[certificateVerifyMsg](c)
		if err != nil {
			return err
		}

		// Determine the signature type.
		var sigAlg signatureAlgorithm
		if certVerify.hasSignatureAlgorithm {
			sigAlg = certVerify.signatureAlgorithm
			c.peerSignatureAlgorithm = sigAlg
		}

		if err := verifyMessage(c.isClient, c.vers, pub, c.config, sigAlg, hs.finishedHash.buffer, certVerify.signature); err != nil {
			c.sendAlert(alertBadCertificate)
			return errors.New("could not validate signature of connection nonces: " + err.Error())
		}

		hs.writeClientHash(certVerify.marshal())
	}

	hs.finishedHash.discardHandshakeBuffer()

	return nil
}

func (hs *serverHandshakeState) establishKeys() error {
	c := hs.c

	clientMAC, serverMAC, clientKey, serverKey, clientIV, serverIV := keysFromMasterSecret(c.vers, hs.suite, hs.masterSecret, hs.clientHello.random, hs.hello.random, hs.suite.macLen, hs.suite.keyLen, hs.suite.ivLen(c.vers))

	var clientCipher, serverCipher any
	var clientHash, serverHash macFunction

	if hs.suite.aead == nil {
		clientCipher = hs.suite.cipher(clientKey, clientIV, true /* for reading */)
		clientHash = hs.suite.mac(c.vers, clientMAC)
		serverCipher = hs.suite.cipher(serverKey, serverIV, false /* not for reading */)
		serverHash = hs.suite.mac(c.vers, serverMAC)
	} else {
		clientCipher = hs.suite.aead(c.vers, clientKey, clientIV)
		serverCipher = hs.suite.aead(c.vers, serverKey, serverIV)
	}

	c.in.prepareCipherSpec(c.wireVersion, clientCipher, clientHash)
	c.out.prepareCipherSpec(c.wireVersion, serverCipher, serverHash)

	return nil
}

func (hs *serverHandshakeState) readFinished(out []byte, isResume bool) error {
	c := hs.c

	c.readRecord(recordTypeChangeCipherSpec)
	if err := c.in.error(); err != nil {
		return err
	}

	if hs.hello.extensions.nextProtoNeg {
		nextProto, err := readHandshakeType[nextProtoMsg](c)
		if err != nil {
			return err
		}
		hs.writeClientHash(nextProto.marshal())
		c.clientProtocol = nextProto.proto
	}

	if hs.hello.extensions.channelIDRequested {
		channelIDMsg, err := readHandshakeType[channelIDMsg](c)
		if err != nil {
			return err
		}
		var resumeHash []byte
		if isResume {
			resumeHash = hs.sessionState.handshakeHash
		}
		channelID, err := verifyChannelIDMessage(channelIDMsg, hs.finishedHash.hashForChannelID(resumeHash))
		if err != nil {
			return err
		}
		c.channelID = channelID

		hs.writeClientHash(channelIDMsg.marshal())
	}

	clientFinished, err := readHandshakeType[finishedMsg](c)
	if err != nil {
		return err
	}

	verify := hs.finishedHash.clientSum(hs.masterSecret)
	if len(verify) != len(clientFinished.verifyData) ||
		subtle.ConstantTimeCompare(verify, clientFinished.verifyData) != 1 {
		c.sendAlert(alertHandshakeFailure)
		return errors.New("tls: client's Finished message is incorrect")
	}
	c.clientVerify = append(c.clientVerify[:0], clientFinished.verifyData...)
	copy(out, clientFinished.verifyData)

	hs.writeClientHash(clientFinished.marshal())
	return nil
}

func (hs *serverHandshakeState) sendSessionTicket() error {
	c := hs.c
	state := sessionState{
		vers:          c.vers,
		cipherSuite:   hs.suite.id,
		secret:        hs.masterSecret,
		certificates:  hs.certsFromClient,
		handshakeHash: hs.finishedHash.Sum(),
	}

	if !hs.hello.extensions.ticketSupported || hs.c.config.Bugs.SkipNewSessionTicket {
		if c.config.ServerSessionCache != nil && len(hs.hello.sessionID) != 0 {
			c.config.ServerSessionCache.Put(string(hs.hello.sessionID), &state)
		}
		return nil
	}

	m := new(newSessionTicketMsg)
	m.vers = c.wireVersion
	m.isDTLS = c.isDTLS
	if c.config.Bugs.SendTicketLifetime != 0 {
		m.ticketLifetime = uint32(c.config.Bugs.SendTicketLifetime / time.Second)
	}

	if !c.config.Bugs.SendEmptySessionTicket {
		var err error
		m.ticket, err = c.encryptTicket(&state)
		if err != nil {
			return err
		}
	}

	hs.writeServerHash(m.marshal())
	if c.config.Bugs.PartialNewSessionTicketWithServerHelloDone {
		// The first byte was already sent.
		c.writeRecord(recordTypeHandshake, m.marshal()[1:])
	} else {
		c.writeRecord(recordTypeHandshake, m.marshal())
	}

	return nil
}

func (hs *serverHandshakeState) sendFinished(out []byte, isResume bool) error {
	c := hs.c

	finished := new(finishedMsg)
	finished.verifyData = hs.finishedHash.serverSum(hs.masterSecret)
	copy(out, finished.verifyData)
	if c.config.Bugs.BadFinished {
		finished.verifyData[0]++
	}
	c.serverVerify = append(c.serverVerify[:0], finished.verifyData...)
	hs.finishedBytes = finished.marshal()
	hs.writeServerHash(hs.finishedBytes)
	postCCSBytes := hs.finishedBytes
	if c.config.Bugs.PartialFinishedWithServerHelloDone {
		// The first byte has already been sent.
		postCCSBytes = postCCSBytes[1:]
	}

	if c.config.Bugs.FragmentAcrossChangeCipherSpec {
		c.writeRecord(recordTypeHandshake, postCCSBytes[:5])
		postCCSBytes = postCCSBytes[5:]
	}

	if !c.config.Bugs.SkipChangeCipherSpec {
		ccs := []byte{1}
		if c.config.Bugs.BadChangeCipherSpec != nil {
			ccs = c.config.Bugs.BadChangeCipherSpec
		}
		c.writeRecord(recordTypeChangeCipherSpec, ccs)
	}

	if c.config.Bugs.AppDataAfterChangeCipherSpec != nil {
		c.writeRecord(recordTypeApplicationData, c.config.Bugs.AppDataAfterChangeCipherSpec)
	}
	if c.config.Bugs.AlertAfterChangeCipherSpec != 0 {
		c.sendAlert(c.config.Bugs.AlertAfterChangeCipherSpec)
		return errors.New("tls: simulating post-CCS alert")
	}

	if !c.config.Bugs.SkipFinished && len(postCCSBytes) > 0 {
		c.writeRecord(recordTypeHandshake, postCCSBytes)
		if c.config.Bugs.SendExtraFinished {
			c.writeRecord(recordTypeHandshake, finished.marshal())
		}
	}

	if isResume || (!c.config.Bugs.PackHelloRequestWithFinished && !c.config.Bugs.PackAppDataWithHandshake) {
		// Defer flushing until Renegotiate() or Write().
		if err := c.flushHandshake(); err != nil {
			return err
		}
	}

	c.cipherSuite = hs.suite

	return nil
}

// processCertsFromClient takes a chain of client certificates either from a
// Certificates message or from a sessionState and verifies them. It returns
// the public key of the leaf certificate.
func (hs *serverHandshakeState) processCertsFromClient(certificates [][]byte) (crypto.PublicKey, error) {
	c := hs.c

	hs.certsFromClient = certificates
	certs := make([]*x509.Certificate, len(certificates))
	var err error
	for i, asn1Data := range certificates {
		if certs[i], err = x509.ParseCertificate(asn1Data); err != nil {
			c.sendAlert(alertBadCertificate)
			return nil, errors.New("tls: failed to parse client certificate: " + err.Error())
		}
	}

	if c.config.ClientAuth >= VerifyClientCertIfGiven && len(certs) > 0 {
		opts := x509.VerifyOptions{
			Roots:         c.config.ClientCAs,
			CurrentTime:   c.config.time(),
			Intermediates: x509.NewCertPool(),
			KeyUsages:     []x509.ExtKeyUsage{x509.ExtKeyUsageClientAuth},
		}

		for _, cert := range certs[1:] {
			opts.Intermediates.AddCert(cert)
		}

		chains, err := certs[0].Verify(opts)
		if err != nil {
			c.sendAlert(alertBadCertificate)
			return nil, errors.New("tls: failed to verify client's certificate: " + err.Error())
		}

		ok := false
		for _, ku := range certs[0].ExtKeyUsage {
			if ku == x509.ExtKeyUsageClientAuth {
				ok = true
				break
			}
		}
		if !ok {
			c.sendAlert(alertHandshakeFailure)
			return nil, errors.New("tls: client's certificate's extended key usage doesn't permit it to be used for client authentication")
		}

		c.verifiedChains = chains
	}

	if len(certs) > 0 {
		pub := certs[0].PublicKey
		switch pub.(type) {
		case *ecdsa.PublicKey, *rsa.PublicKey, ed25519.PublicKey:
			break
		default:
			c.sendAlert(alertUnsupportedCertificate)
			return nil, fmt.Errorf("tls: client's certificate contains an unsupported public key of type %T", pub)
		}
		c.peerCertificates = certs
		return pub, nil
	}

	return nil, nil
}

func verifyChannelIDMessage(channelIDMsg *channelIDMsg, channelIDHash []byte) (*ecdsa.PublicKey, error) {
	x := new(big.Int).SetBytes(channelIDMsg.channelID[0:32])
	y := new(big.Int).SetBytes(channelIDMsg.channelID[32:64])
	r := new(big.Int).SetBytes(channelIDMsg.channelID[64:96])
	s := new(big.Int).SetBytes(channelIDMsg.channelID[96:128])
	if !elliptic.P256().IsOnCurve(x, y) {
		return nil, errors.New("tls: invalid channel ID public key")
	}
	channelID := &ecdsa.PublicKey{Curve: elliptic.P256(), X: x, Y: y}
	if !ecdsa.Verify(channelID, channelIDHash, r, s) {
		return nil, errors.New("tls: invalid channel ID signature")
	}
	return channelID, nil
}

func (hs *serverHandshakeState) writeServerHash(msg []byte) {
	// writeServerHash is called before writeRecord.
	hs.finishedHash.WriteHandshake(msg, hs.c.sendHandshakeSeq)
}

func (hs *serverHandshakeState) writeClientHash(msg []byte) {
	// writeClientHash is called after readHandshake.
	hs.finishedHash.WriteHandshake(msg, hs.c.recvHandshakeSeq-1)
}

// tryCipherSuite returns a cipherSuite with the given id if that cipher suite
// is acceptable to use.
func (c *Conn) tryCipherSuite(id uint16, supportedCipherSuites []uint16, version uint16, ellipticOk, ecdsaOk bool) *cipherSuite {
	candidate := mutualCipherSuite(supportedCipherSuites, id)
	if candidate == nil {
		return nil
	}

	// Don't select a ciphersuite which we can't
	// support for this client.
	if version >= VersionTLS13 || candidate.flags&suiteTLS13 != 0 {
		if version < VersionTLS13 || candidate.flags&suiteTLS13 == 0 {
			return nil
		}
		return candidate
	}
	if (candidate.flags&suiteECDHE != 0) && !ellipticOk {
		return nil
	}
	if (candidate.flags&suiteECDSA != 0) != ecdsaOk {
		return nil
	}
	if version < VersionTLS12 && candidate.flags&suiteTLS12 != 0 {
		return nil
	}
	return candidate
}

func isTLS12Cipher(id uint16) bool {
	cipher := cipherSuiteFromID(id)
	return cipher != nil && cipher.flags&suiteTLS12 != 0
}

func isGREASEValue(val uint16) bool {
	return val&0x0f0f == 0x0a0a && val&0xff == val>>8
}

func verifyPSKBinder(version uint16, isDTLS bool, clientHello *clientHelloMsg, sessionState *sessionState, binderToVerify, firstClientHello, helloRetryRequest []byte) error {
	binderLen := 2
	for _, binder := range clientHello.pskBinders {
		binderLen += 1 + len(binder)
	}

	truncatedHello := clientHello.marshal()
	truncatedHello = truncatedHello[:len(truncatedHello)-binderLen]
	pskCipherSuite := cipherSuiteFromID(sessionState.cipherSuite)
	if pskCipherSuite == nil {
		return errors.New("tls: Unknown cipher suite for PSK in session")
	}

	binder := computePSKBinder(sessionState.secret, version, isDTLS, resumptionPSKBinderLabel, pskCipherSuite, firstClientHello, helloRetryRequest, truncatedHello)
	if !bytes.Equal(binder, binderToVerify) {
		return errors.New("tls: PSK binder does not verify")
	}

	return nil
}

// checkClientHellosEqual checks whether a and b are equal ClientHello
// messages. If isDTLS is true, the ClientHellos are parsed as DTLS and any
// differences in the cookie field are ignored. Extensions listed in
// ignoreExtensions may change or be removed between the two ClientHellos.
func checkClientHellosEqual(a, b []byte, isDTLS bool, ignoreExtensions []uint16) error {
	ignoreExtensionsSet := make(map[uint16]struct{})
	for _, ext := range ignoreExtensions {
		ignoreExtensionsSet[ext] = struct{}{}
	}

	// Skip the handshake message header.
	aReader := cryptobyte.String(a[4:])
	bReader := cryptobyte.String(b[4:])

	var aVers, bVers uint16
	var aRandom, bRandom []byte
	var aSessionID, bSessionID []byte
	if !aReader.ReadUint16(&aVers) ||
		!bReader.ReadUint16(&bVers) ||
		!aReader.ReadBytes(&aRandom, 32) ||
		!bReader.ReadBytes(&bRandom, 32) ||
		!readUint8LengthPrefixedBytes(&aReader, &aSessionID) ||
		!readUint8LengthPrefixedBytes(&bReader, &bSessionID) {
		return errors.New("tls: could not parse ClientHello")
	}

	if aVers != bVers {
		return errors.New("tls: second ClientHello version did not match")
	}
	if !bytes.Equal(aRandom, bRandom) {
		return errors.New("tls: second ClientHello random did not match")
	}
	if !bytes.Equal(aSessionID, bSessionID) {
		return errors.New("tls: second ClientHello session ID did not match")
	}

	if isDTLS {
		// DTLS 1.2 checks two ClientHellos match after a HelloVerifyRequest,
		// where we expect the cookies to change. DTLS 1.3 forbids the legacy
		// cookie altogether. If we implement DTLS 1.3, we'll need to ensure
		// that parsing logic above this function rejects this cookie.
		var aCookie, bCookie []byte
		if !readUint8LengthPrefixedBytes(&aReader, &aCookie) ||
			!readUint8LengthPrefixedBytes(&bReader, &bCookie) {
			return errors.New("tls: could not parse ClientHello")
		}
	}

	var aCipherSuites, bCipherSuites, aCompressionMethods, bCompressionMethods []byte
	if !readUint16LengthPrefixedBytes(&aReader, &aCipherSuites) ||
		!readUint16LengthPrefixedBytes(&bReader, &bCipherSuites) ||
		!readUint8LengthPrefixedBytes(&aReader, &aCompressionMethods) ||
		!readUint8LengthPrefixedBytes(&bReader, &bCompressionMethods) {
		return errors.New("tls: could not parse ClientHello")
	}
	if !bytes.Equal(aCipherSuites, bCipherSuites) {
		return errors.New("tls: second ClientHello cipher suites did not match")
	}
	if !bytes.Equal(aCompressionMethods, bCompressionMethods) {
		return errors.New("tls: second ClientHello compression methods did not match")
	}

	if len(aReader) == 0 && len(bReader) == 0 {
		// Both ClientHellos omit the extensions block.
		return nil
	}

	var aExtensions, bExtensions cryptobyte.String
	if !aReader.ReadUint16LengthPrefixed(&aExtensions) ||
		!bReader.ReadUint16LengthPrefixed(&bExtensions) ||
		len(aReader) != 0 ||
		len(bReader) != 0 {
		return errors.New("tls: could not parse ClientHello")
	}

	for len(aExtensions) != 0 {
		var aID uint16
		var aBody []byte
		if !aExtensions.ReadUint16(&aID) ||
			!readUint16LengthPrefixedBytes(&aExtensions, &aBody) {
			return errors.New("tls: could not parse ClientHello")
		}
		if _, ok := ignoreExtensionsSet[aID]; ok {
			continue
		}

		for {
			if len(bExtensions) == 0 {
				return fmt.Errorf("tls: second ClientHello missing extension %d", aID)
			}
			var bID uint16
			var bBody []byte
			if !bExtensions.ReadUint16(&bID) ||
				!readUint16LengthPrefixedBytes(&bExtensions, &bBody) {
				return errors.New("tls: could not parse ClientHello")
			}
			if _, ok := ignoreExtensionsSet[bID]; ok {
				continue
			}
			if aID != bID {
				return fmt.Errorf("tls: unexpected extension %d in second ClientHello (wanted %d)", bID, aID)
			}
			if !bytes.Equal(aBody, bBody) {
				return fmt.Errorf("tls: extension %d in second ClientHello unexpectedly changed", aID)
			}
			break
		}
	}

	// Any remaining extensions in the second ClientHello must be in the
	// ignored set.
	for len(bExtensions) != 0 {
		var id uint16
		var body []byte
		if !bExtensions.ReadUint16(&id) ||
			!readUint16LengthPrefixedBytes(&bExtensions, &body) {
			return errors.New("tls: could not parse ClientHello")
		}
		if _, ok := ignoreExtensionsSet[id]; !ok {
			return fmt.Errorf("tls: unexpected extension %d in second ClientHello", id)
		}
	}

	return nil
}
