import { describe, expect, it } from "vitest";
import {
  allocateRefund,
  buildDailyRevenueTrend,
  ean13CheckDigit,
  validateSalePayment,
} from "../server/domain.js";

describe("allocateRefund", () => {
  it("returns the full remaining payment when it is a complete refund", () => {
    const sale = {
      total: 150_000,
      payments: [
        { method: "cash", amount: 100_000 },
        { method: "qris", amount: 50_000 },
      ],
    };

    expect(allocateRefund(sale, 150_000)).toEqual([
      { method: "cash", amount: 100_000 },
      { method: "qris", amount: 50_000 },
    ]);
  });

  it("accounts for previous refunds", () => {
    const sale = {
      total: 100_000,
      payments: [{ method: "cash", amount: 100_000 }],
      returns: [{ amount: 40_000, payments: [{ method: "cash", amount: 40_000 }] }],
    };

    expect(allocateRefund(sale, 30_000)).toEqual([
      { method: "cash", amount: 30_000 },
    ]);
  });

  it("rejects refunds above the remaining paid amount", () => {
    const sale = {
      total: 50_000,
      payments: [{ method: "cash", amount: 50_000 }],
    };

    expect(() => allocateRefund(sale, 50_001)).toThrow("Nilai retur melebihi");
  });
});

describe("ean13CheckDigit", () => {
  it("calculates a valid check digit", () => {
    expect(ean13CheckDigit("200000000001")).toBe("5");
  });

  it("rejects malformed input", () => {
    expect(() => ean13CheckDigit("123")).toThrow("12 digit");
  });
});

describe("validateSalePayment", () => {
  it("allows split payments and calculates change", () => {
    expect(validateSalePayment({
      total: 75_000,
      cashTendered: 30_000,
      payments: [
        { method: "cash", amount: 25_000 },
        { method: "qris", amount: 50_000 },
      ],
    })).toEqual({
      payments: [
        { method: "cash", amount: 25_000 },
        { method: "qris", amount: 50_000 },
      ],
      cashAmount: 25_000,
      change: 5_000,
    });
  });

  it("rejects payment totals that differ from the sale", () => {
    expect(() => validateSalePayment({
      total: 75_000,
      cashTendered: 80_000,
      payments: [{ method: "cash", amount: 70_000 }],
    })).toThrow("Jumlah pembayaran");
  });

  it("rejects duplicate payment methods", () => {
    expect(() => validateSalePayment({
      total: 75_000,
      cashTendered: 75_000,
      payments: [
        { method: "cash", amount: 40_000 },
        { method: "cash", amount: 35_000 },
      ],
    })).toThrow("Metode atau nominal");
  });
});

describe("buildDailyRevenueTrend", () => {
  it("aggregates completed sales per day and fills missing days with zero", () => {
    const trend = buildDailyRevenueTrend({
      from: "2026-11-19",
      to: "2026-11-21",
      sales: [
        { createdAt: "2026-11-19T10:15:00", total: 25_000, netTotal: 25_000, status: "completed" },
        { createdAt: "2026-11-19T14:30:00", total: 15_000, netTotal: 15_000, status: "completed" },
        { createdAt: "2026-11-21T09:00:00", total: 50_000, netTotal: 35_000, status: "partially_returned" },
        { createdAt: "2026-11-21T11:00:00", total: 20_000, netTotal: 0, status: "returned" },
      ],
    });

    expect(trend).toEqual([
      { date: "2026-11-19", revenue: 40_000, transactions: 2 },
      { date: "2026-11-20", revenue: 0, transactions: 0 },
      { date: "2026-11-21", revenue: 35_000, transactions: 1 },
    ]);
  });

  it("returns an empty array for invalid date bounds", () => {
    expect(buildDailyRevenueTrend({ sales: [], from: "2026-11-22", to: "2026-11-20" })).toEqual([]);
  });
});

