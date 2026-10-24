# Changelog

Versions follow [semantic versioning](https://semver.org). The running version is shown at the bottom of **Settings**.

## 0.1.1 — 2026-10-24

- Fix: the home screen showed "Something went wrong" on phones that still had electricity prices saved by an earlier version. Saved weather and prices now carry a format version and are checked before use.
- The error screen shows the error details, and its Reload button also clears saved weather and prices.

## 0.1.0 — 2026-10-24

First tagged version, in use by the family.

- Home dashboard, calendar, shopping list, chores, weekly menu, key dates, shared expenses, notes, weather and electricity prices.
- Spanish and English, switchable in Settings and on the sign-in screens.
- Push notifications (Cloud Functions): what others add, event reminders, a morning summary and upcoming key dates. Each person chooses which ones they get.
- Invite links that expire after 7 days and can be revoked.
- Firestore rules that validate every write, with tests on the emulator.
- Code organized by feature, strict TypeScript, unit tests, CI on GitHub Actions.
