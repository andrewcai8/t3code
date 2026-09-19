/**
 * The persisted half of cloud provisioning: where a draft's request and its sandbox lease
 * survive a reload. The keys and record shapes are owned by the stores, so every client
 * writes the same records; only where they live is the client's business. Reads never
 * throw; a write may, and the stores let that surface.
 */
export interface ProvisionStorage {
  readonly getItem: (key: string) => string | null;
  readonly setItem: (key: string, value: string) => void;
  readonly removeItem: (key: string) => void;
}
