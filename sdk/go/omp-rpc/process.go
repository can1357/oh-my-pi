package omprpc

import (
	"errors"
	"io"
	"os"
	"os/exec"
	"strings"
	"time"
)

// processGrace bounds each teardown step: the leader's exit after SIGTERM,
// after SIGKILL, the group's emptying after SIGKILL, and the end of stdout.
const processGrace = time.Second

// process is a server Start launched. On Unix it leads its own process group,
// so teardown reaches descendants that stay in that group.
type process struct {
	cmd    *exec.Cmd
	pgid   int
	stdout *os.File
	exited chan struct{}
}

// startProcess starts cmd with fresh stdin/stdout pipes and reaps it in the
// background. The pipes are plain files, so reaping never closes stdout under
// the reader.
func startProcess(cmd *exec.Cmd) (*process, io.WriteCloser, error) {
	if cmd.Stdin != nil || cmd.Stdout != nil {
		return nil, nil, errors.New("omprpc: Start owns the command's Stdin and Stdout; leave them nil")
	}
	stdinR, stdinW, err := os.Pipe()
	if err != nil {
		return nil, nil, err
	}
	stdoutR, stdoutW, err := os.Pipe()
	if err != nil {
		_ = stdinR.Close()
		_ = stdinW.Close()
		return nil, nil, err
	}
	cmd.Stdin, cmd.Stdout = stdinR, stdoutW
	keepMCPOff(cmd)
	prepareCommand(cmd)
	if cmd.WaitDelay == 0 {
		// Bounds Wait when a descendant keeps a Stderr pipe open.
		cmd.WaitDelay = processGrace
	}
	err = cmd.Start()
	_ = stdinR.Close()
	_ = stdoutW.Close()
	if err != nil {
		_ = stdinW.Close()
		_ = stdoutR.Close()
		return nil, nil, err
	}
	p := &process{cmd: cmd, pgid: processGroup(cmd), stdout: stdoutR, exited: make(chan struct{})}
	go func() {
		_ = cmd.Wait()
		close(p.exited)
	}()
	return p, stdinW, nil
}

func (p *process) exitedWithin(timeout time.Duration) bool {
	if timeout <= 0 {
		select {
		case <-p.exited:
			return true
		default:
			return false
		}
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	select {
	case <-p.exited:
		return true
	case <-timer.C:
		return false
	}
}

// stop terminates the process (stdin is already closed) and ends the reader:
// after processGrace without EOF, stdout is closed under it.
func (p *process) stop(drained <-chan struct{}) error {
	err := p.terminate()
	timer := time.NewTimer(processGrace)
	defer timer.Stop()
	select {
	case <-drained:
	case <-timer.C:
	}
	_ = p.stdout.Close()
	<-drained
	return err
}

// truthyFlagValues are the values omp reads as true for a boolean environment
// flag (pi-utils parseFlag).
var truthyFlagValues = map[string]bool{
	"1": true, "Y": true, "y": true, "TRUE": true, "true": true, "YES": true, "yes": true, "ON": true, "on": true,
}

// keepMCPOff keeps MCP off for the server while this host has it off
// (PI_NO_MCP set to a value omp reads as true): an explicit cmd.Env cannot turn
// it back on. A cmd without Env inherits the host's value already.
func keepMCPOff(cmd *exec.Cmd) {
	if cmd.Env == nil || !truthyFlagValues[os.Getenv("PI_NO_MCP")] {
		return
	}
	env := make([]string, 0, len(cmd.Env)+1)
	for _, entry := range cmd.Env {
		if !strings.HasPrefix(entry, "PI_NO_MCP=") {
			env = append(env, entry)
		}
	}
	cmd.Env = append(env, "PI_NO_MCP=1")
}
