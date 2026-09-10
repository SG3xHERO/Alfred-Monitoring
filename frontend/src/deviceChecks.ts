/**
 * v1 config-builder checkboxes — Windows-only monitoring the agent can watch
 * for. Shared between the Add Server modal and each server's Edit panel so
 * the two stay in sync as this list grows.
 */
export const CHECK_OPTIONS = [
  { key: "lockout_monitoring", label: "AD account lockouts", hint: "domain controllers only — needs Security-log read rights" },
  { key: "sql_monitoring", label: "SQL Server monitoring", hint: "enables the diagnostic snapshot panel" },
  { key: "signed_in_users_panel", label: "Signed-in users panel", hint: "shows who's logged in on the device page" },
] as const;
