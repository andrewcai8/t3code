import { describe, expect, it } from "@effect/vitest";

import { resolveAssetUrl } from "./assets.ts";

describe("resolveAssetUrl", () => {
  const asset = "/api/assets/signed-token/screen%20shot.png";

  it("resolves server-relative URLs against a plain origin", () => {
    expect(resolveAssetUrl("https://env.test", asset)).toBe(
      "https://env.test/api/assets/signed-token/screen%20shot.png",
    );
    expect(resolveAssetUrl("https://env.test/", asset)).toBe(
      "https://env.test/api/assets/signed-token/screen%20shot.png",
    );
  });

  it("keeps a gateway path prefix with or without a trailing slash", () => {
    const expected =
      "https://manager.test/api/provisioned-environment/lease%2F1/api/assets/signed-token/screen%20shot.png";
    expect(
      resolveAssetUrl("https://manager.test/api/provisioned-environment/lease%2F1/", asset),
    ).toBe(expected);
    expect(
      resolveAssetUrl("https://manager.test/api/provisioned-environment/lease%2F1", asset),
    ).toBe(expected);
  });

  it("keeps the asset's query and hash and drops the base's", () => {
    expect(
      resolveAssetUrl(
        "https://manager.test/api/provisioned-environment/lease-1/?token=pairing#frag",
        "/api/attachments/upload/payload.sig?wsTicket=ticket-1#t=2",
      ),
    ).toBe(
      "https://manager.test/api/provisioned-environment/lease-1/api/attachments/upload/payload.sig?wsTicket=ticket-1#t=2",
    );
  });

  it("passes absolute and protocol-relative URLs through", () => {
    const base = "https://manager.test/api/provisioned-environment/lease-1/";
    expect(resolveAssetUrl(base, "https://local.test/api/assets/t/clip.mp4")).toBe(
      "https://local.test/api/assets/t/clip.mp4",
    );
    expect(resolveAssetUrl(base, "//cdn.test/api/assets/t/clip.mp4")).toBe(
      "https://cdn.test/api/assets/t/clip.mp4",
    );
  });

  it("returns null for an unusable base", () => {
    expect(resolveAssetUrl("not a url", asset)).toBeNull();
  });
});
