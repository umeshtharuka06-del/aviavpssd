# Devices, extension updates and recovery

## Device limit

* Every subscription (one per activation code) allows **up to 5 active devices**. New codes get `DEFAULT_DEVICE_LIMIT` (default **5**, configurable 1–5 on the VPS); the admin can pick 1–5 per code when generating.
* Enforced **on the server** in three layers: the code row is locked during redemption; a partial unique index allows one active slot per (subscription, device); and a database trigger (migration `0002`) refuses any active slot beyond the code's limit, even under concurrent requests.
* A 6th distinct device gets `409 DEVICE_LIMIT_REACHED` (`details: { deviceLimit: 5, devicesInUse: 5 }`). The extension shows: *"This subscription is already active on 5 of 5 devices. Ask the administrator to remove a device you no longer use."*

## What counts as "the same device"

The extension creates a random **device id** once and keeps it in `chrome.storage.local`. The server stores only an HMAC of it.

| Situation | Device id | Result |
|---|---|---|
| Chrome restart, extension reload, **extension update** (same install) | kept | Still active. On startup/update the extension re-checks the subscription **with the server** (no code needed). No new slot. |
| Session expired or signed out, then the **same code** is entered again | kept | `device_restored`: same slot, new session, expiry unchanged |
| Code entered again many times / concurrently on one device | kept | Still one slot (no duplicate device records) |
| Extension **uninstalled and reinstalled**, Chrome profile reset, storage cleared, a different Chrome profile or computer | **new** | Treated as a **new device**: entering the same code uses a free slot (`device_added`, e.g. 2 / 5). Expiry unchanged, no new code. |
| Unpacked (developer) build loaded from a **different folder** | new extension id → new storage | Same as reinstall. Keep loading from the same folder. Web Store updates keep the id. |

A reinstall therefore uses a slot until the admin removes the old one. With 5 slots there is headroom. When a customer reports "device limit reached", open the code in the admin site and remove the device that is no longer used (labels such as "Chrome · Windows" and *last seen* help).

## Updates never touch the subscription

* Updating or rebuilding the extension keeps `chrome.storage.local` (device id + session). On `onInstalled(reason: update)` and `onStartup`, the background calls the server (`GET /v1/subscription`, rotating the session if due).
* **Local data never authorizes anything.** If the server says the session is invalid, the subscription expired or was revoked, the extension shows that, whatever was stored locally.
* If the server is unreachable, the extension shows *"Can't reach the server"* with the last known status and keeps the session, so updates never lock anyone out.
* No update creates a code, redeems a code, or changes an expiry date. The activation history stays in the database.

## Admin tools (admin site → Codes → a code)

* **Devices (3 / 5)**: list of slots with label, activated, last seen and status.
* **Remove device**: frees ONE slot and signs that device out immediately (reason required, audited as `admin.device_revoked`). The removed device can only come back by entering the code again while a slot is free. If a code itself leaked, **revoke the code** instead.
* **Reset devices**: frees all slots (audited).
* **Device limit**: change 1–5 for this code; never below the devices in use (audited).
* None of these changes the activation or expiry date (tested).

## Existing codes (issued before this change)

Migration `0002` does **not** change any existing code's limit, activation or expiry. Existing codes keep the limit they were sold with (previously the default was 1). To give existing codes 5 devices, run the explicit command (dry run first):

```bash
npm run db -w @aviator/backend -- raise-device-limits --to 5            # dry run: shows how many codes
npm run db -w @aviator/backend -- raise-device-limits --to 5 --apply    # raises non-revoked codes below 5
```

It only raises limits (never lowers), skips revoked codes, never touches activations or expiry dates, and records one `admin.device_limits_raised` audit event. Individual codes can also be changed in the admin site.
