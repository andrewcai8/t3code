import type { ProvisionStorage } from "@t3tools/client-runtime/cloud";

import { writeFileAtomically } from "../../lib/atomic-file";

/**
 * `ProvisionStorage` for the phone. The stores read and write synchronously, and this device has
 * no synchronous key-value store, so the records live in memory and a debounced atomic write
 * mirrors them to one small JSON file. Hydration runs once at startup; a read before it lands
 * sees nothing, which costs at most the resumption of a request the app was killed during.
 */

const FILE_NAME = "provisioning.json";
const WRITE_DEBOUNCE_MS = 250;

const records = new Map<string, string>();
let hydrated = false;
let writeTimer: ReturnType<typeof setTimeout> | null = null;
let writing: Promise<void> = Promise.resolve();

async function storageFile() {
  const { File, Paths } = await import("expo-file-system");
  return new File(Paths.document, FILE_NAME);
}

/**
 * Loads the persisted records into memory. Safe to call more than once; only the first call
 * reads. A missing or unreadable file is an empty store, not an error: this data is a
 * convenience for resuming, never the source of truth.
 */
export async function hydrateProvisionStorage(): Promise<void> {
  if (hydrated) return;
  hydrated = true;
  try {
    const file = await storageFile();
    if (!file.exists) return;
    const parsed: unknown = JSON.parse(await file.text());
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return;
    for (const [key, value] of Object.entries(parsed)) {
      // A record written by a newer build may hold a shape this one cannot read. The stores
      // decode defensively, so carry the string through rather than dropping the machine.
      if (typeof value === "string" && !records.has(key)) records.set(key, value);
    }
  } catch {
    // An unreadable file means no resumable request, which the flow already handles.
  }
}

function scheduleWrite() {
  if (writeTimer !== null) clearTimeout(writeTimer);
  writeTimer = setTimeout(() => {
    writeTimer = null;
    const snapshot = JSON.stringify(Object.fromEntries(records));
    writing = writing
      .then(async () => {
        const file = await storageFile();
        await writeFileAtomically(file, snapshot);
      })
      .catch(() => {
        // Losing the mirror only costs resumption; the in-memory records still drive this run.
      });
  }, WRITE_DEBOUNCE_MS);
}

export const mobileProvisionStorage: ProvisionStorage = {
  getItem: (key) => records.get(key) ?? null,
  setItem: (key, value) => {
    records.set(key, value);
    scheduleWrite();
  },
  removeItem: (key) => {
    if (!records.delete(key)) return;
    scheduleWrite();
  },
};

/** Waits for any debounced mirror write to land. Tests and teardown use this; the app does not. */
export async function flushProvisionStorage(): Promise<void> {
  if (writeTimer !== null) {
    clearTimeout(writeTimer);
    writeTimer = null;
    const snapshot = JSON.stringify(Object.fromEntries(records));
    writing = writing.then(async () => {
      const file = await storageFile();
      await writeFileAtomically(file, snapshot);
    });
  }
  await writing;
}
