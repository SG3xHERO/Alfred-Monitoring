import { query } from "../db.js";
import {
  renderTemplate, checkMessage, lockoutUsers,
  type CompiledCheck, type CompiledRule, type NotifyTarget, type ServerLike,
} from "../engine/rules.js";
import { sendMail, buildAlertMail } from "./email.js";
import { logNotification, type NotifyChannel } from "./log.js";
import { getSetting } from "../settings.js";

export interface DeliverInput {
  server: ServerLike;
  rule: CompiledRule;
  check: CompiledCheck;
  firstSeen: Date;
  resolved: boolean;
  metrics: Array<[string, string]>;
  /** Ties an email to its incident's thread — omit only for paths with no incident row (there are none currently). */
  incidentId: number;
}

/** One notify target plus its position in check.notify — the position keys the email thread (see notification_threads). */
export interface IndexedTarget {
  target: NotifyTarget;
  index: number;
}

const baseUrl = () => getSetting("base_url").replace(/\/$/, "");

/**
 * Single delivery step for a firing/resolved check — evaluator.ts calls this
 * once per notify target so cooldown/maintenance suppression logic stays in
 * one place instead of being duplicated per channel. Returns one bool per
 * target (in order) so callers can track which specific targets succeeded —
 * needed for escalation's "notify once" bookkeeping.
 */
export async function deliverAlert(targets: IndexedTarget[], input: DeliverInput): Promise<boolean[]> {
  const results: boolean[] = [];
  for (const { target, index } of targets) results.push(await deliverOne(target, index, input));
  return results;
}

function freshMessageId(seed: string): string {
  const domain = (() => {
    try { return new URL(baseUrl()).hostname; } catch { return "alfred.local"; }
  })();
  return `<alfred.${seed}.${Date.now()}.${Math.random().toString(36).slice(2, 8)}@${domain}>`;
}

/**
 * Reuses the Message-ID and subject line from this incident+target's first
 * email (creating them on the first call) so every later email about the
 * same incident — escalation, resolution — threads as a reply instead of
 * landing as its own message. The subject must never change after the first
 * send: Outlook groups a conversation by the *original* subject, so even
 * correct In-Reply-To/References headers won't thread a "RESOLVED: ..."
 * rewrite. Resolved status is conveyed by the banner in the email body instead.
 */
async function getOrCreateThread(
  incidentId: number, notifyIndex: number, freshSubject: string,
): Promise<{ rootMessageId: string; subject: string; isNew: boolean }> {
  const { rows } = await query<{ message_id: string; subject: string }>(
    `SELECT message_id, subject FROM notification_threads WHERE incident_id = $1 AND notify_index = $2`,
    [incidentId, notifyIndex],
  );
  if (rows.length > 0) return { rootMessageId: rows[0].message_id, subject: rows[0].subject, isNew: false };

  const candidate = freshMessageId(`incident.${incidentId}.${notifyIndex}`);
  await query(
    `INSERT INTO notification_threads (incident_id, notify_index, message_id, subject) VALUES ($1,$2,$3,$4)
     ON CONFLICT (incident_id, notify_index) DO NOTHING`,
    [incidentId, notifyIndex, candidate, freshSubject],
  );
  // a concurrent caller may have won the insert race — re-read so both agree on the same thread
  const { rows: final } = await query<{ message_id: string; subject: string }>(
    `SELECT message_id, subject FROM notification_threads WHERE incident_id = $1 AND notify_index = $2`,
    [incidentId, notifyIndex],
  );
  return { rootMessageId: final[0].message_id, subject: final[0].subject, isNew: final[0].message_id === candidate };
}

async function deliverOne(target: NotifyTarget, notifyIndex: number, input: DeliverInput): Promise<boolean> {
  const { server, rule, check, firstSeen, resolved, metrics, incidentId } = input;
  const serverName = server.display_name || server.hostname || `#${server.id}`;
  const baseMessage = checkMessage(check, server);
  // e.g. "web01 is offline (nested under host01)" — the recipient still
  // gets an alert for the specific nested device, just with enough context
  // to know which board tile it's hiding under.
  const nestedNote = server.parent_display_name ? ` (nested under ${server.parent_display_name})` : "";
  const message = (resolved ? `Cleared: ${baseMessage}` : baseMessage) + nestedNote;
  const link = `${baseUrl()}/servers/${server.id}`;

  switch (target.channel) {
    case "email": {
      const rawSubject = target.subject || `⚠️ ${rule.name}/${check.key} firing on {{server}}`;
      const rendered = renderTemplate(rawSubject, server, { lockouts: lockoutUsers(server) });
      const thread = await getOrCreateThread(incidentId, notifyIndex, rendered);
      const { html, text } = buildAlertMail({
        serverName, serverId: server.id, brand: server.brand, ruleName: rule.name,
        checkKey: check.key, condition: check.when, severity: check.severity,
        message, firstSeen, resolved, metrics,
      });
      return sendMail({
        to: target.to,
        subject: thread.subject, // frozen at the incident's first email — never rewritten with "RESOLVED:"
        html, text,
        messageId: thread.isNew ? thread.rootMessageId : freshMessageId(`incident.${incidentId}.${notifyIndex}`),
        inReplyTo: thread.isNew ? undefined : thread.rootMessageId,
        references: thread.isNew ? undefined : thread.rootMessageId,
      });
    }
    case "slack":
      return sendWebhookJson(target.url, "slack",
        slackPayload({ serverName, brand: server.brand, rule, check, message, resolved, link }));
    case "teams":
      return sendWebhookJson(target.url, "teams",
        teamsPayload({ serverName, brand: server.brand, rule, check, message, resolved, link }));
    case "webhook":
      return sendWebhookJson(target.url, "webhook", {
        server_id: server.id,
        rule: rule.name,
        check: check.key,
        severity: check.severity,
        message,
        status: resolved ? "resolved" : "firing",
        timestamp: new Date().toISOString(),
      }, target.secret);
  }
}

async function sendWebhookJson(
  url: string, channel: NotifyChannel, payload: unknown, secret?: string,
): Promise<boolean> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (secret) headers["X-Alfred-Secret"] = secret;
  const summary = typeof (payload as any)?.message === "string" ? (payload as any).message : channel;
  try {
    const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(payload) });
    if (!res.ok) {
      const detail = await res.text().catch(() => "");
      await logNotification(channel, url, summary, true, `${channel} ${res.status}: ${detail.slice(0, 300)}`);
      console.error(`${channel} webhook error ${res.status}: ${detail.slice(0, 300)}`);
      return false;
    }
    await logNotification(channel, url, summary, false, null);
    return true;
  } catch (err: any) {
    await logNotification(channel, url, summary, true, `network: ${err.message}`);
    console.error(`${channel} webhook network error: ${err.message}`);
    return false;
  }
}

function slackPayload(input: {
  serverName: string; brand: string; rule: CompiledRule; check: CompiledCheck;
  message: string; resolved: boolean; link: string;
}) {
  const { serverName, brand, rule, check, message, resolved, link } = input;
  const banner = resolved ? "RESOLVED" : check.severity.toUpperCase();
  const emoji = resolved ? ":white_check_mark:" : check.severity === "critical" ? ":red_circle:" : ":warning:";
  const text = [
    `${emoji} *${banner}* — *${serverName}* (${brand})`,
    message,
    `Rule: \`${rule.name}/${check.key}\`  ·  Severity: ${check.severity}`,
    `<${link}|Open dashboard>`,
  ].join("\n");
  return { text };
}

function teamsPayload(input: {
  serverName: string; brand: string; rule: CompiledRule; check: CompiledCheck;
  message: string; resolved: boolean; link: string;
}) {
  const { serverName, brand, rule, check, message, resolved, link } = input;
  const color = resolved ? "1a7f42" : check.severity === "critical" ? "c0262c" : "b45309";
  const banner = resolved ? "RESOLVED" : check.severity.toUpperCase();
  return {
    "@type": "MessageCard",
    "@context": "http://schema.org/extensions",
    themeColor: color,
    summary: `${banner}: ${serverName}`,
    sections: [{
      activityTitle: serverName,
      activitySubtitle: brand,
      text: message,
      facts: [
        { name: "Rule", value: `${rule.name}/${check.key}` },
        { name: "Severity", value: check.severity },
      ],
    }],
    potentialAction: [{
      "@type": "OpenUri",
      name: "Open dashboard",
      targets: [{ os: "default", uri: link }],
    }],
  };
}
