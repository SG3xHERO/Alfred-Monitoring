//go:build linux

package collect

import (
	"bufio"
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"strings"
	"time"

	"github.com/sg3xhero/alfred/agent/internal/config"
)

func (c *Collector) collectPlatform(snap *Snapshot, cfg *config.Config) {
	snap.SystemdFailedUnits = systemdFailedUnits()
	snap.RebootRequired = fileExists("/var/run/reboot-required")

	for _, svc := range cfg.Checks.Services {
		snap.Services = append(snap.Services, CheckResult{
			Name:    svc,
			Running: systemdActive(svc),
		})
	}

	// apt updates are expensive to compute; refresh on a slow cadence and cache
	if time.Since(c.lastUpdates) > time.Duration(cfg.Checks.UpdatesIntervalSeconds)*time.Second {
		c.cachedUpd = pendingAptUpdates()
		c.lastUpdates = time.Now()
	}
	snap.PendingUpdates = c.cachedUpd

	if cfg.Checks.SmartEnabled && time.Since(c.lastSmart) > time.Duration(cfg.Checks.SmartIntervalSeconds)*time.Second {
		c.cachedSmart = smartHealth()
		c.lastSmart = time.Now()
	}
	snap.Smart = c.cachedSmart
}

func fileExists(p string) bool {
	_, err := os.Stat(p)
	return err == nil
}

func systemdActive(unit string) bool {
	out, err := runCmd(5*time.Second, "systemctl", "is-active", unit)
	return err == nil && strings.TrimSpace(out) == "active"
}

func systemdFailedUnits() []string {
	out, err := runCmd(5*time.Second, "systemctl", "--failed", "--no-legend", "--plain", "--no-pager")
	if err != nil {
		return nil
	}
	var units []string
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		fields := strings.Fields(sc.Text())
		if len(fields) > 0 && strings.Contains(fields[0], ".") {
			units = append(units, fields[0])
		}
	}
	return units
}

func pendingAptUpdates() int {
	// simulation mode, no lock taken; safe to run alongside real apt operations
	out, err := runCmd(60*time.Second, "apt-get", "-s", "-o", "Debug::NoLocking=true", "upgrade")
	if err != nil {
		return 0
	}
	count := 0
	sc := bufio.NewScanner(strings.NewReader(out))
	for sc.Scan() {
		if strings.HasPrefix(sc.Text(), "Inst ") {
			count++
		}
	}
	return count
}

type smartScan struct {
	Devices []struct {
		Name string `json:"name"`
	} `json:"devices"`
}

type smartStatus struct {
	SmartStatus struct {
		Passed bool `json:"passed"`
	} `json:"smart_status"`
}

func smartHealth() []SmartResult {
	if _, err := exec.LookPath("smartctl"); err != nil {
		return nil
	}
	out, err := runCmd(30*time.Second, "smartctl", "--scan", "-j")
	if err != nil {
		return nil
	}
	var scan smartScan
	if json.Unmarshal([]byte(out), &scan) != nil {
		return nil
	}
	var results []SmartResult
	for _, d := range scan.Devices {
		hout, err := runCmd(30*time.Second, "smartctl", "-H", "-j", d.Name)
		if err != nil && hout == "" {
			continue
		}
		var st smartStatus
		if json.Unmarshal([]byte(hout), &st) == nil {
			results = append(results, SmartResult{Device: d.Name, Passed: st.SmartStatus.Passed})
		}
	}
	return results
}

func runCmd(timeout time.Duration, name string, args ...string) (string, error) {
	cmd := exec.Command(name, args...)
	var buf bytes.Buffer
	cmd.Stdout = &buf
	cmd.Stderr = &buf
	if err := cmd.Start(); err != nil {
		return "", err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		return buf.String(), err
	case <-time.After(timeout):
		_ = cmd.Process.Kill()
		<-done
		return buf.String(), os.ErrDeadlineExceeded
	}
}
