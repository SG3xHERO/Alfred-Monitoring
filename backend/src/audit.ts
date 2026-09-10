import { query } from "./db.js";

/**
 * One audit entry per mutating admin action. Failures are swallowed — an
 * audit hiccup must never fail the action it describes.
 */
export async function audit(
  username: string,
  action: string,
  targetType: string | null = null,
  targetId: string | number | null = null,
  detail: Record<string, unknown> | null = null,
): Promise<void> {
  try {
    await query(
      `INSERT INTO audit_log (username, action, target_type, target_id, detail)
       VALUES ($1, $2, $3, $4, $5)`,
      [username, action, targetType, targetId != null ? String(targetId) : null,
        detail ? JSON.stringify(detail) : null],
    );
  } catch (err: any) {
    console.error("audit write failed:", err.message);
  }
}
