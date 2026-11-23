# Default role permission matrix

Generated from `packages/permissions/src/index.ts` (`npm run matrix`). Source: PRD Appendix A. Scope (whole organisation or assigned units and their descendants) is applied on top of these keys; field staff act only on their own records. Platform staff hold no tenant keys; tenant content needs an approved support grant.

| Permission key | Organisation Owner | Organisation Admin | Commander | Supervisor | Dispatcher | Field Staff Member | Auditor / Reviewer |
|---|:-:|:-:|:-:|:-:|:-:|:-:|:-:|
| `alert.manage` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| `alert.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `alertrule.read` | ✓ | ✓ |  |  |  |  | ✓ |
| `alertrule.update` | ✓ | ✓ |  |  |  |  |  |
| `assignment.create` | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `assignment.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `assignment.update` | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `attendance.correct` | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `attendance.read` | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |
| `attendance.review` | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `audit.read` | ✓ | ✓ |  |  |  |  | ✓ |
| `catalogue.manage` | ✓ | ✓ |  |  |  |  |  |
| `catalogue.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `checkpoint.manage` | ✓ | ✓ |  |  |  |  |  |
| `checkpoint.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `correction.request` |  |  |  |  |  | ✓ |  |
| `dashboard.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| `device.manage` | ✓ | ✓ | ✓ |  |  |  |  |
| `device.read` | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |
| `device.update` | ✓ | ✓ | ✓ |  |  |  |  |
| `duty.own` |  |  |  |  |  | ✓ |  |
| `escalation.manage` | ✓ | ✓ |  |  |  |  |  |
| `export.create` | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |
| `geofence.manage` | ✓ | ✓ |  |  |  |  |  |
| `geofence.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `incident.create` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| `incident.dispatch` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| `incident.manage` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| `incident.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `integration.manage` | ✓ | ✓ |  |  |  |  |  |
| `integration.read` | ✓ | ✓ |  |  |  |  |  |
| `legalhold.manage` | ✓ |  |  |  |  |  |  |
| `location.history.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| `location.live.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  |  |
| `membership.read` | ✓ | ✓ |  |  |  |  | ✓ |
| `membership.update` | ✓ | ✓ |  |  |  |  |  |
| `notification.admin` | ✓ | ✓ |  |  |  |  |  |
| `post.create` | ✓ | ✓ |  |  |  |  |  |
| `post.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `post.update` | ✓ | ✓ |  |  |  |  |  |
| `privacy.notice.manage` | ✓ | ✓ |  |  |  |  |  |
| `privacy.subject.manage` | ✓ | ✓ |  |  |  |  |  |
| `report.incident.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `report.read` | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |
| `retention.manage` | ✓ | ✓ |  |  |  |  |  |
| `role.create` | ✓ | ✓ |  |  |  |  |  |
| `role.delete` | ✓ | ✓ |  |  |  |  |  |
| `role.read` | ✓ | ✓ |  |  |  |  | ✓ |
| `role.update` | ✓ | ✓ |  |  |  |  |  |
| `roster.cancel` | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `roster.publish` | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `roster.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `self.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `session.revoke` | ✓ | ✓ |  |  |  |  |  |
| `settings.read` | ✓ | ✓ |  |  |  |  | ✓ |
| `settings.update` | ✓ | ✓ |  |  |  |  |  |
| `shift.create` | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `shift.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `shift.update` | ✓ | ✓ | ✓ | ✓ |  |  |  |
| `sos.raise` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |  |
| `staff.create` | ✓ | ✓ | ✓ |  |  |  |  |
| `staff.import` | ✓ | ✓ |  |  |  |  |  |
| `staff.invite` | ✓ | ✓ | ✓ |  |  |  |  |
| `staff.lifecycle` | ✓ | ✓ | ✓ |  |  |  |  |
| `staff.read` | ✓ | ✓ | ✓ | ✓ |  |  | ✓ |
| `staff.update` | ✓ | ✓ | ✓ |  |  |  |  |
| `support.grant.manage` | ✓ |  |  |  |  |  |  |
| `team.manage` | ✓ | ✓ |  |  |  |  |  |
| `team.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `tenant.delete` | ✓ |  |  |  |  |  |  |
| `tenant.export` | ✓ |  |  |  |  |  |  |
| `tenant.read` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |
| `tenant.transfer` | ✓ |  |  |  |  |  |  |
| `tenant.update` | ✓ | ✓ |  |  |  |  |  |
| `unit.create` | ✓ | ✓ |  |  |  |  |  |
| `unit.move` | ✓ | ✓ |  |  |  |  |  |
| `unit.read` | ✓ | ✓ | ✓ | ✓ | ✓ |  | ✓ |
| `unit.update` | ✓ | ✓ |  |  |  |  |  |
| `user.mfa.reset` | ✓ | ✓ |  |  |  |  |  |
