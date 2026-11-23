// Canonical state machines (PRD §5.2). Defined once and reused by API, web and mobile.
import { AppError } from './errors.ts';

export interface Machine<S extends string> {
  readonly name: string;
  readonly states: readonly S[];
  readonly transitions: Readonly<Record<S, readonly S[]>>;
  can(from: S, to: S): boolean;
  assert(from: S, to: S): void;
  next(from: S): readonly S[];
}
function machine<S extends string>(name: string, transitions: Record<S, readonly S[]>): Machine<S> {
  return {
    name, transitions, states: Object.keys(transitions) as S[],
    can: (from, to) => (transitions[from] ?? []).includes(to),
    next: (from) => transitions[from] ?? [],
    assert(from, to) {
      if (!(transitions[from] ?? []).includes(to)) {
        throw new AppError('INVALID_STATE_TRANSITION', `${name}: cannot move from ${from} to ${to}`, { details: { from, to, allowed: transitions[from] ?? [] } });
      }
    },
  };
}

export type DutyState = 'scheduled' | 'started' | 'on_break' | 'ended' | 'system_closed' | 'missed' | 'cancelled' | 'reviewed';
export const DutyMachine = machine<DutyState>('Duty assignment', {
  scheduled: ['started', 'missed', 'cancelled'],
  started: ['on_break', 'ended', 'system_closed', 'cancelled'],
  on_break: ['started', 'ended', 'system_closed', 'cancelled'],
  ended: ['reviewed'],
  system_closed: ['reviewed'],
  reviewed: ['ended'], // returned for clarification
  missed: [],
  cancelled: [],
});

export type RosterState = 'draft' | 'published' | 'cancelled';
export const RosterMachine = machine<RosterState>('Roster', { draft: ['published', 'cancelled'], published: ['cancelled'], cancelled: [] });

export type StaffStatus = 'invited' | 'active' | 'suspended' | 'offboarded';
export const StaffMachine = machine<StaffStatus>('Staff Member', {
  invited: ['active', 'offboarded'], active: ['suspended', 'offboarded'], suspended: ['active', 'offboarded'], offboarded: [],
});

export type DeviceStatus = 'pending_approval' | 'active' | 'revoked';
export const DeviceMachine = machine<DeviceStatus>('Device', { pending_approval: ['active', 'revoked'], active: ['revoked'], revoked: [] });

export type TenantStatus = 'provisioning' | 'trial' | 'active' | 'suspended' | 'archived' | 'pending_deletion' | 'deleted';
export const TenantMachine = machine<TenantStatus>('Tenant', {
  provisioning: ['trial', 'active'],
  trial: ['active', 'suspended', 'pending_deletion'],
  active: ['suspended', 'archived', 'pending_deletion'],
  suspended: ['active', 'archived', 'pending_deletion'],
  archived: ['active', 'pending_deletion'],
  pending_deletion: ['active', 'suspended', 'deleted'],
  deleted: [],
});

export type AlertState = 'open' | 'acknowledged' | 'snoozed' | 'resolved' | 'auto_resolved';
export const AlertMachine = machine<AlertState>('Alert', {
  open: ['acknowledged', 'snoozed', 'resolved', 'auto_resolved'],
  acknowledged: ['snoozed', 'resolved', 'auto_resolved'],
  snoozed: ['open', 'acknowledged', 'resolved', 'auto_resolved'],
  resolved: [], auto_resolved: [],
});

export type IncidentStatus = 'new' | 'acknowledged' | 'dispatched' | 'on_scene' | 'resolved' | 'closed' | 'cancelled_false_alarm' | 'reopened';
export const IncidentMachine = machine<IncidentStatus>('Incident', {
  new: ['acknowledged', 'cancelled_false_alarm'],
  acknowledged: ['dispatched', 'resolved', 'cancelled_false_alarm'],
  dispatched: ['on_scene', 'resolved'], // On Scene may be skipped (TS §16.1)
  on_scene: ['resolved'],
  resolved: ['closed', 'reopened'],
  closed: ['reopened'],
  reopened: ['acknowledged', 'dispatched', 'resolved'],
  cancelled_false_alarm: [],
});

export type SosDeliveryState = 'pending_offline' | 'sending' | 'received_by_server' | 'notified' | 'acknowledged_by_human' | 'failed';
export const SosDeliveryMachine = machine<SosDeliveryState>('SOS delivery', {
  pending_offline: ['sending'],
  sending: ['received_by_server', 'failed', 'pending_offline'],
  received_by_server: ['notified', 'acknowledged_by_human', 'failed'],
  notified: ['acknowledged_by_human', 'notified'],
  failed: ['sending', 'notified', 'acknowledged_by_human'],
  acknowledged_by_human: [],
});

export type CorrectionState = 'pending' | 'approved' | 'rejected' | 'returned';
export const CorrectionMachine = machine<CorrectionState>('Correction request', {
  pending: ['approved', 'rejected', 'returned'], returned: ['pending'], approved: [], rejected: [],
});

export type NotificationState = 'queued' | 'sent_to_provider' | 'delivered' | 'failed' | 'suppressed';

export const ALL_MACHINES = [DutyMachine, RosterMachine, StaffMachine, DeviceMachine, TenantMachine, AlertMachine, IncidentMachine, SosDeliveryMachine, CorrectionMachine] as const;

export type Freshness = 'live' | 'recent' | 'stale' | 'unknown';
/** Command-centre display classification (PRD §8.11) — derived, never stored as truth. */
export type DutyDisplayState = 'not_started' | 'on_duty' | 'on_break' | 'checked_out' | 'exception' | 'sos' | 'stale_offline';
export const SCAN_RESULTS = ['valid', 'late', 'early', 'out_of_order', 'wrong_location', 'invalid_token', 'duplicate', 'not_assigned'] as const;
export type ScanResult = (typeof SCAN_RESULTS)[number];
export const ALERT_TYPES = ['late_start', 'missed_check_out', 'missed_checkpoint', 'geofence_exception', 'stale_location', 'device_offline', 'low_battery', 'sos'] as const;
export type AlertType = (typeof ALERT_TYPES)[number];
export const BASIS = ['measured', 'estimated', 'unknown', 'system_flag'] as const;
export type Basis = (typeof BASIS)[number];
