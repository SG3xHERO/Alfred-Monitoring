import { query } from "../db.js";

export type NotifyChannel = "email" | "slack" | "teams" | "webhook";

/** Records one delivery attempt (sent or suppressed) for any channel. */
export async function logNotification(
  channel: NotifyChannel,
  recipient: string,
  subject: string,
  suppressed: boolean,
  reason: string | null,
): Promise<void> {
  await query(
    `INSERT INTO email_log (recipient, subject, suppressed, reason, channel) VALUES ($1, $2, $3, $4, $5)`,
    [recipient, subject, suppressed, reason, channel],
  );
}
