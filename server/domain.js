export function getSalePayments(sale) {
  return sale.payments ?? [{ method: "cash", amount: sale.total }];
}

export function allocateRefund(sale, amount) {
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new Error("Nilai retur tidak valid.");
  }

  const refunded = new Map();
  for (const entry of sale.returns ?? []) {
    const payments = entry.payments ?? [{ method: "cash", amount: entry.amount }];
    for (const payment of payments) {
      refunded.set(payment.method, (refunded.get(payment.method) ?? 0) + payment.amount);
    }
  }

  const remaining = getSalePayments(sale).map((payment) => ({
    method: payment.method,
    amount: Math.max(0, payment.amount - (refunded.get(payment.method) ?? 0)),
  })).filter((payment) => payment.amount > 0);

  const remainingTotal = remaining.reduce((sum, payment) => sum + payment.amount, 0);
  if (amount > remainingTotal + 0.001) {
    throw new Error("Nilai retur melebihi sisa pembayaran transaksi.");
  }
  if (Math.abs(amount - remainingTotal) < 0.001) return remaining;

  const allocations = remaining.map((payment) => {
    const exact = amount * payment.amount / remainingTotal;
    return {
      method: payment.method,
      amount: Math.floor(exact),
      fraction: exact - Math.floor(exact),
      limit: payment.amount,
    };
  });
  let remainder = Math.round(amount - allocations.reduce((sum, payment) => sum + payment.amount, 0));

  allocations.sort((left, right) => right.fraction - left.fraction);
  for (const allocation of allocations) {
    if (remainder <= 0) break;
    if (allocation.amount < allocation.limit) {
      allocation.amount += 1;
      remainder -= 1;
    }
  }
  if (remainder > 0) {
    throw new Error("Alokasi metode pembayaran untuk retur tidak valid.");
  }

  return allocations
    .filter((payment) => payment.amount > 0)
    .map(({ method, amount: paymentAmount }) => ({ method, amount: paymentAmount }));
}

export function ean13CheckDigit(firstTwelveDigits) {
  if (!/^\d{12}$/.test(firstTwelveDigits)) {
    throw new Error("EAN-13 awal harus terdiri dari 12 digit.");
  }
  const sum = [...firstTwelveDigits].reduce(
    (total, digit, index) => total + Number(digit) * (index % 2 === 0 ? 1 : 3),
    0,
  );
  return String((10 - (sum % 10)) % 10);
}

export function validateSalePayment({ total, cashTendered, payments }) {
  if (!Number.isFinite(total) || total <= 0) {
    throw new Error("Total transaksi tidak valid.");
  }
  if (!Number.isFinite(cashTendered) || cashTendered < 0) {
    throw new Error("Nominal tunai tidak valid.");
  }

  if (!Array.isArray(payments) || !payments.length) {
    throw new Error("Metode pembayaran tidak valid.");
  }
  const methods = new Set();
  let paymentTotal = 0;
  let cashAmount = 0;

  for (const payment of payments) {
    const method = payment?.method;
    const amount = Number(payment?.amount);
    if (!["cash", "qris", "transfer"].includes(method)) {
      throw new Error("Metode pembayaran tidak valid.");
    }
    if (methods.has(method) || !Number.isFinite(amount) || amount <= 0) {
      throw new Error("Metode atau nominal pembayaran tidak valid.");
    }
    methods.add(method);
    paymentTotal += amount;
    if (method === "cash") cashAmount = amount;
  }

  if (Math.abs(paymentTotal - total) > 0.001) {
    throw new Error("Jumlah pembayaran harus sama dengan total belanja.");
  }
  if (cashTendered < cashAmount || (!cashAmount && cashTendered > 0)) {
    throw new Error("Nominal tunai yang diterima tidak valid.");
  }

  return {
    payments: payments.map((payment) => ({
      method: payment.method,
      amount: Number(payment.amount),
    })),
    cashAmount,
    change: cashTendered - cashAmount,
  };
}

function toLocalDateKey(value) {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function buildDailyRevenueTrend({ sales = [], from, to }) {
  if (!from || !to || from > to) return [];

  const buckets = new Map();
  const cursor = new Date(`${from}T00:00:00`);
  const endDate = new Date(`${to}T00:00:00`);
  if (Number.isNaN(cursor.getTime()) || Number.isNaN(endDate.getTime())) return [];

  let guard = 0;
  while (cursor <= endDate && guard < 367) {
    const key = toLocalDateKey(cursor);
    buckets.set(key, { date: key, revenue: 0, transactions: 0 });
    cursor.setDate(cursor.getDate() + 1);
    guard += 1;
  }

  for (const sale of sales) {
    if (!sale || sale.status === "returned") continue;
    const key = toLocalDateKey(sale.createdAt);
    if (!key || !buckets.has(key)) continue;
    const bucket = buckets.get(key);
    const amount = Number(sale.netTotal ?? sale.total ?? 0);
    if (Number.isFinite(amount) && amount > 0) {
      bucket.revenue += amount;
    }
    bucket.transactions += 1;
  }

  return [...buckets.values()];
}

