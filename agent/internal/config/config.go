package config

import (
	"fmt"
	"os"
	"runtime"
	"time"

	"gopkg.in/yaml.v3"
)

type Checks struct {
	Services                []string `yaml:"services"`
	Processes               []string `yaml:"processes"`
	EventLogIntervalSeconds int      `yaml:"eventlog_interval_seconds"`
	UpdatesIntervalSeconds  int      `yaml:"updates_interval_seconds"`
	SmartEnabled            bool     `yaml:"smart_enabled"`
	SmartIntervalSeconds    int      `yaml:"smart_interval_seconds"`
	// Security-log lockout monitoring (event 4740) is opt-in: it needs the
	// agent's service account to have Security-log read rights, which isn't
	// granted on every host, so a misconfigured agent shouldn't start erroring.
	LockoutMonitoring bool `yaml:"lockout_monitoring"`
	// Gates the SQL diagnostic snapshot capture (see sql_snapshot.go) so it's
	// never attempted against a box that isn't actually running SQL Server.
	SqlMonitoring bool `yaml:"sql_monitoring"`
	// Windows only: whether the device page's signed-in-users panel applies
	// to this box. Sessions are collected either way (other checks use
	// them); this only tells the backend the panel is relevant.
	SignedInUsersPanel bool `yaml:"signed_in_users_panel"`
}

type Config struct {
	BackendURL         string `yaml:"backend_url"`
	APIKey             string `yaml:"api_key"`
	Hostname           string `yaml:"hostname"` // optional override
	IntervalSeconds    int    `yaml:"interval_seconds"`
	InsecureSkipVerify bool   `yaml:"insecure_skip_verify"`
	Checks             Checks `yaml:"checks"`
}

func DefaultPath() string {
	if runtime.GOOS == "windows" {
		return `C:\ProgramData\AlfredAgent\config.yaml`
	}
	return "/etc/alfred-agent/config.yaml"
}

func Load(path string) (*Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	cfg := &Config{IntervalSeconds: 15}
	if err := yaml.Unmarshal(raw, cfg); err != nil {
		return nil, fmt.Errorf("parse %s: %w", path, err)
	}
	if cfg.BackendURL == "" {
		return nil, fmt.Errorf("%s: backend_url is required", path)
	}
	if cfg.APIKey == "" {
		return nil, fmt.Errorf("%s: api_key is required", path)
	}
	if cfg.IntervalSeconds < 5 {
		cfg.IntervalSeconds = 5
	}
	if cfg.Checks.EventLogIntervalSeconds <= 0 {
		cfg.Checks.EventLogIntervalSeconds = 300
	}
	if cfg.Checks.UpdatesIntervalSeconds <= 0 {
		cfg.Checks.UpdatesIntervalSeconds = 3600
	}
	if cfg.Checks.SmartIntervalSeconds <= 0 {
		cfg.Checks.SmartIntervalSeconds = 1800
	}
	return cfg, nil
}

func Mtime(path string) time.Time {
	st, err := os.Stat(path)
	if err != nil {
		return time.Time{}
	}
	return st.ModTime()
}

// ApplyPushed merges an admin's remotely-pushed check flags into the config
// file on disk, only if something actually differs from what's already
// running — so re-sending the same desired state on every poll (the ingest
// response always includes it, with no separate "did it apply yet"
// handshake) doesn't touch the file or spuriously log a reload every tick.
// The caller's next tick picks up the change via the existing mtime-based
// hot-reload in main.go — this never reloads in-process itself.
func ApplyPushed(path string, current *Config, lockout, sql, signedIn *bool) (changed bool, err error) {
	next := *current
	if lockout != nil && *lockout != next.Checks.LockoutMonitoring {
		next.Checks.LockoutMonitoring = *lockout
		changed = true
	}
	if sql != nil && *sql != next.Checks.SqlMonitoring {
		next.Checks.SqlMonitoring = *sql
		changed = true
	}
	if signedIn != nil && *signedIn != next.Checks.SignedInUsersPanel {
		next.Checks.SignedInUsersPanel = *signedIn
		changed = true
	}
	if !changed {
		return false, nil
	}
	out, err := yaml.Marshal(&next)
	if err != nil {
		return false, err
	}
	return true, os.WriteFile(path, out, 0644)
}
