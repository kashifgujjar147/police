// Background location for an open Tracking Session only (FR-LOC-001/002, FR-MOB-003).
// Starts after a successful duty start and stops on duty end, cancellation, revocation or sign-out.
// STATUS: written against expo-location / expo-task-manager; background behaviour must be validated on real Android and iOS devices (PRD §12.2).
import * as Location from 'expo-location';
import * as TaskManager from 'expo-task-manager';
import * as Battery from 'expo-battery';
import { Sampler } from '@sf/mobile-core';
import { outbox, sync } from './platform';

export const TASK = 'sf360-duty-location';
let sampler: Sampler | null = null;

TaskManager.defineTask(TASK, async ({ data, error }) => {
  if (error || !data) return;
  await outbox.load();
  if (!outbox.tracking) { await stopTracking(); return; } // duty ended while backgrounded: stop immediately
  sampler ??= new Sampler(outbox.tracking.profile ?? { movingSec: 30, stationarySec: 120, minAccuracyM: 100, distanceFilterM: 10 });
  const battery = Math.round(((await Battery.getBatteryLevelAsync().catch(() => -1)) ?? -1) * 100);
  for (const loc of (data as { locations: Location.LocationObject[] }).locations) {
    const fix = { at: loc.timestamp, lat: loc.coords.latitude, lon: loc.coords.longitude, accuracyM: loc.coords.accuracy ?? 999, speed: loc.coords.speed ?? undefined };
    if (!sampler.accept(fix)) continue;
    await outbox.addPoint({ recordedAt: new Date(loc.timestamp).toISOString(), lat: fix.lat, lon: fix.lon, accuracyM: fix.accuracyM, ...(loc.coords.speed !== null ? { speed: Math.max(0, loc.coords.speed) } : {}), ...(loc.coords.heading !== null && loc.coords.heading! >= 0 ? { heading: loc.coords.heading! } : {}), ...(battery >= 0 ? { battery } : {}), mock: !!loc.mocked });
  }
  if (outbox.points.length >= 20) void sync.sync();
});

export type PermissionState = 'always' | 'while_in_use' | 'denied' | 'reduced_accuracy';
export async function permissionState(): Promise<PermissionState> {
  const fg = await Location.getForegroundPermissionsAsync(); if (!fg.granted) return 'denied';
  if ((fg as any).android?.accuracy === 'coarse' || (fg as any).ios?.accuracy === 'reduced') return 'reduced_accuracy';
  const bg = await Location.getBackgroundPermissionsAsync(); return bg.granted ? 'always' : 'while_in_use';
}
/** Asks for foreground, then background permission. The app explains why first (screen copy), never asks silently. */
export async function requestPermissions(): Promise<PermissionState> {
  const fg = await Location.requestForegroundPermissionsAsync(); if (!fg.granted) return 'denied';
  await Location.requestBackgroundPermissionsAsync(); return permissionState();
}
export async function currentFix() {
  try { const l = await Location.getCurrentPositionAsync({ accuracy: Location.Accuracy.High }); return { lat: l.coords.latitude, lon: l.coords.longitude, accuracyM: l.coords.accuracy ?? 999 }; } catch { return undefined; }
}
export async function startTracking() {
  const p = outbox.tracking?.profile; sampler = null;
  if (p?.paused) { await stopTracking(); return; }
  if (await Location.hasStartedLocationUpdatesAsync(TASK)) return;
  await Location.startLocationUpdatesAsync(TASK, {
    accuracy: Location.Accuracy.High, timeInterval: (p?.movingSec ?? 30) * 1000, distanceInterval: p?.distanceFilterM ?? 10, deferredUpdatesInterval: (p?.movingSec ?? 30) * 1000,
    pausesUpdatesAutomatically: false, showsBackgroundLocationIndicator: true, activityType: Location.ActivityType.Other,
    // Android: a visible, persistent notification for the whole time tracking is active (no hidden tracking).
    foregroundService: { notificationTitle: 'On duty — location is being recorded', notificationBody: 'Recording stops when you end duty.', notificationColor: '#0b4f7a', killServiceOnDestroy: false },
  });
}
export async function stopTracking() { if (await Location.hasStartedLocationUpdatesAsync(TASK).catch(() => false)) await Location.stopLocationUpdatesAsync(TASK); sampler = null; }
