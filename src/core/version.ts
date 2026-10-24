// Version of the running app, from package.json (set at build time). Outside a
// Vite build (unit tests) the constant doesn't exist.
export const APP_VERSION = typeof __APP_VERSION__ === 'string' ? __APP_VERSION__ : 'dev';
