//go:build windows

package collect

import (
	"bytes"
	"encoding/json"
	"errors"
	"os/exec"
	"strings"
	"syscall"
	"time"
)

// captureSqlSnapshotScript uses System.Data.SqlClient (ships with .NET
// Framework / Windows PowerShell — no extra module or driver to install) with
// Integrated Security, so it relies entirely on the agent's Windows service
// account already having a SQL Server login. Query text is truncated to 2000
// chars to keep the JSON payload bounded.
const captureSqlSnapshotScript = `
$ErrorActionPreference = 'Stop'
try {
  $conn = New-Object System.Data.SqlClient.SqlConnection("Server=localhost;Integrated Security=True;Connection Timeout=5;")
  $conn.Open()
  function Run-Query($sql) {
    $cmd = New-Object System.Data.SqlClient.SqlCommand($sql, $conn)
    $cmd.CommandTimeout = 20
    $da = New-Object System.Data.SqlClient.SqlDataAdapter($cmd)
    $dt = New-Object System.Data.DataTable
    [void]$da.Fill($dt)
    return $dt
  }
  $topQueriesSql = "SELECT TOP 20 DB_NAME(st.dbid) AS DatabaseName, SUBSTRING(st.text, (qs.statement_start_offset/2)+1, (CASE WHEN qs.statement_end_offset = -1 THEN 2000 ELSE (qs.statement_end_offset - qs.statement_start_offset)/2 + 1 END)) AS QueryText, qs.total_worker_time/1000.0 AS TotalCpuMs, (qs.total_worker_time/1000.0)/qs.execution_count AS AvgCpuMs, qs.execution_count AS ExecutionCount, qs.last_execution_time AS LastExecutionTime FROM sys.dm_exec_query_stats qs CROSS APPLY sys.dm_exec_sql_text(qs.sql_handle) st ORDER BY qs.total_worker_time DESC"
  $blockingSql = "SELECT r.blocking_session_id AS BlockingSessionID, r.session_id AS BlockedSessionID, r.wait_type AS WaitType, r.wait_time AS WaitTimeMs, SUBSTRING(st.text, 1, 2000) AS BlockedQueryText FROM sys.dm_exec_requests r CROSS APPLY sys.dm_exec_sql_text(r.sql_handle) st WHERE r.blocking_session_id <> 0"
  $jobsSql = "SELECT j.name AS JobName, CASE WHEN ja.start_execution_date IS NOT NULL AND ja.stop_execution_date IS NULL THEN 'Executing' ELSE 'Idle' END AS Status, CASE jh.run_status WHEN 0 THEN 'Failed' WHEN 1 THEN 'Succeeded' WHEN 2 THEN 'Retry' WHEN 3 THEN 'Canceled' ELSE 'Unknown' END AS LastRunOutcome, CONVERT(varchar, jh.run_date) AS LastRunDate FROM msdb.dbo.sysjobs j LEFT JOIN msdb.dbo.sysjobactivity ja ON ja.job_id = j.job_id AND ja.session_id = (SELECT MAX(session_id) FROM msdb.dbo.syssessions) OUTER APPLY (SELECT TOP 1 * FROM msdb.dbo.sysjobhistory h WHERE h.job_id = j.job_id AND h.step_id = 0 ORDER BY h.run_date DESC, h.run_time DESC) jh WHERE j.enabled = 1"

  $topQueries = Run-Query $topQueriesSql
  $blocking = Run-Query $blockingSql
  $jobs = Run-Query $jobsSql
  $conn.Close()

  $result = [ordered]@{
    top_queries = @($topQueries | Select-Object DatabaseName,QueryText,TotalCpuMs,AvgCpuMs,ExecutionCount,LastExecutionTime)
    blocking    = @($blocking | Select-Object BlockingSessionID,BlockedSessionID,WaitType,WaitTimeMs,BlockedQueryText)
    jobs        = @($jobs | Select-Object JobName,Status,LastRunOutcome,LastRunDate)
  }
  ConvertTo-Json $result -Depth 5 -Compress
} catch {
  ConvertTo-Json @{ error = $_.Exception.Message } -Compress
}
`

type sqlSnapshotResult struct {
	TopQueries []SqlQueryStat `json:"top_queries"`
	Blocking   []SqlBlockRow  `json:"blocking"`
	Jobs       []SqlJobRow    `json:"jobs"`
	Error      string         `json:"error"`
}

// CaptureSqlSnapshot shells out to PowerShell (same pattern as queryEventLog)
// rather than adding a Go SQL Server driver dependency. Only ever called
// event-triggered (rule fire or manual button) — never on the periodic tick.
func CaptureSqlSnapshot(timeout time.Duration) (*SqlSnapshot, error) {
	cmd := exec.Command("powershell", "-NoProfile", "-NonInteractive", "-Command", captureSqlSnapshotScript)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	var buf bytes.Buffer
	cmd.Stdout = &buf
	if err := cmd.Start(); err != nil {
		return nil, err
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	select {
	case err := <-done:
		if err != nil {
			return nil, err
		}
	case <-time.After(timeout):
		_ = cmd.Process.Kill()
		<-done
		return nil, errors.New("sql snapshot capture timed out")
	}

	raw := strings.TrimSpace(buf.String())
	if raw == "" {
		return nil, errors.New("sql snapshot capture produced no output")
	}
	var result sqlSnapshotResult
	if err := json.Unmarshal([]byte(raw), &result); err != nil {
		return nil, err
	}
	if result.Error != "" {
		return nil, errors.New(result.Error)
	}
	return &SqlSnapshot{TopQueries: result.TopQueries, Blocking: result.Blocking, Jobs: result.Jobs}, nil
}
