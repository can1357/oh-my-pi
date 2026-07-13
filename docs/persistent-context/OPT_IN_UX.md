# Opt-In UX

## First-run state

Persistent screen context is disabled. The primary action is **Keep disabled**. Enabling requires affirmative user action after a disclosure of captured data, storage location, retention defaults, remote-upload state, app scope, and pause/delete controls.

## Consent scopes

- This session only
- This project only
- Selected applications
- This device
- All trusted devices

Remote storage is a separate switch.

## Runtime controls

The eventual Desktop Tag panel provides persistent-context status, capture mode, active scope, storage usage, last capture time, pause/resume, review, session/project/global deletion, export, and permanent disable controls.

When active, an indicator communicates active, paused, degraded due to pressure, policy-blocked, storage-full, and remote-sync states.

## Revocation

1. Stop capture immediately.
2. Prevent new persistent writes.
3. Cancel queued enrichment.
4. Offer deletion of retained artifacts.
5. Append a consent-revocation audit event.
