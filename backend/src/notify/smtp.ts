import nodemailer from "nodemailer";
import { getSetting, getSettingNumber } from "../settings.js";
import type { Mail } from "./email.js";

/**
 * Plain-SMTP delivery. The transport is built per send rather than pooled:
 * settings can change at any time from the UI, and volume is already capped
 * by the global rate valve, so connection reuse buys nothing here.
 */
export async function sendViaSmtp(mail: Mail, from: { name: string; email: string }): Promise<void> {
  const host = getSetting("email.smtp_host");
  if (!host) throw new Error("SMTP host is not configured");
  const tls = getSetting("email.smtp_tls");
  const user = getSetting("email.smtp_user");

  const transport = nodemailer.createTransport({
    host,
    port: getSettingNumber("email.smtp_port"),
    secure: tls === "implicit",
    requireTLS: tls === "starttls",
    ignoreTLS: tls === "none",
    auth: user ? { user, pass: getSetting("email.smtp_password") } : undefined,
  });

  const [primary, ...rest] = mail.to;
  await transport.sendMail({
    from: `"${from.name}" <${from.email}>`,
    to: primary,
    cc: rest.length ? rest : undefined,
    subject: mail.subject,
    text: mail.text,
    html: mail.html,
    messageId: mail.messageId,
    inReplyTo: mail.inReplyTo,
    references: mail.references,
  });
}
