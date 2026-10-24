// Web Push delivery: who gets each message, the payload, and sending it to
// every device in its own language.
import webpush from 'web-push';
import { LIMITS } from '../../src/shared/limits';
import { toLang } from '../../src/shared/locale';
import { clip } from '../../src/shared/text';
import type { Device, Lang } from '../../src/shared/types';
import { log } from './log';
import type { Message, MessageText } from './logic';

/** Push services allow 4096 bytes; aes128gcm encryption leaves ~3993 of them for the payload. */
export const MAX_PAYLOAD_BYTES = 3800;
const MAX_BODY_CHARS = 1500;
/** web-push's own timeout only fires when the socket goes idle. */
const PUSH_TIMEOUT_MS = 10_000;
/** Hard limit for a whole send, however slowly the push service answers. */
const PUSH_DEADLINE_MS = 12_000;

/** Push services a subscription may point to (firestore.rules allows the same ones). */
const PUSH_HOSTS = new Set([
  'fcm.googleapis.com',
  'android.googleapis.com',
  'updates.push.services.mozilla.com',
  'web.push.apple.com',
]);
const PUSH_HOST_SUFFIX = '.notify.windows.com';

/** Is it an https URL of a known push service? Nothing else is ever sent to. */
export function isPushEndpoint(endpoint: string): boolean {
  let u: URL;
  try {
    u = new URL(endpoint);
  } catch {
    return false;
  }
  if (u.protocol !== 'https:' || u.port !== '' || u.username || u.password) return false;
  const host = u.hostname.toLowerCase();
  return PUSH_HOSTS.has(host) || (host.endsWith(PUSH_HOST_SUFFIX) && host.length > PUSH_HOST_SUFFIX.length);
}

/** Can it receive anything? A complete subscription to a known push service. */
export function canReceive(d: Pick<Device, 'subscription'>): boolean {
  const s = d.subscription;
  return Boolean(s?.endpoint && s.keys?.p256dh && s.keys?.auth && isPushEndpoint(s.endpoint));
}

/** Target devices of a message: those of its accounts that can receive, without repeated endpoints. */
export function selectDevices<D extends Pick<Device, 'uid' | 'subscription'>>(
  devices: D[],
  toUids: readonly string[],
): D[] {
  const to = new Set(toUids);
  const seen = new Set<string>();
  return devices.filter((d) => {
    if (!to.has(d.uid) || !canReceive(d) || seen.has(d.subscription.endpoint)) return false;
    seen.add(d.subscription.endpoint);
    return true;
  });
}

const utf8 = new TextEncoder();

/** What gets sent to the service worker, always within MAX_PAYLOAD_BYTES (the body gets shorter if needed). */
export function pushPayload(m: MessageText & { url: string; tag: string }): string {
  const title = clip(m.title, LIMITS.title);
  for (let max = MAX_BODY_CHARS; ; max = Math.floor(max * 0.75)) {
    const json = JSON.stringify({ title, body: clip(m.body, max), url: m.url, tag: m.tag });
    if (max <= 1 || utf8.encode(json).length <= MAX_PAYLOAD_BYTES) return json;
  }
}

// ---------- sending ----------

export interface Vapid {
  publicKey: string;
  privateKey: string;
  subject: string;
}

export function configureVapid(v: Vapid) {
  webpush.setVapidDetails(v.subject, v.publicKey, v.privateKey);
}

/** ok · gone (unsubscribed: delete the device) · rejected (this payload never fits: don't retry) · error (try again later). */
type Outcome = 'ok' | 'gone' | 'rejected' | 'error';

function withDeadline<T>(p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`no answer in ${ms} ms`)), ms);
  });
  return Promise.race([p, deadline]).finally(() => clearTimeout(timer));
}

async function sendOne(device: Device, payload: string, m: Message): Promise<Outcome> {
  try {
    await withDeadline(
      webpush.sendNotification(device.subscription, payload, {
        TTL: m.ttl,
        urgency: m.urgency,
        timeout: PUSH_TIMEOUT_MS,
      }),
      PUSH_DEADLINE_MS,
    );
    return 'ok';
  } catch (e) {
    const status = (e as { statusCode?: number }).statusCode;
    if (status === 404 || status === 410) return 'gone';
    const fields = { device: device.id, kind: m.kind, status, error: (e as Error).message };
    if (status === 400 || status === 413) {
      log.error('Push rejected', fields);
      return 'rejected';
    }
    log.warn('Push failed', fields);
    return 'error';
  }
}

export interface DeliveryReport {
  /** Keys of the messages that reached someone, or that no target could take for good. */
  delivered: Set<string>;
  /** Keys of the messages that only got temporary errors: try again on the next run. */
  failed: Set<string>;
  /** Devices that unsubscribed (404/410): delete them. */
  goneDeviceIds: string[];
  sent: number;
  errors: number;
  rejected: number;
  langs: Lang[];
}

/**
 * Sends each message to its devices, each device in its own language. A
 * message counts as delivered unless every target failed with a temporary error.
 */
export async function deliver(messages: Message[], devices: Device[]): Promise<DeliveryReport> {
  const report: DeliveryReport = {
    delivered: new Set(),
    failed: new Set(),
    goneDeviceIds: [],
    sent: 0,
    errors: 0,
    rejected: 0,
    langs: [],
  };
  const gone = new Set<string>();
  const langs = new Set<Lang>();

  await Promise.all(
    messages.map(async (m) => {
      const payloads = new Map<Lang, string>();
      const payloadIn = (lang: Lang) => {
        let p = payloads.get(lang);
        if (p === undefined) {
          p = pushPayload({ ...m.render(lang), url: m.url, tag: m.tag });
          payloads.set(lang, p);
        }
        return p;
      };
      const targets = selectDevices(devices, m.toUids);
      const outcomes = await Promise.all(
        targets.map((d) => {
          const lang = toLang(d.lang);
          langs.add(lang);
          return sendOne(d, payloadIn(lang), m);
        }),
      );
      let ok = 0;
      let errors = 0;
      outcomes.forEach((o, i) => {
        if (o === 'ok') ok++;
        else if (o === 'error') errors++;
        else if (o === 'rejected') report.rejected++;
        else {
          const id = targets[i]?.id;
          if (id) gone.add(id);
        }
      });
      report.sent += ok;
      report.errors += errors;
      if (m.key) (ok > 0 || errors === 0 ? report.delivered : report.failed).add(m.key);
    }),
  );
  report.goneDeviceIds = [...gone];
  report.langs = [...langs];
  return report;
}
