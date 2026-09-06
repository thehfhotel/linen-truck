import { describe, expect, it } from "bun:test";
import { haversineM, mapUrl, siteAt } from "../../src/domain/geo.ts";
import type { Site } from "../../src/domain/types.ts";
import { HF, HFVILLE, M_PER_DEG_LAT, SITES, northOf } from "./support.ts";

describe("haversineM", () => {
  it("should be zero for the same fix and symmetric between two", () => {
    expect(haversineM(HF, HF)).toBe(0);
    expect(haversineM(HF, HFVILLE)).toBeCloseTo(haversineM(HFVILLE, HF), 9);
  });

  it("should measure a pure north-south hop exactly", () => {
    // Along a meridian the formula reduces to dLat * (pi * R / 180).
    expect(haversineM(HF, northOf(HF, 250))).toBeCloseTo(250, 6);
    expect(haversineM(HF, northOf(HF, 1))).toBeCloseTo(1, 6);
    expect(M_PER_DEG_LAT).toBeCloseTo(111194.93, 2);
  });

  it("should put HF and HF Ville ~3.92 km apart in a straight line", () => {
    // The road between them is 4.9 km (config/rules.json referenceKm) — a straight
    // line MUST come out shorter than the reference, or every leg reads as a detour.
    expect(haversineM(HF, HFVILLE)).toBeCloseTo(3919.86, 1);
    expect(haversineM(HF, HFVILLE) / 1000).toBeLessThan(4.9);
  });
});

describe("siteAt", () => {
  it("should include the radius edge and exclude just beyond it", () => {
    // The fence comes from the site, not a literal: config/sites.json is
    // owner-tuned (250 m until 2026-09-06, 600 m since), and this test is about
    // the boundary rule, not about today's number.
    expect(siteAt(northOf(HF, HF.radiusM - 0.1), SITES)?.id).toBe("hf");
    expect(siteAt(northOf(HF, HF.radiusM + 0.1), SITES)).toBeNull();
    // The edge itself is inclusive (`d <= radiusM`). Stated exactly rather than
    // through `radiusM`, which lands a float ulp either side of the fence.
    const edge = northOf(HF, HF.radiusM);
    const fence: Site[] = [{ ...HF, radiusM: haversineM(edge, HF) }];
    expect(siteAt(edge, fence)?.id).toBe("hf");
    expect(siteAt(edge, [{ ...HF, radiusM: haversineM(edge, HF) - 1e-9 }])).toBeNull();
  });

  it("should return null when nothing is near and for an empty site list", () => {
    expect(siteAt(northOf(HF, 2000), SITES)).toBeNull();
    expect(siteAt(HF, [])).toBeNull();
  });

  it("should pick the NEAREST centre when two fences overlap, not the first", () => {
    const wide: Site[] = [
      { id: "far", name: { th: "ก", en: "far" }, lat: northOf(HF, 400).lat, lon: HF.lon, radiusM: 1000 },
      { id: "near", name: { th: "ข", en: "near" }, lat: northOf(HF, 100).lat, lon: HF.lon, radiusM: 1000 },
    ];
    expect(siteAt(HF, wide)?.id).toBe("near");
    expect(siteAt(northOf(HF, 500), wide)?.id).toBe("far");
  });
});

describe("mapUrl", () => {
  it("should render five decimals, padded and rounded", () => {
    expect(mapUrl(9.1212133, 99.351695)).toBe("https://www.google.com/maps?q=9.12121,99.35170");
    expect(mapUrl(9.1, 99)).toBe("https://www.google.com/maps?q=9.10000,99.00000");
  });
});
