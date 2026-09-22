// @effect-diagnostics globalDate:off -- A fixed instant keeps calendar-window assertions deterministic.
import { describe, expect, it, vi } from "vite-plus/test";

import {
  enumerateHourStarts,
  formatDateTimeShort,
  formatHourShort,
  formatRelativeHourShort,
  makeWindow,
  windowReferenceTime,
} from "./usageFormat.ts";

describe("hourly usage formatting", () => {
  it("keeps requested zones separate when formatting repeated calls", () => {
    const instant = "2026-08-11T12:37:00.000Z";
    for (const zone of ["UTC", "America/New_York", "Asia/Kathmandu", "UTC"]) {
      expect(formatHourShort(instant, zone)).toBe(
        new Intl.DateTimeFormat("en-US", { timeZone: zone, hour: "numeric" }).format(
          new Date(instant),
        ),
      );
    }
    expect(() => formatHourShort(instant, "Etc/Unknown")).toThrow(RangeError);
    expect(formatHourShort("invalid", "UTC")).toBe("invalid");
  });

  it("uses the current system zone when no zone is supplied", () => {
    try {
      vi.stubEnv("TZ", "UTC");
      expect(formatHourShort("2026-08-11T12:37:00.000Z")).toBe("12 PM");
      vi.stubEnv("TZ", "America/New_York");
      expect(formatHourShort("2026-08-11T12:37:00.000Z")).toBe("8 AM");
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("enumerates 24 fixed buckets across a rolling window", () => {
    const hours = enumerateHourStarts("2026-08-10T12:37:00.000Z", "2026-08-11T12:37:00.000Z");

    expect(hours).toHaveLength(24);
    expect(hours[0]).toBe("2026-08-10T12:37:00.000Z");
    expect(hours[23]).toBe("2026-08-11T11:37:00.000Z");
  });

  it("formats rolling instants in the requested time zone", () => {
    expect(formatHourShort("2026-08-11T00:37:00.000Z", "UTC")).toBe("12 AM");
    expect(formatHourShort("2026-08-11T12:37:00.000Z", "UTC")).toBe("12 PM");
    expect(formatDateTimeShort("2026-08-11T17:37:00.000Z", "UTC")).toBe("Aug 11, 5 PM");
  });

  it("disambiguates repeated hours during a fall-back transition", () => {
    expect(formatHourShort("2026-11-01T05:37:00.000Z", "America/New_York")).toBe("1 AM EDT");
    expect(formatHourShort("2026-11-01T06:37:00.000Z", "America/New_York")).toBe("1 AM EST");
  });

  it("makes hourly tooltip dates relative to the window in its requested time zone", () => {
    const windowEnd = "2026-08-11T14:37:00.000Z";

    expect(formatRelativeHourShort("2026-08-10T17:37:00.000Z", windowEnd, "UTC")).toBe(
      "5 PM yesterday",
    );
    expect(formatRelativeHourShort("2026-08-11T14:37:00.000Z", windowEnd, "UTC")).toBe(
      "2 PM today",
    );
    expect(
      formatRelativeHourShort(
        "2026-08-11T01:37:00.000Z",
        "2026-08-11T10:37:00.000Z",
        "America/Los_Angeles",
      ),
    ).toBe("6 PM yesterday");
  });

  it("requests 24 hour buckets ending with the current hour", () => {
    try {
      vi.stubEnv("TZ", "UTC");
      const window = makeWindow(1, new Date("2026-08-11T12:37:42.123Z"), "hour");

      expect(window).toEqual({
        sinceDay: "2026-08-10",
        untilDay: "2026-08-11",
        timeZone: "UTC",
        resolution: "hour",
        sinceTime: "2026-08-10T13:00:00.000Z",
        untilTime: "2026-08-11T13:00:00.000Z",
      });
      expect(enumerateHourStarts(window.sinceTime!, window.untilTime!)).toHaveLength(24);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("keeps the same hourly request for the whole hour", () => {
    const first = makeWindow(1, new Date("2026-08-11T12:00:00.000Z"), "hour");
    const last = makeWindow(1, new Date("2026-08-11T12:59:59.999Z"), "hour");
    const next = makeWindow(1, new Date("2026-08-11T13:00:00.000Z"), "hour");

    expect(last).toEqual(first);
    expect([first.sinceTime, first.untilTime]).toEqual([
      "2026-08-10T13:00:00.000Z",
      "2026-08-11T13:00:00.000Z",
    ]);
    expect([next.sinceTime, next.untilTime]).toEqual([
      "2026-08-10T14:00:00.000Z",
      "2026-08-11T14:00:00.000Z",
    ]);
  });

  it("labels the in-progress hour as today during the last hour of the day", () => {
    try {
      vi.stubEnv("TZ", "America/Los_Angeles");
      const window = makeWindow(1, new Date("2026-08-12T06:40:00.000Z"), "hour");
      const reference = windowReferenceTime(window)!;

      expect(formatRelativeHourShort("2026-08-12T06:00:00.000Z", reference, window.timeZone)).toBe(
        "11 PM today",
      );
      expect(formatRelativeHourShort("2026-08-11T07:00:00.000Z", reference, window.timeZone)).toBe(
        "12 AM today",
      );
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("ends the hourly request on the day of its last covered hour", () => {
    try {
      vi.stubEnv("TZ", "America/Los_Angeles");
      const window = makeWindow(1, new Date("2026-08-12T06:15:00.000Z"), "hour");

      expect(window.untilTime).toBe("2026-08-12T07:00:00.000Z");
      expect([window.sinceDay, window.untilDay]).toEqual(["2026-08-11", "2026-08-11"]);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("degrades an unknown resolved zone to UTC instead of crashing", () => {
    const resolved = new Intl.DateTimeFormat().resolvedOptions();
    const resolvedOptions = vi
      .spyOn(Intl.DateTimeFormat.prototype, "resolvedOptions")
      .mockReturnValue({ ...resolved, timeZone: "Etc/Unknown" });

    try {
      const now = new Date("2026-08-11T12:37:42.123Z");

      expect(makeWindow(1, now, "hour").timeZone).toBe("UTC");
      expect(makeWindow(30, now).timeZone).toBe("UTC");
    } finally {
      resolvedOptions.mockRestore();
    }
  });
});
