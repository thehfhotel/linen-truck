import { describe, expect, it } from "bun:test";
import { parseVoltage, pointFromRow } from "../../src/domain/sinotrackRow.ts";

const ROW: Record<string, string> = {
  nID: "1",
  strTEID: "1000000001",
  nTime: "1788585074",
  dbLon: "99.3356417",
  dbLat: "9.1479117",
  nDirection: "79",
  nSpeed: "18",
  nMileage: "0",
  strOther: "Voltages=13.2;RecvTime=1788585018",
};

describe("pointFromRow", () => {
  it("should turn the platform's all-strings row into numbers", () => {
    expect(pointFromRow(ROW)).toEqual({ t: 1788585074, lat: 9.1479117, lon: 99.3356417, speed: 18, voltage: 13.2 });
  });

  it("should leave voltage null when the fix carries none", () => {
    expect(pointFromRow({ ...ROW, strOther: "RecvTime=1788585019" })?.voltage).toBeNull();
    expect(pointFromRow({ ...ROW, strOther: "" })?.voltage).toBeNull();
    const { strOther: _drop, ...noOther } = ROW;
    expect(pointFromRow(noOther)?.voltage).toBeNull();
  });

  it("should default a missing speed to 0 rather than NaN", () => {
    const { nSpeed: _drop, ...noSpeed } = ROW;
    expect(pointFromRow(noSpeed)?.speed).toBe(0);
    expect(pointFromRow({ ...ROW, nSpeed: "" })?.speed).toBe(0);
  });

  it("should reject a row with no usable fix", () => {
    expect(pointFromRow({ ...ROW, nTime: "" })).toBeNull();
    expect(pointFromRow({ ...ROW, nTime: "not-a-number" })).toBeNull();
    expect(pointFromRow({ ...ROW, dbLat: "" })).toBeNull();
    expect(pointFromRow({ ...ROW, dbLon: "x" })).toBeNull();
    expect(pointFromRow({})).toBeNull();
  });

  it("should keep a (0, 0) fix — cleanPoints is what drops null island", () => {
    const zero = pointFromRow({ ...ROW, dbLat: "0", dbLon: "0" });
    expect(zero).not.toBeNull();
    expect(zero!.lat).toBe(0);
  });
});

describe("parseVoltage", () => {
  it("should read Voltages= wherever it sits in the blob", () => {
    expect(parseVoltage("Voltages=13.8")).toBe(13.8);
    expect(parseVoltage("RecvTime=1788585018;Voltages=12.6")).toBe(12.6);
    expect(parseVoltage("Voltages=12.6;RecvTime=1788585018")).toBe(12.6);
  });

  it("should return null for anything it cannot read", () => {
    expect(parseVoltage(undefined)).toBeNull();
    expect(parseVoltage("")).toBeNull();
    expect(parseVoltage("RecvTime=1788585018")).toBeNull();
    expect(parseVoltage("Voltages=")).toBeNull();
    expect(parseVoltage("Voltages=abc")).toBeNull();
    expect(parseVoltage("MyVoltages=13.8")).toBeNull();
  });
});
