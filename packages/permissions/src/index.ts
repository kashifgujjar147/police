// Permission keys and default role matrix (PRD §6, Appendix A; TS §6.3).
// Keys follow <resource>.<action>. Platform keys live in a separate namespace and are never mixed with tenant keys.

export const ROLE_KEYS = ['owner', 'admin', 'commander', 'supervisor', 'dispatcher', 'field', 'auditor'] as const;
export type RoleKey = (typeof ROLE_KEYS)[number];

export const ROLE_NAMES: Record<RoleKey, { en: string; ar: string }> = {
  owner: { en: 'Organisation Owner', ar: 'مالك المؤسسة' }, admin: { en: 'Organisation Admin', ar: 'مسؤول المؤسسة' },
  commander: { en: 'Commander', ar: 'قائد' }, supervisor: { en: 'Supervisor', ar: 'مشرف' }, dispatcher: { en: 'Dispatcher', ar: 'مُرسِل' },
  field: { en: 'Field Staff Member', ar: 'موظف ميداني' }, auditor: { en: 'Auditor / Reviewer', ar: 'مدقق' },
};

const o = 'owner', a = 'admin', c = 'commander', sv = 'supervisor', d = 'dispatcher', f = 'field', au = 'auditor';
const ALL: RoleKey[] = [o, a, c, sv, d, f, au];

/** Which default roles hold each permission key. Source: PRD Appendix A (see docs/ROLE_PERMISSION_MATRIX.md). */
export const PERMISSION_GRANTS: Record<string, RoleKey[]> = {
  // Tenant basics (profile needed to render any screen)
  'tenant.read': ALL,
  // Ownership transfer, export, deletion — Owner only
  'tenant.export': [o], 'tenant.delete': [o], 'tenant.transfer': [o], 'support.grant.manage': [o], 'legalhold.manage': [o],
  // Tenant settings and policies — OO, OA; Auditor read
  'settings.read': [o, a, au], 'settings.update': [o, a], 'tenant.update': [o, a],
  'alertrule.read': [o, a, au], 'alertrule.update': [o, a], 'escalation.manage': [o, a], 'catalogue.manage': [o, a],
  'privacy.notice.manage': [o, a], 'privacy.subject.manage': [o, a], 'integration.read': [o, a], 'integration.manage': [o, a],
  'retention.manage': [o, a], 'notification.admin': [o, a],
  // Roles and permissions — OO, OA; Auditor read
  'role.read': [o, a, au], 'role.create': [o, a], 'role.update': [o, a], 'role.delete': [o, a],
  'membership.read': [o, a, au], 'membership.update': [o, a], 'user.mfa.reset': [o, a], 'session.revoke': [o, a],
  // Hierarchy, posts, geofences, checkpoints — OO, OA manage; CMD, SUP, DIS, AUD read
  'unit.read': [o, a, c, sv, d, au], 'unit.create': [o, a], 'unit.update': [o, a], 'unit.move': [o, a],
  'post.read': [o, a, c, sv, d, au], 'post.create': [o, a], 'post.update': [o, a],
  'team.read': [o, a, c, sv, d, au], 'team.manage': [o, a],
  'geofence.read': [o, a, c, sv, d, au], 'geofence.manage': [o, a],
  'checkpoint.read': [o, a, c, sv, d, au], 'checkpoint.manage': [o, a],
  // Staff and devices — OO, OA full; CMD scoped; SUP, AUD read; field own
  'staff.read': [o, a, c, sv, au], 'staff.create': [o, a, c], 'staff.update': [o, a, c], 'staff.lifecycle': [o, a, c],
  'staff.invite': [o, a, c], 'staff.import': [o, a], 'device.read': [o, a, c, sv, au], 'device.update': [o, a, c], 'device.manage': [o, a, c],
  // Create / publish rosters — OO, OA, CMD, SUP
  'shift.create': [o, a, c, sv], 'shift.update': [o, a, c, sv], 'assignment.create': [o, a, c, sv], 'assignment.update': [o, a, c, sv],
  'roster.publish': [o, a, c, sv], 'roster.cancel': [o, a, c, sv],
  // View roster and assignments — + DIS, AUD read
  'shift.read': [o, a, c, sv, d, au], 'assignment.read': [o, a, c, sv, d, au], 'roster.read': [o, a, c, sv, d, au],
  // Start/end duty, scans, breaks — field own
  'duty.own': [f], 'correction.request': [f],
  // Attendance review and corrections
  'attendance.read': [o, a, c, sv, au], 'attendance.review': [o, a, c, sv], 'attendance.correct': [o, a, c, sv],
  // Live command centre
  'location.live.read': [o, a, c, sv, d], 'dashboard.read': [o, a, c, sv, d],
  // Location history (purpose required; dispatcher only for staff on an active incident)
  'location.history.read': [o, a, c, sv, d],
  // Alerts
  'alert.read': [o, a, c, sv, d, au], 'alert.manage': [o, a, c, sv, d],
  // Raise SOS / incident — any signed-in staff member (D-04)
  'sos.raise': [o, a, c, sv, d, f], 'incident.create': [o, a, c, sv, d, f],
  // Handle SOS and incidents
  'incident.read': [o, a, c, sv, d, au], 'incident.dispatch': [o, a, c, sv, d], 'incident.manage': [o, a, c, sv, d],
  // Reports and export
  'report.read': [o, a, c, sv, au], 'report.incident.read': [o, a, c, sv, d, au], 'export.create': [o, a, c, sv, au],
  // Audit log
  'audit.read': [o, a, au],
  // Catalogues are readable by everyone who files or handles incidents
  'catalogue.read': ALL,
  // Own data (FR-PRV-001)
  'self.read': ALL,
};

export const PERMISSION_KEYS = Object.keys(PERMISSION_GRANTS).sort();
export const PLATFORM_PERMISSION_KEYS = [
  'platform.tenant.read', 'platform.tenant.create', 'platform.tenant.update', 'platform.tenant.lifecycle', 'platform.ops.read',
  'platform.support.request', 'platform.plan.assign', 'platform.integration.manage', 'platform.user.manage',
  'platform.tenant.users', // Super Admin only: list an organisation's accounts and reset their passwords (owner decision, 2026-11-23)
] as const;

export function defaultRolePermissions(role: RoleKey): string[] {
  return PERMISSION_KEYS.filter((k) => PERMISSION_GRANTS[k]!.includes(role));
}
/** Roles whose default scope is the whole tenant (PRD §6). */
export const TENANT_WIDE_ROLES: RoleKey[] = ['owner', 'admin'];
export const PRIVILEGED_ROLES: RoleKey[] = ['owner', 'admin'];
export const isKnownPermission = (k: string) => k in PERMISSION_GRANTS;
