// Offline support: registers the service worker (built from src/sw-template.js)
// and exposes its state to React: "ready to work offline", "update waiting",
// and whether the device is online.
import { useSyncExternalStore } from "react";

interface PwaState {
  /** True once, right after the first install has cached everything. */
  offlineReady: boolean;
  /** A new version is installed and waits for the user to reload. */
  updateReady: boolean;
}

let state: PwaState = { offlineReady: false, updateReady: false };
let waitingWorker: ServiceWorker | null = null;
let userAcceptedUpdate = false;
const listeners = new Set<() => void>();

function setState(patch: Partial<PwaState>) {
  state = { ...state, ...patch };
  listeners.forEach(l => l());
}

const subscribe = (l: () => void) => { listeners.add(l); return () => listeners.delete(l); };

export function registerServiceWorker() {
  if (!import.meta.env.PROD || !("serviceWorker" in navigator)) return;
  const sw = navigator.serviceWorker;

  // Reload only when the user asked for the update, never mid-edit on its own.
  let reloading = false;
  sw.addEventListener("controllerchange", () => {
    if (!userAcceptedUpdate || reloading) return;
    reloading = true;
    window.location.reload();
  });

  const register = async () => {
    try {
      const reg = await sw.register(`${import.meta.env.BASE_URL}sw.js`, { scope: import.meta.env.BASE_URL });

      const watch = (worker: ServiceWorker | null) => {
        if (!worker) return;
        const check = () => {
          if (worker.state !== "installed") return;
          if (sw.controller) { waitingWorker = worker; setState({ updateReady: true }); }
          else setState({ offlineReady: true });
        };
        worker.addEventListener("statechange", check);
        check();
      };
      if (reg.waiting && sw.controller) { waitingWorker = reg.waiting; setState({ updateReady: true }); }
      watch(reg.installing);
      reg.addEventListener("updatefound", () => watch(reg.installing));

      // Look for a new version when the connection comes back, and hourly.
      const update = () => { if (navigator.onLine) reg.update().catch(() => {}); };
      window.addEventListener("online", update);
      setInterval(update, 60 * 60 * 1000);

      // Ask the browser not to evict the cached app and face model under storage pressure.
      navigator.storage?.persist?.().catch(() => {});
    } catch (err) {
      console.warn("ObscuraX: offline support unavailable:", err);
    }
  };
  if (document.readyState === "complete") register();
  else window.addEventListener("load", register, { once: true });
}

/** Switches to the waiting version; the page reloads once it takes over. */
export function applyUpdate() {
  if (!waitingWorker) { window.location.reload(); return; }
  userAcceptedUpdate = true;
  waitingWorker.postMessage({ type: "SKIP_WAITING" });
}

export function dismissUpdate() { setState({ updateReady: false }); }
export function clearOfflineReady() { setState({ offlineReady: false }); }

export function usePwa(): PwaState {
  return useSyncExternalStore(subscribe, () => state, () => state);
}

const subscribeOnline = (l: () => void) => {
  window.addEventListener("online", l);
  window.addEventListener("offline", l);
  return () => { window.removeEventListener("online", l); window.removeEventListener("offline", l); };
};

export function useOnline(): boolean {
  return useSyncExternalStore(subscribeOnline, () => navigator.onLine, () => true);
}
