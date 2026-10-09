//go:build !unix

package omprpc

import (
	"errors"
	"os/exec"
)

// prepareCommand leaves the command as is: process groups are Unix-only.
func prepareCommand(*exec.Cmd) {}

func processGroup(*exec.Cmd) int {
	return 0
}

// terminate kills the server process; its descendants are not reached.
func (p *process) terminate() error {
	if p.exitedWithin(0) {
		return nil
	}
	_ = p.cmd.Process.Kill()
	if !p.exitedWithin(processGrace) {
		return errors.New("omprpc: server process survived Kill")
	}
	return nil
}
