// Notifications (FR-NOT-001..004): in-app records are the source of truth; email is a secondary channel behind a port.
import { connect } from 'node:net';
import { App, AppError, Ctx, type Doc, type Route, paginate, s } from '@sf/kernel';

/** EN/AR titles per template. Bodies are rendered by clients from template + reference. */
export const TEMPLATES: Record<string, { en: string; ar: string; critical?: boolean }> = {
  roster_published: { en: 'You have a new duty assignment', ar: 'لديك تكليف مناوبة جديد' },
  roster_revised: { en: 'Your duty assignment changed', ar: 'تم تعديل تكليف مناوبتك' },
  roster_assignment_removed: { en: 'A duty assignment was removed', ar: 'تمت إزالة تكليف مناوبة' },
  assignment_changed: { en: 'Your duty assignment changed', ar: 'تم تعديل تكليف مناوبتك' },
  assignment_cancelled: { en: 'A duty assignment was cancelled', ar: 'تم إلغاء تكليف مناوبة' },
  assignment_ack_reminder: { en: 'Please acknowledge your duty assignment', ar: 'يرجى تأكيد استلام تكليف المناوبة' },
  correction_requested: { en: 'A correction request needs review', ar: 'طلب تصحيح بحاجة إلى مراجعة' },
  correction_approved: { en: 'Your correction request was approved', ar: 'تمت الموافقة على طلب التصحيح' },
  correction_rejected: { en: 'Your correction request was rejected', ar: 'تم رفض طلب التصحيح' },
  correction_returned: { en: 'Your correction request needs clarification', ar: 'طلب التصحيح يحتاج إلى توضيح' },
  duty_returned_for_clarification: { en: 'Your duty record was returned for clarification', ar: 'أُعيد سجل مناوبتك للتوضيح' },
  device_pending_approval: { en: 'A device is waiting for approval', ar: 'جهاز بانتظار الموافقة' },
  support_grant_requested: { en: 'Platform support has requested access', ar: 'طلب الدعم الفني صلاحية وصول' },
  support_break_glass: { en: 'Emergency platform access was used', ar: 'تم استخدام وصول طارئ من المنصة', critical: true },
  alert_created: { en: 'New alert', ar: 'تنبيه جديد' },
  alert_escalated: { en: 'Alert escalated to you', ar: 'تم تصعيد تنبيه إليك' },
  sos_created: { en: 'SOS — immediate attention needed', ar: 'نداء استغاثة — مطلوب تدخل فوري', critical: true },
  sos_escalated: { en: 'SOS not yet acknowledged', ar: 'نداء استغاثة لم يتم تأكيد استلامه', critical: true },
  sos_acknowledged: { en: 'Your SOS was acknowledged', ar: 'تم تأكيد استلام نداء الاستغاثة', critical: true },
  incident_assigned: { en: 'You were assigned to an incident', ar: 'تم تكليفك بحادثة' },
  incident_updated: { en: 'An incident was updated', ar: 'تم تحديث حادثة' },
  export_ready: { en: 'Your export is ready', ar: 'ملف التصدير جاهز' },
  audit_chain_broken: { en: 'Audit integrity check failed', ar: 'فشل التحقق من سلامة سجل التدقيق', critical: true },
};
export interface NotifyInput { template: string; refType: string; refId: string; critical?: boolean; dedupeKey?: string; unitId?: string | null; detail?: Record<string, unknown> }

async function toUser(ctx: Ctx, userId: string, n: NotifyInput): Promise<boolean> {
  const tpl = TEMPLATES[n.template] ?? { en: n.template, ar: n.template };
  const dedupeKey = `${n.dedupeKey ?? `${n.template}:${n.refId}:${ctx.requestId}`}:${userId}`;
  if (await ctx.col('notifications').findOne({ dedupeKey })) return false; // idempotent consumers: no duplicate on retry or restart
  const now = ctx.now(); const critical = n.critical ?? !!tpl.critical;
  const doc = await ctx.col('notifications').insert({ recipientUserId: userId, channel: 'in_app', template: n.template, title: { en: tpl.en, ar: tpl.ar }, refType: n.refType, refId: n.refId, critical, detail: n.detail ?? null, state: 'delivered', attempts: 1, readAt: null, dedupeKey, createdAt: now, deliveredAt: now, expireAt: now + ctx.settings.retentionDays.notifications * 86400000 });
  await ctx.emit('notification:created', { userId }, { notificationId: doc._id, template: n.template, critical, title: doc.title, refType: n.refType, refId: n.refId });
  if (critical && ctx.settings.channels.email) {
    const user = await ctx.col('users').get(userId);
    if (user?.email && user.emailVerifiedAt) await ctx.app.services.mail.send(ctx, user.email, n.template, { title: tpl.en }, userId);
  }
  return true;
}
async function toStaff(ctx: Ctx, staffMemberId: string, n: NotifyInput): Promise<boolean> {
  const st = await ctx.col('staff_members').get(staffMemberId);
  return st?.userId ? toUser(ctx, st.userId, n) : false;
}
/** Recipient groups resolve to members holding the role whose scope covers the unit (PRD §8.12). Returns how many were notified. */
async function toRoles(ctx: Ctx, roleKeys: string[], n: NotifyInput): Promise<number> {
  const roles = await ctx.col('roles').find({ key: { $in: roleKeys } });
  const members = await ctx.col('memberships').find({ status: 'active', roleIds: { $in: roles.map((r) => r._id) } }, { limit: 5000 });
  let anc: string[] = [];
  if (n.unitId) { const u = await ctx.col('organization_units').get(n.unitId); anc = u ? [u._id, ...u.ancestorIds] : []; }
  let count = 0;
  for (const m of members) {
    const covers = (m.scopeUnitIds as string[]).includes('*') || !n.unitId || (m.scopeUnitIds as string[]).some((x) => anc.includes(x));
    if (covers && (await toUser(ctx, m.userId, n))) count++;
  }
  return count;
}

// ---- email adapter: plain SMTP for a local relay / mail catcher. No provider SDK, no paid service. ----
function smtpSend(host: string, port: number, from: string, to: string, subject: string, text: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const sock = connect(port, host); sock.setTimeout(10000); sock.setEncoding('utf8');
    const clean = (v: string) => v.replace(/[\r\n]+/g, ' ');
    const steps = [`EHLO smartforce360`, `MAIL FROM:<${clean(from)}>`, `RCPT TO:<${clean(to)}>`, 'DATA', `From: ${clean(from)}\r\nTo: ${clean(to)}\r\nSubject: ${clean(subject)}\r\nMIME-Version: 1.0\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${text.replace(/^\./gm, '..')}\r\n.`, 'QUIT'];
    let i = -1, buf = '';
    sock.on('data', (d: string) => {
      buf += d; if (!/^\d{3} .*\r?\n$/m.test(buf.split(/\r?\n/).filter(Boolean).pop() + '\n')) return;
      const code = Number(buf.trim().split(/\r?\n/).pop()!.slice(0, 3)); buf = '';
      if (code >= 400) { sock.destroy(); reject(new Error(`SMTP ${code}`)); return; }
      i++; if (i < steps.length) sock.write(steps[i] + '\r\n'); else { sock.end(); resolve(); }
    });
    sock.on('timeout', () => { sock.destroy(); reject(new Error('SMTP timeout')); });
    sock.on('error', reject);
  });
}
const MAIL_TEXT: Record<string, (v: Record<string, string>) => { subject: string; text: string }> = {
  invitation: (v) => ({ subject: 'Activate your SmartForce 360 account', text: `You have been invited to SmartForce 360.\n\nActivation code: ${v.code}\nOr open: ${v.link}\n\nThe code works once and expires.` }),
  password_reset: (v) => ({ subject: 'Reset your SmartForce 360 password', text: `Open this link to choose a new password: ${v.link}\n\nIt works once and expires in 30 minutes. If you did not ask for this, ignore this message.` }),
  verify_email: (v) => ({ subject: 'Confirm your email address', text: `Open this link to confirm your email address: ${v.link}` }),
};

const routes: Route[] = [
  { method: 'GET', path: '/notifications', permission: 'session', scope: 'own', audit: { none: 'own notifications read' }, rate: 'read', summary: 'Own in-app notifications', reqs: ['FR-NOT-001'], query: s.object({ limit: s.optional(s.number({ int: true, min: 1, max: 200 })), cursor: s.optional(s.string({ max: 300 })), unread: s.optional(s.boolean()) }),
    async handler(ctx, { query }) { const f: Record<string, unknown> = { recipientUserId: ctx.actor.userId, channel: 'in_app' }; if (query.unread) f.readAt = null; const page = await paginate(ctx.col('notifications'), f, query, 'createdAt', -1); return { ...page, unreadCount: await ctx.col('notifications').count({ recipientUserId: ctx.actor.userId, channel: 'in_app', readAt: null }) }; } },
  { method: 'POST', path: '/notifications/read-all', permission: 'session', scope: 'own', audit: { none: 'read marker on own notifications' }, rate: 'mutation', summary: 'Mark all own notifications as read', body: s.object({}),
    async handler(ctx) { return { updated: await ctx.col('notifications').updateMany({ recipientUserId: ctx.actor.userId, readAt: null }, { $set: { readAt: ctx.now() } }) }; } },
  { method: 'POST', path: '/notifications/:id/read', permission: 'session', scope: 'own', audit: { none: 'read marker on own notification' }, rate: 'mutation', summary: 'Mark one notification as read', body: s.object({}),
    async handler(ctx, { params }) { const n = await ctx.col('notifications').findOne({ _id: params.id, recipientUserId: ctx.actor.userId }); if (!n) throw new AppError('NOT_FOUND', 'Notification not found'); if (!n.readAt) await ctx.col('notifications').update(n._id, { $set: { readAt: ctx.now() } }); return { ok: true }; } },
  { method: 'GET', path: '/notifications/deliveries', permission: 'notification.admin', scope: 'tenant', audit: { none: 'delivery metadata read' }, rate: 'read', summary: 'Delivery state per notification and channel (no message bodies)', reqs: ['FR-NOT-002'], query: s.object({ limit: s.optional(s.number({ int: true, min: 1, max: 200 })), cursor: s.optional(s.string({ max: 300 })), state: s.optional(s.enum(['queued', 'sent_to_provider', 'delivered', 'failed', 'suppressed'])), channel: s.optional(s.enum(['in_app', 'email', 'push', 'sms'])) }),
    async handler(ctx, { query }) { const f: Record<string, unknown> = {}; if (query.state) f.state = query.state; if (query.channel) f.channel = query.channel; const page = await paginate(ctx.col('notifications'), f, query, 'createdAt', -1); return { ...page, items: page.items.map(({ detail: _d, dedupeKey: _k, ...n }: Doc) => n) }; } },
];

export function registerNotifications(app: App) {
  app.register('notifications', routes);
  app.services.notify = { user: toUser, staff: toStaff, roles: toRoles };
  const mail = {
    devOutbox: [] as { to: string; template: string; vars: Record<string, string>; subject: string; text: string }[], lastResult: null as null | { at: number; state: string; code?: string },
    /** Records a delivery row and queues the send. Secrets (codes, links) are never written to logs or to the row. */
    async send(ctx: Ctx, to: string, template: string, vars: Record<string, string>, userId: string | null) {
      const msg = (MAIL_TEXT[template] ?? ((v: Record<string, string>) => ({ subject: v.title ?? 'SmartForce 360 notification', text: `${v.title ?? 'You have a new notification'}.\n\nSign in to SmartForce 360 for details.` })))(vars);
      const row = await ctx.col('notifications').insert({ recipientUserId: userId, channel: 'email', template, state: 'queued', attempts: 0, createdAt: ctx.now(), expireAt: ctx.now() + ctx.settings.retentionDays.notifications * 86400000 });
      if (!app.config.smtp) {
        if (app.config.env === 'production') { await ctx.col('notifications').update(row._id, { $set: { state: 'failed', failureCode: 'EMAIL_NOT_CONFIGURED' } }); mail.lastResult = { at: ctx.now(), state: 'failed', code: 'EMAIL_NOT_CONFIGURED' }; return; }
        mail.devOutbox.push({ to, template, vars, ...msg }); if (mail.devOutbox.length > 200) mail.devOutbox.shift();
        await ctx.col('notifications').update(row._id, { $set: { state: 'suppressed', failureCode: 'DEV_OUTBOX_NO_SMTP' } }); return;
      }
      await ctx.enqueue('mail.send', { rowId: row._id, to: app.crypto.encrypt(to), subject: msg.subject, text: app.crypto.encrypt(msg.text) }, { queue: 'notifications', maxAttempts: 5 });
    },
  };
  app.services.mail = mail;
  app.jobs.register('mail.send', async (p, j) => {
    const repo = app.tenantRepo(j.tenantId!); const smtp = app.config.smtp!;
    try {
      await smtpSend(smtp.host, smtp.port, smtp.from, app.crypto.decrypt(p.to), p.subject, app.crypto.decrypt(p.text));
      await repo.col('notifications').update(p.rowId, { $set: { state: 'sent_to_provider', sentAt: app.clock.now() }, $inc: { attempts: 1 } }); mail.lastResult = { at: app.clock.now(), state: 'sent_to_provider' };
    } catch (e) {
      await repo.col('notifications').update(p.rowId, { $set: { state: j.attempt >= 5 ? 'failed' : 'queued', failureCode: String((e as Error).message).slice(0, 60) }, $inc: { attempts: 1 } }); mail.lastResult = { at: app.clock.now(), state: 'failed', code: String((e as Error).message).slice(0, 60) };
      throw e;
    }
  });
}
