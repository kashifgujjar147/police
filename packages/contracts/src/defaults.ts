// Configuration defaults register (PRD Appendix B, C, D). Every value is tenant configuration,
// versioned in TenantSettingVersion — never hard-coded in handlers.
import type { AlertType } from './states.ts';

export const DEFAULT_SETTINGS = {
  auth: {
    accessTokenTtlSec: 900, lockThreshold: 5, lockMinutes: 15, activationHours: 72, resetMinutes: 30,
    passwordMinPrivileged: 12, passwordMin: 10, mfaRequiredRoles: ['owner', 'admin'] as string[],
    webIdleHours: 12, webAbsoluteDays: 7, mobileIdleDays: 14, mobileAbsoluteDays: 30,
  },
  duty: {
    earlyMin: 30, lateMin: 60, overlapPolicy: 'block' as 'block' | 'warn' | 'allow',
    missedCheckOut: 'flag' as 'remain_open' | 'auto_close' | 'flag', autoCloseGraceMin: 60,
    geofenceStart: 'warn' as 'off' | 'warn' | 'require', ackReminderHours: 12, breakTracking: 'pause' as 'pause' | 'reduced' | 'normal',
  },
  devices: { maxActivePerStaff: 1, changeNeedsApproval: true, heartbeatSec: 300, minAppVersion: '1.0.0', softMinAppVersion: '1.0.0' },
  location: {
    movingSec: 30, stationarySec: 120, minAccuracyM: 100, distanceFilterM: 10, liveSec: 120, recentSec: 600,
    lateWindowDays: 7, closeGraceSec: 120, skewToleranceSec: 300, skewSignalSec: 120, implausibleSpeedMps: 70,
  },
  geofence: { dwellSec: 30, exitDwellSec: 60, accuracyCeilingM: 100 },
  checkpoints: { graceMin: 10 },
  sos: {
    holdSec: 2, renotifySec: 60, escalateSec: 120, commanderSec: 300, fallbackSec: 90, outOfDuty: true, abuseThreshold: 30,
    fallbackInstructions: { en: 'If nobody responds, call your control room or the local emergency number.', ar: 'إذا لم يستجب أحد، اتصل بغرفة التحكم أو برقم الطوارئ المحلي.' },
  },
  mobile: { queueCapPoints: 50000 },
  exports: { rowLimit: 100000, linkMinutes: 5 },
  files: { maxBytes: 10 * 1024 * 1024, urlSec: 300, allowedMime: ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'] },
  retentionDays: { location_points: 90, attendance: 730, geofence_checkpoint: 365, incidents: 730, audit: 1095, security: 365, notifications: 90 },
  tenant: { deletionGraceDays: 30, suspendedSosGraceHours: 24 },
  map: { tileUrl: '', attribution: '' },
  channels: { inApp: true, email: false, push: false, sms: false },
};
export type TenantSettings = typeof DEFAULT_SETTINGS;

/** Platform floors/ceilings a tenant cannot go beyond (FR-AUTH-002, FR-PRV-004). */
export const PLATFORM_BOUNDS = {
  passwordMinPrivileged: 12, passwordMin: 10,
  retentionDays: { location_points: [7, 365], attendance: [90, 3650], geofence_checkpoint: [30, 1825], incidents: [90, 3650], audit: [365, 3650], security: [90, 1825], notifications: [7, 365] } as Record<string, [number, number]>,
};

export interface AlertRuleDefault { type: AlertType; severity: 'low' | 'medium' | 'high' | 'critical'; thresholds: Record<string, number>; recipients: string[]; escalation: { afterSec: number; groups: string[] }[] }
export const DEFAULT_ALERT_RULES: AlertRuleDefault[] = [
  { type: 'late_start', severity: 'medium', thresholds: { afterMin: 15 }, recipients: ['supervisor'], escalation: [{ afterSec: 900, groups: ['commander'] }] },
  { type: 'missed_check_out', severity: 'low', thresholds: { afterMin: 60 }, recipients: ['supervisor'], escalation: [] },
  { type: 'missed_checkpoint', severity: 'medium', thresholds: { graceMin: 10 }, recipients: ['supervisor'], escalation: [{ afterSec: 1800, groups: ['commander'] }] },
  { type: 'geofence_exception', severity: 'medium', thresholds: { outsideMin: 5, maxAccuracyM: 50 }, recipients: ['supervisor'], escalation: [] },
  { type: 'stale_location', severity: 'low', thresholds: { afterMin: 10 }, recipients: ['supervisor'], escalation: [] },
  { type: 'device_offline', severity: 'low', thresholds: { afterMin: 15 }, recipients: ['supervisor'], escalation: [] },
  { type: 'low_battery', severity: 'low', thresholds: { percent: 15 }, recipients: ['supervisor'], escalation: [] },
  { type: 'sos', severity: 'critical', thresholds: {}, recipients: ['dispatcher'], escalation: [{ afterSec: 60, groups: ['dispatcher'] }, { afterSec: 120, groups: ['supervisor'] }, { afterSec: 300, groups: ['commander'] }] },
];

export const DEFAULT_PLANS = [
  { key: 'pilot', name: 'Pilot', limits: { activeStaff: 50, posts: 20, devices: 60, storageGb: 5, retentionDays: 90 }, features: ['core'] },
  { key: 'starter', name: 'Starter', limits: { activeStaff: 100, posts: 50, devices: 120, storageGb: 20, retentionDays: 90 }, features: ['core'] },
  { key: 'professional', name: 'Professional', limits: { activeStaff: 1000, posts: 500, devices: 1200, storageGb: 200, retentionDays: 365 }, features: ['core', 'reports'] },
  { key: 'enterprise', name: 'Enterprise', limits: { activeStaff: 5000, posts: 5000, devices: 6000, storageGb: 1000, retentionDays: 365 }, features: ['core', 'reports'] },
];

export const DEFAULT_CATALOGUES = [
  { kind: 'incidentType', key: 'personal_safety', labels: { en: 'Personal safety', ar: 'السلامة الشخصية' }, severityDefault: 'critical' },
  { kind: 'incidentType', key: 'medical', labels: { en: 'Medical', ar: 'حالة طبية' }, severityDefault: 'high' },
  { kind: 'incidentType', key: 'security_breach', labels: { en: 'Security breach', ar: 'خرق أمني' }, severityDefault: 'high' },
  { kind: 'incidentType', key: 'hazard', labels: { en: 'Hazard or damage', ar: 'خطر أو ضرر' }, severityDefault: 'medium' },
  { kind: 'incidentType', key: 'other', labels: { en: 'Other', ar: 'أخرى' }, severityDefault: 'low' },
  { kind: 'dutyType', key: 'static_post', labels: { en: 'Static post', ar: 'نقطة ثابتة' }, severityDefault: 'low' },
  { kind: 'dutyType', key: 'patrol', labels: { en: 'Patrol', ar: 'دورية' }, severityDefault: 'low' },
];

export const DEFAULT_LABELS = {
  hierarchyLevels: { en: ['Headquarters', 'Region', 'District', 'Station', 'Team'], ar: ['المقر الرئيسي', 'المنطقة', 'القطاع', 'المركز', 'الفريق'] },
  post: { en: 'Site', ar: 'الموقع' },
  fieldStaff: { en: 'Field Officer', ar: 'موظف ميداني' },
};

/** Realtime event names (TS §10.1). */
export const REALTIME_EVENTS = [
  'location:updated', 'staff:statusChanged', 'duty:started', 'duty:ended', 'geofence:entered', 'geofence:exited', 'checkpoint:scanned',
  'alert:created', 'alert:updated', 'sos:created', 'sos:deliveryChanged', 'incident:updated', 'roster:published', 'notification:created',
  'session:revoked', 'tenant:stateChanged',
] as const;
export type RealtimeEventType = (typeof REALTIME_EVENTS)[number];
export interface RealtimeEnvelope { eventId: string; type: RealtimeEventType; version: 1; tenantId: string; scope: { unitId?: string; staffId?: string; userId?: string }; occurredAt: string; emittedAt: string; seq: number; payload: Record<string, unknown> }
