import type { ProvisionStorage } from "@t3tools/client-runtime/cloud";

/** localStorage, absent or throwing on read as "nothing stored"; writes surface their failure. */
export const localProvisionStorage: ProvisionStorage = {
  getItem: (key) => {
    try {
      if (typeof localStorage === "undefined" || typeof localStorage.getItem !== "function") {
        return null;
      }
      return localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem: (key, value) => {
    if (typeof localStorage === "undefined") return;
    localStorage.setItem(key, value);
  },
  removeItem: (key) => {
    if (typeof localStorage === "undefined") return;
    localStorage.removeItem(key);
  },
};
