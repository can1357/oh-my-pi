// Copyright 2023 The BoringSSL Authors
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//     https://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

package runner

import (
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"net"
	"os"
	"sync"
	"time"
)

type shimDispatcher struct {
	lock        sync.Mutex
	nextShimID  uint64
	listener    *net.TCPListener
	shims       map[uint64]*shimListener
	closedShims map[uint64]struct{}
	err         error
}

func newShimDispatcher() (*shimDispatcher, error) {
	listener, err := net.ListenTCP("tcp", &net.TCPAddr{IP: net.IPv6loopback})
	if err != nil {
		listener, err = net.ListenTCP("tcp4", &net.TCPAddr{IP: net.IP{127, 0, 0, 1}})
	}

	if err != nil {
		return nil, err
	}
	d := &shimDispatcher{listener: listener, shims: make(map[uint64]*shimListener), closedShims: make(map[uint64]struct{})}
	go d.acceptLoop()
	return d, nil
}

func (d *shimDispatcher) NewShim() (*shimListener, error) {
	d.lock.Lock()
	defer d.lock.Unlock()
	if d.err != nil {
		return nil, d.err
	}

	l := &shimListener{dispatcher: d, shimID: d.nextShimID, connChan: make(chan net.Conn, 1)}
	d.shims[l.shimID] = l
	d.nextShimID++
	return l, nil
}

func (d *shimDispatcher) unregisterShim(l *shimListener) {
	d.lock.Lock()
	delete(d.shims, l.shimID)
	d.closedShims[l.shimID] = struct{}{}
	d.lock.Unlock()
}

func (d *shimDispatcher) acceptLoop() {
	for {
		conn, err := d.listener.Accept()
		if err != nil {
			// Something went wrong. Shut down the listener.
			d.closeWithError(err)
			return
		}

		go func() {
			if err := d.dispatch(conn); err != nil {
				// To be robust against port scanners, etc., we log a warning
				// but otherwise treat undispatchable connections as non-fatal.
				fmt.Fprintf(os.Stderr, "Error dispatching connection: %s\n", err)
				conn.Close()
			}
		}()
	}
}

func (d *shimDispatcher) dispatch(conn net.Conn) error {
	conn.SetReadDeadline(time.Now().Add(*idleTimeout))
	var buf [8]byte
	if _, err := io.ReadFull(conn, buf[:]); err != nil {
		return err
	}
	conn.SetReadDeadline(time.Time{})

	shimID := binary.LittleEndian.Uint64(buf[:])
	d.lock.Lock()
	shim, ok := d.shims[shimID]
	_, closed := d.closedShims[shimID]
	d.lock.Unlock()
	if !ok {
		// If the shim is known but already closed, just silently reject the
		// connection. This may happen if runner fails the test at the shim's
		// first connection, but the shim tries to make a second connection
		// before it is killed.
		if closed {
			conn.Close()
			return nil
		}
		return fmt.Errorf("shim ID %d not found", shimID)
	}

	shim.connChan <- conn
	return nil
}

func (d *shimDispatcher) Close() error {
	return d.closeWithError(net.ErrClosed)
}

func (d *shimDispatcher) closeWithError(err error) error {
	closeErr := d.listener.Close()

	d.lock.Lock()
	shims := d.shims
	d.shims = make(map[uint64]*shimListener)
	d.err = err
	d.lock.Unlock()

	for _, shim := range shims {
		shim.closeWithError(err)
	}
	return closeErr
}

type shimListener struct {
	dispatcher *shimDispatcher
	shimID     uint64
	// connChan contains connections from the dispatcher. On fatal error, it is
	// closed, with the error available in err.
	connChan chan net.Conn
	err      error
	lock     sync.Mutex
}

func (l *shimListener) Port() int {
	return l.dispatcher.listener.Addr().(*net.TCPAddr).Port
}

func (l *shimListener) IsIPv6() bool {
	return len(l.dispatcher.listener.Addr().(*net.TCPAddr).IP) == net.IPv6len
}

func (l *shimListener) ShimID() uint64 {
	return l.shimID
}

func (l *shimListener) Close() error {
	l.dispatcher.unregisterShim(l)
	l.closeWithError(net.ErrClosed)
	return nil
}

func (l *shimListener) closeWithError(err error) {
	// Multiple threads may close the listener at once, so protect closing with
	// a lock.
	l.lock.Lock()
	if l.err == nil {
		l.err = err
		close(l.connChan)
	}
	l.lock.Unlock()
}

func (l *shimListener) Accept(deadline time.Time) (net.Conn, error) {
	var timerChan <-chan time.Time
	if !deadline.IsZero() {
		remaining := time.Until(deadline)
		if remaining < 0 {
			return nil, context.DeadlineExceeded
		}
		timer := time.NewTimer(remaining)
		defer timer.Stop()
		timerChan = timer.C
	}

	select {
	case <-timerChan:
		return nil, context.DeadlineExceeded
	case conn, ok := <-l.connChan:
		if !ok {
			return nil, l.err
		}
		return conn, nil
	}
}
