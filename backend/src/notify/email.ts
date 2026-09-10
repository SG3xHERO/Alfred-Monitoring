import { query } from "../db.js";
import { getSetting, getSettingNumber } from "../settings.js";
import { logNotification } from "./log.js";
import { sendViaSmtp } from "./smtp.js";

const SENDGRID_URL = "https://api.sendgrid.com/v3/mail/send";

export interface Mail {
  to: string[];
  subject: string;
  html: string;
  text: string;
  /** RFC 5322 threading — set together so every email about one incident lands as one conversation instead of separate emails. */
  messageId?: string;
  inReplyTo?: string;
  references?: string;
}

/**
 * Sends via the configured provider (sendgrid | smtp | disabled), guarded by
 * the global max-emails-per-hour valve. Every attempt (sent or suppressed)
 * is written to email_log.
 */
export async function sendMail(mail: Mail): Promise<boolean> {
  const provider = getSetting("email.provider");
  const from = await getFromAddress();

  const maxPerHour = getSettingNumber("email.max_per_hour");
  const { rows } = await query(
    `SELECT count(*)::int AS n FROM email_log
     WHERE sent_at > now() - interval '1 hour' AND NOT suppressed`,
  );
  if (rows[0].n >= maxPerHour) {
    await logEmail(mail, true, `global rate valve: ${maxPerHour}/hour reached`);
    console.warn(`email suppressed by rate valve: ${mail.subject}`);
    return false;
  }

  if (provider === "disabled") {
    await logEmail(mail, true, "email provider is disabled — configure one in Settings");
    console.warn(`email not sent (provider disabled): ${mail.subject} -> ${mail.to.join(", ")}`);
    return false;
  }

  try {
    if (provider === "smtp") {
      await sendViaSmtp(mail, from);
    } else {
      await sendViaSendgrid(mail, from);
    }
    await logEmail(mail, false, null);
    return true;
  } catch (err: any) {
    await logEmail(mail, true, `${provider}: ${String(err.message).slice(0, 300)}`);
    console.error(`${provider} send error: ${err.message}`);
    return false;
  }
}

async function sendViaSendgrid(mail: Mail, from: { name: string; email: string }): Promise<void> {
  const apiKey = getSetting("email.sendgrid_api_key");
  if (!apiKey) throw new Error("SendGrid API key is not configured");

  const [primary, ...rest] = mail.to;
  const personalization: { to: { email: string }[]; cc?: { email: string }[] } = {
    to: [{ email: primary }],
  };
  if (rest.length > 0) personalization.cc = rest.map((e) => ({ email: e }));

  const headers: Record<string, string> = {};
  if (mail.messageId) headers["Message-ID"] = mail.messageId;
  if (mail.inReplyTo) headers["In-Reply-To"] = mail.inReplyTo;
  if (mail.references) headers["References"] = mail.references;

  const body = {
    personalizations: [personalization],
    from: { email: from.email, name: from.name },
    subject: mail.subject,
    content: [
      { type: "text/plain", value: mail.text },
      { type: "text/html", value: mail.html },
    ],
    ...(Object.keys(headers).length > 0 ? { headers } : {}),
  };

  const res = await fetch(SENDGRID_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const detail = await res.text();
    throw new Error(`HTTP ${res.status}: ${detail.slice(0, 300)}`);
  }
}

/** From name/address is configurable on the Settings page (email_settings table). */
async function getFromAddress(): Promise<{ name: string; email: string }> {
  try {
    const { rows } = await query(`SELECT from_name, from_local, from_domain FROM email_settings WHERE id = 1`);
    if (rows.length > 0) {
      const s = rows[0];
      return { name: s.from_name, email: `${s.from_local}@${s.from_domain}` };
    }
  } catch {
    // table may not exist yet on first boot before schema is applied
  }
  return { name: "Alfred Monitoring", email: "alfred@localhost" };
}

async function logEmail(mail: Mail, suppressed: boolean, reason: string | null) {
  await logNotification("email", mail.to.join(", "), mail.subject, suppressed, reason);
}

// ---------- templates (in-house HTML, plain-text fallback) ----------

export interface AlertMailInput {
  serverName: string;
  serverId: number;
  brand: string;
  ruleName: string;
  checkKey: string;
  condition: string;
  severity: string;
  message: string;
  firstSeen: Date;
  resolved: boolean;
  metrics: Array<[string, string]>;
}

export function buildAlertMail(input: AlertMailInput): { html: string; text: string } {
  const base = getSetting("base_url").replace(/\/$/, "");
  const link = `${base}/servers/${input.serverId}`;
  const color = input.resolved ? "#1a7f42" : input.severity === "critical" ? "#c0262c" : "#b45309";
  const banner = input.resolved ? "RESOLVED" : input.severity.toUpperCase();

  const metricsRows = input.metrics
    .map(
      ([k, v]) => `<tr>
        <td style="padding:6px 12px;border-bottom:1px solid #e8e8e4;color:#666;font-size:13px">${esc(k)}</td>
        <td style="padding:6px 12px;border-bottom:1px solid #e8e8e4;font-family:ui-monospace,Consolas,monospace;font-size:13px">${esc(v)}</td>
      </tr>`,
    )
    .join("\n");

  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f2;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#16181d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e2de">
  <tr><td style="background:${color};color:#ffffff;padding:10px 20px;font-size:13px;font-weight:600;letter-spacing:0.08em">${banner}</td></tr>
  <tr><td style="padding:20px 20px 4px">
    <div style="font-size:18px;font-weight:600">${esc(input.serverName)}</div>
    <div style="font-size:13px;color:#666;margin-top:2px">${esc(input.brand)}</div>
  </td></tr>
  <tr><td style="padding:12px 20px 4px;font-size:14px;line-height:1.5">
    ${esc(input.message)}
  </td></tr>
  <tr><td style="padding:4px 20px;font-size:12px;color:#666">
    Rule <code style="font-family:ui-monospace,Consolas,monospace">${esc(input.ruleName)} / ${esc(input.checkKey)}</code>
    &nbsp;·&nbsp; condition <code style="font-family:ui-monospace,Consolas,monospace">${esc(input.condition)}</code><br>
    First seen: ${input.firstSeen.toISOString().replace("T", " ").slice(0, 19)} UTC
  </td></tr>
  ${metricsRows ? `<tr><td style="padding:12px 20px">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e8e8e4">${metricsRows}</table>
  </td></tr>` : ""}
  <tr><td style="padding:8px 20px 20px">
    <a href="${link}" style="display:inline-block;background:#16181d;color:#ffffff;text-decoration:none;padding:8px 16px;font-size:13px">Open dashboard</a>
  </td></tr>
</table>
<div style="font-size:11px;color:#999;padding:12px">Alfred Monitoring — ${esc(getSetting("org.name"))}</div>
</td></tr></table>
</body></html>`;

  const text = [
    `[${banner}] ${input.serverName} (${input.brand})`,
    "",
    input.message,
    "",
    `Rule: ${input.ruleName} / ${input.checkKey}`,
    `Condition: ${input.condition}`,
    `First seen: ${input.firstSeen.toISOString()}`,
    "",
    ...input.metrics.map(([k, v]) => `${k}: ${v}`),
    "",
    `Dashboard: ${link}`,
  ].join("\n");

  return { html, text };
}

export function buildResetMail(input: { resetUrl: string }): { html: string; text: string } {
  const html = `<!doctype html>
<html><body style="margin:0;padding:24px;background:#f4f4f2;font-family:-apple-system,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#16181d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center">
<table role="presentation" width="480" cellpadding="0" cellspacing="0" style="background:#ffffff;border:1px solid #e2e2de">
  <tr><td style="padding:20px 20px 4px">
    <div style="font-size:18px;font-weight:600">Reset your password</div>
  </td></tr>
  <tr><td style="padding:12px 20px 4px;font-size:14px;line-height:1.5">
    Someone (hopefully you) requested a password reset for your Alfred account.
    This link expires in 1 hour and can only be used once.
  </td></tr>
  <tr><td style="padding:8px 20px 20px">
    <a href="${esc(input.resetUrl)}" style="display:inline-block;background:#16181d;color:#ffffff;text-decoration:none;padding:8px 16px;font-size:13px">Reset password</a>
  </td></tr>
  <tr><td style="padding:0 20px 20px;font-size:12px;color:#666">
    If you didn't request this, you can safely ignore this email.
  </td></tr>
</table>
<div style="font-size:11px;color:#999;padding:12px">Alfred Monitoring — ${esc(getSetting("org.name"))}</div>
</td></tr></table>
</body></html>`;

  const text = [
    "Reset your password",
    "",
    "Someone (hopefully you) requested a password reset for your Alfred account.",
    "This link expires in 1 hour and can only be used once.",
    "",
    input.resetUrl,
    "",
    "If you didn't request this, you can safely ignore this email.",
  ].join("\n");

  return { html, text };
}

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}
