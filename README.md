# Casa 🏠 · family hub PWA

[![CI](https://github.com/AndreuCrespo/family-hub-pwa/actions/workflows/ci.yml/badge.svg)](https://github.com/AndreuCrespo/family-hub-pwa/actions/workflows/ci.yml)

A shared calendar and household organizer for the whole family. It's a **Progressive Web App**: it installs from the browser on Android and iPhone, with no app stores and no paid Apple Developer account. Changes show up instantly on everyone's phone.

<p align="center">
  <img src="docs/home-mobile.jpg" alt="Home screen on a phone" height="520">
  &nbsp;
  <img src="docs/home-wall-display.jpg" alt="Home screen on a large display, as a wall dashboard" height="520">
</p>

<sub>Screenshots from demo mode, with sample data.</sub>

**Stack:** React 19 + TypeScript (strict) + Vite, as a PWA with a service worker · Firebase Auth, Firestore, Hosting and Cloud Functions · Web Push (VAPID) · [Open-Meteo](https://open-meteo.com) for weather and [REE](https://www.ree.es/es/apidatos) for electricity prices · Vitest, the Firestore emulator, Biome and GitHub Actions for quality.

## Features

- **Bilingual**: Spanish and English, switchable in Settings or on the sign-in screens. It starts in the phone's language, and each phone gets its notifications in its own language.
- **Home dashboard**: clock and weather, "up next" with a countdown, today and tomorrow agenda, today's menu, the week at a glance, plus cards for shopping, chores, electricity, key dates, expenses and notes. **Each person chooses which cards they see and in what order.** On a tablet or desktop it becomes a wall dashboard.
- **Calendar**: week and month views, one color per family member (kids too), recurring and multi-day events, and reminders.
- **Shopping list**: shared in real time, with suggestions based on what you buy most and comma-separated quick add.
- **Chores**: household tasks with an assignee; recurring ones come back automatically when checked off. Completed one-off chores are deleted after 30 days, or with **Clear completed**.
- **Meal plan**: lunch and dinner for each day, also shown in the calendar.
- **Key dates**: birthdays (with age), car inspection, insurance renewals and bills, with a reminder days in advance.
- **Expenses**: who paid what, who owes whom, and a monthly summary by category.
- **Notes**: a shared board (guest Wi-Fi, useful phone numbers…).
- **Weather** and **electricity price**: hourly Spanish regulated tariff (PVPC) and the cheapest hours to run the washing machine.
- **Push notifications**: what the other person adds arrives instantly ("Sam added to the shopping list: milk, bread and eggs"), plus event reminders, a morning summary and upcoming key dates, each in the phone's language. **Each person chooses which ones they get** (for example, no shopping notifications) and the time of their morning summary.

---

## Try it now (demo mode)

```bash
npm install
```

```bash
npm run dev
```

Open http://localhost:5173 and tap **Try demo mode**. Sample data is stored only in that browser. Demo mode is available while Firebase is not configured (no `.env.local`).

To try it on a phone on the same Wi-Fi, open the `Network` address printed by Vite. Under WSL2 that address isn't reachable from other devices by default; run it from Windows or deploy it instead.

---

## Setup

### 1. Create the Firebase project

1. Go to <https://console.firebase.google.com> → **Create project**. Google Analytics isn't needed.
2. **Authentication** → _Get started_ → _Sign-in method_: enable **Email/Password** and **Google**.
3. **Firestore Database** → _Create database_ → **Standard** edition, `(default)` ID → location **`europe-southwest1` (Madrid)** → **production mode**.
   > If you pick another location, update `FIRESTORE_REGION` in [`functions/src/index.ts`](functions/src/index.ts): the instant-notification function must run in the same region as the database.
4. **Project settings** (gear icon) → _Your apps_ → **`</>`** (web) → register the app. Copy the `firebaseConfig` values.
5. In the project folder, copy `.env.example` to `.env.local` and fill in those values:

   ```
   VITE_FIREBASE_API_KEY=AIza...
   VITE_FIREBASE_AUTH_DOMAIN=your-project.web.app
   VITE_FIREBASE_PROJECT_ID=your-project
   ...
   ```

   > Set `AUTH_DOMAIN` to `YOUR-PROJECT.web.app`, not the `firebaseapp.com` domain Firebase suggests. That keeps Google sign-in working inside the app installed on an iPhone. See step 3.
### 2. Deploy it (Firebase Hosting)

```bash
npm install -g firebase-tools
```

```bash
firebase login --no-localhost
```

(`--no-localhost` gives you a code to paste into the terminal; from WSL the regular browser login sometimes never returns to the terminal)

```bash
firebase use --add
```

(pick your project and give it the alias `default`)

```bash
npm run deploy:web
```

That builds the app and deploys the website and the Firestore security rules (`firestore.rules`). The app is then live at **https://YOUR-PROJECT.web.app**. Notifications come later (see below).

### 3. Google sign-in on iPhone (recommended)

Skip this if everyone signs in with email and password.

In <https://console.cloud.google.com> (same project) → _APIs & Services_ → _Credentials_ → _Web client (auto created by Google Service)_ → under **Authorized redirect URIs**, keep the existing URI and add:

```
https://YOUR-PROJECT.web.app/__/auth/handler
```

### 4. Install it on the phones

- **Android (Chrome)**: open the site → ⋮ menu → **Install app**.
- **iPhone (Safari)**: open the site → **Share** → **Add to Home Screen**. Always open it from that icon: notifications only work there.

### 5. Create your household and invite your partner

1. Sign in and set up the household: your name, your partner's, the kids' and your city.
2. On the **home screen** tap **Share** (or in **Settings → Invite**, **Create an invite link**) and send the link.
3. Your partner opens the link, creates an account, taps **Join** and picks their name.

> On iPhone the installed app doesn't share storage with Safari: open the invite link in Safari, join there, then add it to the Home Screen and sign in again.
>
> An invite link works for **7 days** and anyone who has it can join while it lasts, so only send it to people who should. **Settings → Invite → Revoke** cancels it at once.

---

## Push notifications (Cloud Functions)

Two functions in [`functions/`](functions/), deployed to the same Firebase project, send them:

| Function            | When                                   | What                                                                                                                                     |
| ------------------- | -------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `onActivityCreated` | Instantly, when someone adds something | "Sam added to the shopping list: milk, bread and eggs". Bursts are grouped into one notification, sent only to the other people's phones |
| `notificationsTick` | Every 5 minutes                        | Event reminders, the morning summary (8:00 by default) and key dates                                                                     |

### a) Switch to the Blaze plan and set a budget alert

Cloud Functions need the **Blaze** (pay-as-you-go) plan. A family's usage fits in the free tier and the expected bill is **€0**, but set an alert anyway:
1. Firebase console → bottom left, **Spark → Upgrade** → **Blaze**, and link a payment method.
2. When asked for a **budget**, enter **€1** to get an email if anything spikes.

### b) VAPID keys

```bash
npm --prefix functions install
```

```bash
npm --prefix functions run vapid
```

- The **public** key goes in `.env.local` as `VITE_VAPID_PUBLIC_KEY` (the app uses it). The first deployment will also ask for it.
- The **private** key is stored as a secret in Google Cloud (Secret Manager) with this command, which asks you to paste it. Don't save it in any file in the repo:

```bash
firebase functions:secrets:set VAPID_PRIVATE_KEY
```

### c) Deploy everything

```bash
npm run deploy
```

It deploys the website and rules first and then the functions, so a function error never blocks a website release. The first time it asks for:
- `VAPID_PUBLIC_KEY`: the public key from step b.
- `VAPID_SUBJECT`: a contact for the push services, such as `mailto:you@example.com` or your app's `https://` URL.

Both values are saved in `functions/.env.YOUR-PROJECT`, which isn't committed. If it asks how many days to keep function container images, answer **1** to avoid storage charges.

> The first deployment of the Firestore-triggered function often fails with an _Eventarc_ permission error: Google needs a few minutes to provision permissions. Wait 5 minutes and run `npm run deploy` again.
>
> `npm run deploy` gives the CLI 120 s (`FUNCTIONS_DISCOVERY_TIMEOUT`) to analyze the functions. The default 10 s isn't enough from WSL with the project under `/mnt/…`, because reading `node_modules` from the Windows drive is slow (error _User code failed to load … Timeout after 10000_).

### d) Enable them on each phone

In the app: **Settings → Notifications on this phone**. Below it, each person picks which notifications they want. On iPhone the app must be installed on the Home Screen first, with iOS 16.4 or later. Notifications arrive in the language selected on that phone.

---

## Costs

| Service                              | Plan                     | For a family                                                                               |
| ------------------------------------ | ------------------------ | ------------------------------------------------------------------------------------------ |
| Firebase Auth, Firestore and Hosting | Free (also within Blaze) | Far below the limits (50,000 Firestore reads per day). The 5-minute task reads one document per household while no phone has notifications on, and only what's due when one does |
| Cloud Functions and Cloud Scheduler  | Blaze                    | Within the free tier: 2 million invocations per month and 3 free scheduled jobs            |
| Secret Manager                       | Blaze                    | 1 secret, within the free tier                                                             |
| Open-Meteo and REE                   | Public APIs              | No key, no cost                                                                            |

---

## Security and privacy

- **No credentials in the repository**:
  - The Firebase config lives in `.env.local`.
  - The VAPID private key lives in Secret Manager.
  - The functions use the project's own identity; no service account keys are downloaded.
  - `.gitignore` blocks `.env*`, `*firebase-adminsdk*.json`, `*.pem`, `*.key` and the emulators' secret files.
- The Firebase web config (`VITE_FIREBASE_*`) isn't secret: it ends up in the JavaScript every browser downloads. What protects the data are the [Firestore rules](firestore.rules), covered by 110 tests against the emulator:
  - Only members can read or change a household. Members can remove accounts from it but never add one.
  - Joining requires a valid invite: a random code that expires after 7 days and can be revoked. Each account records the code it used, and the rules check it.
  - Every write is validated: allowed fields, types and sizes (the limits live in [`src/shared/limits.ts`](src/shared/limits.ts)).
  - Each person's home layout is private to them. Push subscriptions can't be read by anyone, and only point to the known push services.
  - Activity records (for notifications) can only be created, in your own name.
- Signing out turns notifications off on that device and deletes the offline copy of the data.
- The hosting sends security headers (`nosniff`, `Referrer-Policy`, `X-Frame-Options`, `Permissions-Policy`, HSTS) and a Content Security Policy in report-only mode.
- Notification links can only open pages of the app. Function logs only contain hashed IDs and counts, never your events or notes.

---

## Development

```
src/
  app/        App shell: routing, sections, navigation, household gate, error boundary
  core/       Data layer (Firestore and demo backends, live store), clock, formatting, storage, session
  features/   One folder per section: page, components, logic, tests and styles
              auth · calendar · dashboard · energy · expenses · keyDates · members · menu
              more · notes · notifications · settings · shopping · tasks · weather · demo
  ui/         Shared components: sheet (<dialog>), toasts, buttons, inputs
  i18n/       Spanish and English UI texts (es.ts defines the keys; en.ts must match)
  shared/     Types, dates, recurrence, limits, routes and locale (no dependencies; also used by the functions)
  styles/     Design tokens, base styles and shared components
  sw.ts       Service worker (offline support and notifications)
functions/
  src/logic.ts   What to notify and when (pure logic)
  src/parse.ts   Validation of the stored documents
  src/push.ts    Web Push delivery
  src/store.ts   Firestore reads, notifier state and daily cleanup
  src/run.ts     The two jobs
  src/index.ts   The two Cloud Functions
firestore.rules  Security rules
tests/rules/     Security rules tests (Firestore emulator)
```

**How it works**

- Every screen reads live data through one shared store: one Firestore listener per collection, opened while something shows it and closed a few minutes after. Writes are optimistic and work offline.
- The weekly menu only syncs recent weeks; older ones load when you look at them.
- One clock for the whole app, ticking on the minute: each component only re-renders when what it shows changes.
- The app's own code is about 65 kB; Firebase and React are separate files, so an update only downloads what changed. Sections load when first opened.
- A new version installs in the background and switches over the next time the app is hidden, so nobody loses what they're typing.

**Scripts**

- `npm run dev`: local dev server.
- `npm run dev:emulators`: the app against local Firebase emulators (Auth and Firestore, with the real rules). Needs Java and the Firebase CLI.
- `npm run check`: lint, types, unit tests and functions tests.
- `npm test`: unit tests (Vitest).
- `npm run test:rules`: security rules tests on the Firestore emulator (Java needed).
- `npm run lint` / `npm run format`: [Biome](https://biomejs.dev) for linting and formatting.
- `npm run build`: type-check and production build.
- `npm run deploy:web`: deploy the website and rules.
- `npm run deploy`: deploy everything, functions included (needs Blaze). The functions are type-checked and tested first.
- `npm run icons`: regenerate the icons (PNG and `favicon.ico`) from `public/favicon.svg` and `assets/icon-full.svg`.

[GitHub Actions](.github/workflows/ci.yml) runs all the checks, the rules tests and a build on every push.

> **WSL or Windows, not both.** `node_modules` contains native binaries for the system that ran `npm install` (Rolldown, TypeScript, esbuild). This project is installed from **WSL**. To use it from PowerShell, delete `node_modules` and `functions/node_modules` and reinstall there. With the project under `/mnt/d/...`, Vite polls for file changes so edits made from Windows are picked up too (already set in `vite.config.ts`).

## Ideas for later

- Wall display: a cheap tablet or a "hacked" digital photo frame (like Wes Bos's) running the app. The wide layout is already designed for it.
- Export the calendar as iCal to see it in the phone's native calendar.
- Work shifts with repeating patterns that fill themselves in.
