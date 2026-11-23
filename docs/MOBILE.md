# Mobile field app

Two parts:

| Part | Path | State |
|---|---|---|
| `mobile-core` — API client with device signing, durable outbox, sync engine (SOS first, then duty events, then location batches), duty state, SOS controller, sampler, backoff, point thinning | `packages/mobile-core` | **Tested** (`npm run test:mobile-core`) against the real API in-process, including offline queueing, restart recovery and SOS ordering |
| Expo app (React Native) — screens, OS location, secure storage, background task | `apps/mobile` | **Source only.** Not compiled, not run on a device or emulator |

The field simulator (`npm run simulate`) runs `mobile-core` over real HTTP with simulated GPS and network drops, which is the closest check available without devices.

## Build the app

```bash
cd apps/mobile
npm install                              # Expo SDK 52, expo-location, expo-task-manager, expo-secure-store, @noble/curves …
npx expo start                           # Expo Go or a development build
npx expo run:android                     # local Android build (Android Studio + SDK required)
# release builds: EAS Build (free tier) or `npx expo prebuild` then Gradle / Xcode
```

The app imports `mobile-core` through a Metro alias in `metro.config.js`. Set the default API URL in `app.json` → `expo.extra.apiBaseUrl`; users can change it on the sign-in screen.

## What the app does

- **Sign in** with organisation ID, username and password; generates an Ed25519 key in secure storage and registers the device (a second device waits for approval).
- **Privacy notice** acceptance before any location permission prompt; explanation card before the OS prompt; a link to settings when denied.
- **My Duty**: today's assignments (cached for offline), acknowledge roster, duty start/end, breaks, with geofence status from the server.
- **Tracking** only between duty start and end (and during an active SOS); Android foreground-service notification and an in-app banner while tracking.
- **Checkpoints**: scan QR with the camera; scans queue offline with device time and accuracy.
- **SOS**: press-and-hold; shows "sending", "queued — no network" honestly with call fallback; sent before anything else when the network returns; marked acknowledged only when a person acknowledges.
- **Sync status**: queue counts and oldest item age.

## Must be verified on devices before release

1. Background location on Android 10–15 (foreground service type `location`) and iOS (`always` permission, background mode), including Doze and battery-optimisation exemptions.
2. Battery use over an 8 h and a 12 h duty at both sampling profiles (FR-MOB-005, PRD §12.2).
3. Recovery after app kill, OS kill and reboot during a duty (queue survives — verified in mobile-core; the OS task restart is not).
4. Screen reader labels (TalkBack / VoiceOver) and Arabic RTL layout.
5. QR scanning in low light; rotating codes with device clock skew.

## Not implemented in the app
- Push notifications (no provider chosen — D-09).
- NFC checkpoint reading (API accepts the method).
- Store listings, signing keys, crash reporting.
