// Storage adapter interface consumed by /core/auth/session.js:
//   get(key)          -> Promise<any | null>
//   set(key, value)   -> Promise<void>
//   remove(key)        -> Promise<void>
//
// Session logic is written once against this interface; each platform
// supplies the adapter that matches its actual storage primitive.

/** Chrome extension contexts (background service worker, popup). */
export const chromeStorageAdapter = {
  async get(key) {
    const result = await chrome.storage.local.get(key);
    return result[key] ?? null;
  },
  async set(key, value) {
    await chrome.storage.local.set({ [key]: value });
  },
  async remove(key) {
    await chrome.storage.local.remove(key);
  },
};

/** Web dashboard / marketing pages (plain browser tabs). */
export const webStorageAdapter = {
  async get(key) {
    const raw = window.localStorage.getItem(key);
    return raw ? JSON.parse(raw) : null;
  },
  async set(key, value) {
    window.localStorage.setItem(key, JSON.stringify(value));
  },
  async remove(key) {
    window.localStorage.removeItem(key);
  },
};
