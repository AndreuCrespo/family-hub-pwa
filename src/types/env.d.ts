/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

interface ImportMetaEnv {
  readonly VITE_FIREBASE_API_KEY?: string;
  readonly VITE_FIREBASE_AUTH_DOMAIN?: string;
  readonly VITE_FIREBASE_PROJECT_ID?: string;
  readonly VITE_FIREBASE_STORAGE_BUCKET?: string;
  readonly VITE_FIREBASE_MESSAGING_SENDER_ID?: string;
  readonly VITE_FIREBASE_APP_ID?: string;
  readonly VITE_VAPID_PUBLIC_KEY?: string;
  /** 'true' to use the local Firebase emulators (see npm run dev:emulators). */
  readonly VITE_USE_EMULATORS?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

/** From package.json, set at build time (vite.config.ts). */
declare const __APP_VERSION__: string;
