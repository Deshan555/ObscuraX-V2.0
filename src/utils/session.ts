// Keeping work between visits, entirely on this device.
//
// - Preferences (watermark, mask style, detection, export options) are small
//   and always restored: localStorage.
// - The session (photos or video, masks, face track) can be large and holds
//   the user's originals, so it is offered back ("Continue where you left
//   off?") rather than restored silently: IndexedDB.

import { DetectSettings, Mask, MaskStyle, TrackInfo, TrackSample } from "../types";
import { DEFAULT_DETECT_SETTINGS, DEFAULT_MASK_STYLE } from "../constants/config";
import { BodyPartChoice, DEFAULT_BODY_PARTS } from "./bodyDetection";

// ── Preferences ───────────────────────────────────────────────────────────────

export interface Prefs {
  wmType: string;
  wmText: string;
  wmLink: string;
  wmColor: string;
  wmFont: string;
  wmSize: number;
  wmOpacity: number;
  wmBold: boolean;
  wmShadow: boolean;
  wmPos: { x: number; y: number };
  activePreset: string | null;
  wmFilter: string;
  wmBlur: number;
  exportPrefix: string;
  maskStyle: MaskStyle;
  detectSettings: DetectSettings;
  upscaleFactor: number;
  upscaleSharpen: number;
  bodyBlur: boolean;
  bodyParts: BodyPartChoice;
  bodyMinScore: number;
}

const PREFS_KEY = "obscurax.prefs";

const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isStr = (v: unknown): v is string => typeof v === "string";
const isBool = (v: unknown): v is boolean => typeof v === "boolean";

/** Saved preferences, keeping only well-formed values (the rest fall back to defaults). */
export function loadPrefs(): Partial<Prefs> {
  let raw: Record<string, unknown>;
  try { raw = JSON.parse(localStorage.getItem(PREFS_KEY) || "{}"); } catch { return {}; }
  if (!raw || typeof raw !== "object") return {};
  const out: Partial<Prefs> = {};
  for (const k of ["wmType", "wmText", "wmLink", "wmColor", "wmFont", "wmFilter", "exportPrefix"] as const) if (isStr(raw[k])) out[k] = raw[k] as string;
  for (const k of ["wmSize", "wmOpacity", "wmBlur", "upscaleFactor", "upscaleSharpen", "bodyMinScore"] as const) if (isNum(raw[k])) out[k] = raw[k] as number;
  for (const k of ["wmBold", "wmShadow", "bodyBlur"] as const) if (isBool(raw[k])) out[k] = raw[k] as boolean;
  if (raw.bodyParts && typeof raw.bodyParts === "object") {
    const bp = raw.bodyParts as Record<string, unknown>;
    out.bodyParts = Object.fromEntries(Object.entries(DEFAULT_BODY_PARTS).map(([k, v]) => [k, isBool(bp[k]) ? bp[k] : v])) as BodyPartChoice;
  }
  const pos = raw.wmPos as Prefs["wmPos"] | undefined;
  if (pos && isNum(pos.x) && isNum(pos.y)) out.wmPos = { x: pos.x, y: pos.y };
  if (raw.activePreset === null || isStr(raw.activePreset)) out.activePreset = raw.activePreset as string | null;
  if (raw.maskStyle && typeof raw.maskStyle === "object") out.maskStyle = { ...DEFAULT_MASK_STYLE, ...(raw.maskStyle as Partial<MaskStyle>) };
  if (raw.detectSettings && typeof raw.detectSettings === "object") out.detectSettings = { ...DEFAULT_DETECT_SETTINGS, ...(raw.detectSettings as Partial<DetectSettings>) };
  return out;
}

export function savePrefs(p: Prefs) {
  try { localStorage.setItem(PREFS_KEY, JSON.stringify(p)); } catch { /* storage full or blocked */ }
}

// ── Session (IndexedDB) ───────────────────────────────────────────────────────

export interface SavedImage {
  id: string;
  w: number;
  h: number;
  masks: Mask[];
  scanned?: boolean;
}

export interface SavedVideo {
  id: string;
  masks: Mask[];
  faceTrack: TrackSample[];
  trackInfo: TrackInfo[];
  hiddenTracks: number[];
  /** "ready" or "stale"; anything else is rescanned. */
  trackStatus: string;
}

export interface Session {
  v: 1;
  savedAt: number;
  mode: "image" | "video";
  images: SavedImage[];
  selectedIdx: number;
  video: SavedVideo | null;
}

/** A saved session with its files, ready to open. */
export interface LoadedSession {
  session: Session;
  files: Map<string, File>;
}

/** Videos larger than this aren't kept; masks and settings still are. */
export const MAX_SAVED_VIDEO_BYTES = 500 * 1024 * 1024;

const DB_NAME = "obscurax";
const FILES = "files";
const META = "meta";
const SESSION_KEY = "session";
export const LOGO_KEY = "logo";

let dbPromise: Promise<IDBDatabase> | null = null;
function db(): Promise<IDBDatabase> {
  dbPromise ??= new Promise((resolve, reject) => {
    if (typeof indexedDB === "undefined") { reject(new Error("IndexedDB unavailable")); return; }
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(FILES);
      req.result.createObjectStore(META);
    };
    req.onsuccess = () => {
      const d = req.result;
      // Let another tab (e.g. a newer version of the app) upgrade or delete the
      // database instead of waiting on this connection forever.
      d.onversionchange = () => { d.close(); dbPromise = null; };
      resolve(d);
    };
    req.onerror = () => reject(req.error);
  });
  dbPromise.catch(() => { dbPromise = null; });
  return dbPromise;
}

const done = (tx: IDBTransaction) => new Promise<void>((resolve, reject) => {
  tx.oncomplete = () => resolve();
  tx.onerror = () => reject(tx.error);
  tx.onabort = () => reject(tx.error);
});

const request = <T>(req: IDBRequest<T>) => new Promise<T>((resolve, reject) => {
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

/** Files already written, so autosave doesn't rewrite large blobs on every change. */
const stored = new Set<string>();

/**
 * Saves the session. Each file is written once (by id); files the session no
 * longer uses are deleted. Returns false if storage refused (e.g. quota).
 */
export async function saveSession(session: Session, files: { id: string; file: File }[]): Promise<boolean> {
  try {
    const d = await db();
    const keep = new Set(files.map(f => f.id));
    keep.add(LOGO_KEY);
    const tx = d.transaction([FILES, META], "readwrite");
    const fs = tx.objectStore(FILES);
    for (const { id, file } of files) {
      if (stored.has(id)) continue;
      fs.put(file, id);
    }
    const keys = await request(fs.getAllKeys());
    for (const k of keys) if (!keep.has(String(k))) { fs.delete(k); stored.delete(String(k)); }
    tx.objectStore(META).put(session, SESSION_KEY);
    await done(tx);
    files.forEach(f => stored.add(f.id));
    return true;
  } catch (err) {
    console.warn("ObscuraX: couldn't save the session:", err);
    return false;
  }
}

export async function loadSession(): Promise<LoadedSession | null> {
  try {
    const d = await db();
    const tx = d.transaction([FILES, META], "readonly");
    const session = await request(tx.objectStore(META).get(SESSION_KEY)) as Session | undefined;
    if (!session || session.v !== 1) return null;
    const ids = session.mode === "video" ? (session.video ? [session.video.id] : []) : session.images.map(i => i.id);
    const files = new Map<string, File>();
    for (const id of ids) {
      const f = await request(tx.objectStore(FILES).get(id)) as File | undefined;
      if (f) { files.set(id, f); stored.add(id); }
    }
    if (!files.size) return null;
    return { session, files };
  } catch (err) {
    console.warn("ObscuraX: couldn't read the saved session:", err);
    return null;
  }
}

/** Forgets the session and its files (the watermark logo stays). */
export async function clearSession() {
  try {
    const d = await db();
    const tx = d.transaction([FILES, META], "readwrite");
    const fs = tx.objectStore(FILES);
    for (const k of await request(fs.getAllKeys())) if (k !== LOGO_KEY) fs.delete(k);
    tx.objectStore(META).delete(SESSION_KEY);
    await done(tx);
    for (const k of [...stored]) if (k !== LOGO_KEY) stored.delete(k);
  } catch (err) {
    console.warn("ObscuraX: couldn't clear the saved session:", err);
  }
}

/** The watermark logo is a preference: kept and restored without asking. */
export async function saveLogo(file: File | null) {
  try {
    const d = await db();
    const tx = d.transaction(FILES, "readwrite");
    if (file) tx.objectStore(FILES).put(file, LOGO_KEY); else tx.objectStore(FILES).delete(LOGO_KEY);
    await done(tx);
  } catch (err) {
    console.warn("ObscuraX: couldn't save the logo:", err);
  }
}

export async function loadLogo(): Promise<File | null> {
  try {
    const d = await db();
    const f = await request(d.transaction(FILES, "readonly").objectStore(FILES).get(LOGO_KEY)) as File | undefined;
    return f ?? null;
  } catch { return null; }
}
