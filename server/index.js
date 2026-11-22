import "dotenv/config";
import cookieParser from "cookie-parser";
import cors from "cors";
import { createHash, randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import path from "node:path";
import express from "express";
import { rateLimit } from "express-rate-limit";
import jwt from "jsonwebtoken";
import { MongoClient, ObjectId } from "mongodb";
import { hashPassword, verifyPassword } from "./passwords.js";
import { createMockDatabase } from "./mock-db.js";
import {
  allocateRefund,
  ean13CheckDigit,
  validateSalePayment,
} from "./domain.js";

const app = express();
const mongoUri = process.env.MONGODB_URI ?? "mongodb://127.0.0.1:27017/kasirku";
const mongoClient = new MongoClient(mongoUri, {
  serverSelectionTimeoutMS: 1500,
  connectTimeoutMS: 1500,
});
const sessionCookie = "kasirku_session";
const sessionMaxAge = 8 * 60 * 60 * 1000;
function getCookieOptions(req) {
  const isHttps = Boolean(
    req?.secure
      || req?.get?.("x-forwarded-proto") === "https"
      || process.env.COOKIE_SECURE === "true",
  );
  return {
    httpOnly: true,
    secure: isHttps,
    sameSite: isHttps ? "none" : "lax",
    path: "/",
  };
}

app.set("trust proxy", 1);
app.use(cors());
app.use(express.json({ limit: "32kb" }));
app.use(cookieParser());

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Terlalu banyak percobaan masuk. Coba lagi dalam 15 menit." },
});

let usersCollection;
let storesCollection;
let productsCollection;
let salesCollection;
let countersCollection;
let scannerSessionsCollection;
let scannerScansCollection;
let stockMovementsCollection;
let shiftsCollection;

const fallbackJwtSecret = randomBytes(32).toString("hex");
let warnedMissingJwtSecret = false;

function getJwtSecret() {
  const secret = process.env.JWT_SECRET;
  if (!secret || Buffer.byteLength(secret) < 32) {
    if (!warnedMissingJwtSecret) {
      warnedMissingJwtSecret = true;
      console.warn("[AI Studio] JWT_SECRET tidak diisi/kurang dari 32 byte — menggunakan secret sementara untuk sesi proses ini.");
    }
    return fallbackJwtSecret;
  }
  return secret;
}

function hashScannerToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

function serializeUser(user, store) {
  return {
    id: user._id.toString(),
    email: user.email,
    role: user.role,
    storeId: store._id.toString(),
    storeName: store.name,
    isPrimary: Boolean(store.isPrimary),
  };
}

function serializeProduct(product) {
  return {
    id: product._id.toString(),
    storeId: product.storeId.toString(),
    name: product.name,
    category: product.category,
    price: product.price,
    stock: product.stock,
    lowStockThreshold: product.lowStockThreshold ?? 5,
    barcode: product.barcode,
    isArchived: Boolean(product.archivedAt),
  };
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function getDateRange(query) {
  const now = new Date();
  const today = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
  const from = String(query.from ?? today);
  const to = String(query.to ?? from);
  const timezoneOffset = query.timezoneOffset === undefined
    ? now.getTimezoneOffset()
    : Number(query.timezoneOffset);
  const isDate = (value) => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
    const parsed = new Date(`${value}T00:00:00.000Z`);
    return parsed.toISOString().slice(0, 10) === value;
  };
  if (!isDate(from) || !isDate(to) || !Number.isInteger(timezoneOffset) || timezoneOffset < -840 || timezoneOffset > 840) {
    throw new RangeError("Tanggal laporan atau zona waktu tidak valid.");
  }
  const firstDay = new Date(`${from}T00:00:00.000Z`);
  const lastDay = new Date(`${to}T00:00:00.000Z`);
  if (firstDay > lastDay || (lastDay - firstDay) / 86_400_000 > 365) {
    throw new RangeError("Rentang tanggal maksimal 366 hari dan tanggal awal tidak boleh melewati tanggal akhir.");
  }
  return {
    from,
    to,
    start: new Date(firstDay.getTime() - timezoneOffset * 60_000),
    end: new Date(lastDay.getTime() + 86_400_000 - timezoneOffset * 60_000),
    timezoneOffset,
  };
}

function serializeSale(sale) {
  return {
    id: sale._id.toString(),
    storeId: sale.storeId.toString(),
    total: sale.total,
    paid: sale.paid,
    cashTendered: sale.cashTendered ?? sale.paid,
    cashAmount: sale.cashAmount ?? sale.total,
    change: sale.change,
    payments: sale.payments ?? [{ method: "cash", amount: sale.total }],
    returnedTotal: sale.returnedTotal ?? 0,
    netTotal: sale.total - (sale.returnedTotal ?? 0),
    status: sale.status ?? "completed",
    items: sale.items.map((item) => ({
      productId: item.productId.toString(),
      productName: item.productName,
      quantity: item.quantity,
      returnedQuantity: item.returnedQuantity ?? 0,
      unitPrice: item.unitPrice,
    })),
    returns: (sale.returns ?? []).map((entry) => ({
      id: entry._id.toString(),
      amount: entry.amount,
      cashAmount: entry.cashAmount ?? entry.amount,
      payments: entry.payments ?? [{ method: "cash", amount: entry.amount }],
      reason: entry.reason,
      createdAt: entry.createdAt,
      items: entry.items.map((item) => ({
        productId: item.productId.toString(),
        productName: item.productName,
        quantity: item.quantity,
        unitPrice: item.unitPrice,
      })),
    })),
    createdAt: sale.createdAt,
  };
}

async function getShiftTotals(storeId, shiftId) {
  const [sales, returns] = await Promise.all([
    salesCollection.aggregate([
      { $match: { storeId, shiftId } },
      {
        $group: {
          _id: null,
          revenue: { $sum: "$total" },
          cash_revenue: { $sum: { $ifNull: ["$cashAmount", "$total"] } },
          transactions: { $sum: 1 },
        },
      },
    ]).next(),
    salesCollection.aggregate([
      { $match: { storeId, "returns.shiftId": shiftId } },
      { $unwind: "$returns" },
      { $match: { "returns.shiftId": shiftId } },
      {
        $group: {
          _id: null,
          returned_total: { $sum: "$returns.amount" },
          cash_returned_total: { $sum: { $ifNull: ["$returns.cashAmount", "$returns.amount"] } },
          return_transactions: { $sum: 1 },
        },
      },
    ]).next(),
  ]);
  return {
    revenue: sales?.revenue ?? 0,
    cash_revenue: sales?.cash_revenue ?? 0,
    returned_total: returns?.returned_total ?? 0,
    cash_returned_total: returns?.cash_returned_total ?? 0,
    net_revenue: (sales?.revenue ?? 0) - (returns?.returned_total ?? 0),
    cash_net: (sales?.cash_revenue ?? 0) - (returns?.cash_returned_total ?? 0),
    transactions: sales?.transactions ?? 0,
    return_transactions: returns?.return_transactions ?? 0,
  };
}

function serializeShift(shift, totals) {
  const expectedCash = shift.openingCash + totals.cash_net;
  return {
    id: shift._id.toString(),
    storeId: shift.storeId.toString(),
    status: shift.status,
    openingCash: shift.openingCash,
    openedAt: shift.openedAt,
    closedAt: shift.closedAt ?? null,
    closingCash: shift.closingCash ?? null,
    expectedCash,
    difference: shift.difference ?? null,
    ...totals,
  };
}

async function reserveOpenShift(storeId) {
  return shiftsCollection.findOneAndUpdate(
    { storeId, status: "open" },
    { $inc: { activeOperations: 1 } },
    { returnDocument: "after" },
  );
}

async function releaseShiftReservation(shift) {
  if (!shift) return;
  const result = await shiftsCollection.updateOne(
    { _id: shift._id, status: "open", activeOperations: { $gt: 0 } },
    { $inc: { activeOperations: -1 } },
  );
  if (result.matchedCount !== 1) {
    throw new Error("Sesi shift tidak dapat dilepaskan dengan aman.");
  }
}

async function createInternalBarcode(counters) {
  const counter = await counters.findOneAndUpdate(
    { _id: "internal_barcode_seq" },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: "after" },
  );
  const body = `20${String(counter.value).padStart(10, "0")}`;
  if (body.length !== 12) throw new Error("Nomor barcode internal sudah mencapai batas.");
  return body + ean13CheckDigit(body);
}

async function requireAuth(req, res, next) {
  const token = req.cookies[sessionCookie];
  if (!token) return res.status(401).json({ error: "Silakan masuk terlebih dahulu." });
  let claims;
  try {
    claims = jwt.verify(token, getJwtSecret());
  } catch {
    res.clearCookie(sessionCookie, getCookieOptions(req));
    return res.status(401).json({ error: "Sesi telah berakhir. Silakan masuk kembali." });
  }
  if (typeof claims !== "object" || typeof claims.sub !== "string" || !ObjectId.isValid(claims.sub)) {
    res.clearCookie(sessionCookie, getCookieOptions(req));
    return res.status(401).json({ error: "Sesi masuk tidak valid. Silakan masuk kembali." });
  }

  try {
    const user = await usersCollection.findOne({
      _id: new ObjectId(claims.sub),
      active: true,
    });
    if (!user || (user.sessionVersion ?? 0) !== claims.sessionVersion) {
      return res.status(401).json({ error: "Sesi telah berakhir. Silakan masuk kembali." });
    }
    req.user = user;
    next();
  } catch (error) {
    console.error("Gagal memeriksa sesi login:", error);
    res.status(500).json({ error: "Sesi login tidak dapat diperiksa." });
  }
}

async function requireStoreContext(req, res, next) {
  try {
    const requestedStoreId = req.get("X-Store-Id");
    let storeId;
    if (req.user.role === "owner") {
      const selectedStoreId = requestedStoreId || req.user.storeId.toString();
      if (!ObjectId.isValid(selectedStoreId)) {
        return res.status(400).json({ error: "Toko yang dipilih tidak valid." });
      }
      storeId = new ObjectId(selectedStoreId);
    } else {
      storeId = req.user.storeId;
      if (requestedStoreId && requestedStoreId !== storeId.toString()) {
        return res.status(403).json({ error: "Akun ini hanya dapat mengakses toko sendiri." });
      }
    }

    const store = await storesCollection.findOne({ _id: storeId, active: { $ne: false } });
    if (!store) return res.status(404).json({ error: "Toko tidak ditemukan atau sudah dinonaktifkan." });
    req.store = store;
    req.storeId = store._id;
    next();
  } catch (error) {
    console.error("Gagal memeriksa akses toko:", error);
    res.status(500).json({ error: "Akses toko tidak dapat diperiksa." });
  }
}

async function getActiveScannerSession(req) {
  const { sessionId } = req.params;
  const token = req.get("X-Scanner-Token") ?? "";
  if (!ObjectId.isValid(sessionId) || !/^[a-f\d]{64}$/i.test(token)) return null;
  return scannerSessionsCollection.findOne({
    _id: new ObjectId(sessionId),
    tokenHash: hashScannerToken(token),
    expiresAt: { $gt: new Date() },
  });
}

async function restoreStock(reserved) {
  const results = await Promise.all(
    reserved.map(({ _id, storeId, quantity }) =>
      productsCollection.updateOne({ _id, storeId }, { $inc: { stock: quantity } }),
    ),
  );
  if (results.some((result) => result.matchedCount !== 1)) {
    throw new Error("Sebagian stok tidak berhasil dikembalikan.");
  }
}

app.post("/api/auth/login", loginLimiter, async (req, res) => {
  try {
    const email = String(req.body?.email ?? "").trim().toLowerCase();
    const password = String(req.body?.password ?? "");
    if (!email || !password) {
      return res.status(400).json({ error: "Masukkan email dan password." });
    }

    const user = await usersCollection.findOne({ email, active: true });
    if (!user || !(await verifyPassword(password, user.passwordHash))) {
      return res.status(401).json({ error: "Email atau password salah." });
    }
    const store = await storesCollection.findOne({ _id: user.storeId, active: { $ne: false } });
    if (!store) return res.status(403).json({ error: "Toko akun ini tidak aktif." });

    const token = jwt.sign(
      { sessionVersion: user.sessionVersion ?? 0 },
      getJwtSecret(),
      { subject: user._id.toString(), expiresIn: "8h" },
    );
    res.cookie(sessionCookie, token, { ...getCookieOptions(req), maxAge: sessionMaxAge });
    res.json({ user: serializeUser(user, store) });
  } catch (error) {
    console.error("Gagal masuk:", error);
    res.status(500).json({ error: "Login tidak dapat diproses." });
  }
});

app.post("/api/auth/logout", async (req, res) => {
  try {
    const token = req.cookies[sessionCookie];
    if (token) {
      try {
        const claims = jwt.verify(token, getJwtSecret());
        if (typeof claims === "object" && typeof claims.sub === "string" && ObjectId.isValid(claims.sub)) {
          await usersCollection.updateOne(
            { _id: new ObjectId(claims.sub) },
            { $inc: { sessionVersion: 1 } },
          );
        }
      } catch {
        // Token tidak valid/expired tetap harus dihapus dari browser.
      }
    }
    res.clearCookie(sessionCookie, getCookieOptions(req));
    res.status(204).end();
  } catch (error) {
    console.error("Gagal keluar:", error);
    res.status(500).json({ error: "Logout tidak dapat diproses." });
  }
});

app.get("/api/auth/me", requireAuth, async (req, res) => {
  try {
    const store = await storesCollection.findOne({ _id: req.user.storeId });
    if (!store) return res.status(403).json({ error: "Toko akun ini tidak ditemukan." });
    res.json({ user: serializeUser(req.user, store) });
  } catch (error) {
    console.error("Gagal mengambil sesi pengguna:", error);
    res.status(500).json({ error: "Sesi pengguna tidak dapat dimuat." });
  }
});

app.post("/api/auth/change-password", requireAuth, async (req, res) => {
  const currentPassword = String(req.body?.currentPassword ?? "");
  const newPassword = String(req.body?.newPassword ?? "");
  if (!currentPassword || newPassword.length < 12) {
    return res.status(400).json({ error: "Masukkan password saat ini dan password baru minimal 12 karakter." });
  }
  try {
    if (!(await verifyPassword(currentPassword, req.user.passwordHash))) {
      return res.status(401).json({ error: "Password saat ini tidak cocok." });
    }
    if (await verifyPassword(newPassword, req.user.passwordHash)) {
      return res.status(400).json({ error: "Password baru harus berbeda dari password saat ini." });
    }
    const updated = await usersCollection.updateOne(
      {
        _id: req.user._id,
        $or: [
          { sessionVersion: req.user.sessionVersion ?? 0 },
          { sessionVersion: { $exists: false } },
        ],
      },
      {
        $set: { passwordHash: await hashPassword(newPassword), updatedAt: new Date() },
        $inc: { sessionVersion: 1 },
      },
    );
    if (updated.matchedCount !== 1) {
      return res.status(409).json({ error: "Akun berubah. Silakan masuk kembali." });
    }
    res.clearCookie(sessionCookie, getCookieOptions(req));
    res.status(204).end();
  } catch (error) {
    console.error("Gagal mengganti password:", error);
    res.status(500).json({ error: "Password tidak dapat diganti." });
  }
});

app.post("/api/scanner-sessions/:sessionId/scans", async (req, res) => {
  try {
    const session = await getActiveScannerSession(req);
    if (!session) {
      return res.status(410).json({ error: "Sesi pemindai sudah berakhir. Minta kode baru dari kasir." });
    }
    const barcode = String(req.body?.barcode ?? "").trim();
    if (!/^\d{8,13}$/.test(barcode)) {
      return res.status(400).json({ error: "Barcode harus berisi 8–13 angka." });
    }
    const scan = {
      sessionId: session._id,
      barcode,
      createdAt: new Date(),
      expiresAt: session.expiresAt,
    };
    const result = await scannerScansCollection.insertOne(scan);
    res.status(201).json({ id: result.insertedId.toString(), barcode });
  } catch (error) {
    console.error("Gagal menerima hasil pemindaian:", error);
    res.status(500).json({ error: "Barcode tidak dapat dikirim ke kasir." });
  }
});

app.use("/api", requireAuth);
app.use("/api", requireStoreContext);

app.get("/api/stores", async (req, res) => {
  try {
    if (req.user.role !== "owner") {
      return res.json([{
        id: req.store._id.toString(),
        name: req.store.name,
        isPrimary: Boolean(req.store.isPrimary),
      }]);
    }
    const includeInactive = req.query.includeInactive === "true";
    const stores = await storesCollection.find(
      includeInactive ? {} : { active: { $ne: false } },
    ).sort({ createdAt: 1 }).toArray();
    const branchUsers = await usersCollection.find({
      role: "store",
      storeId: { $in: stores.map((store) => store._id) },
    }, { projection: { storeId: 1, email: 1, active: 1 } }).toArray();
    const usersByStore = new Map(branchUsers.map((branchUser) => [branchUser.storeId.toString(), branchUser]));
    res.json(stores.map((store) => {
      const branchUser = usersByStore.get(store._id.toString());
      return {
        id: store._id.toString(),
        name: store.name,
        isPrimary: Boolean(store.isPrimary),
        active: store.active !== false,
        ...(branchUser ? {
          accountEmail: branchUser.email,
          accountActive: branchUser.active !== false,
        } : {}),
      };
    }));
  } catch (error) {
    console.error("Gagal mengambil daftar toko:", error);
    res.status(500).json({ error: "Daftar toko tidak dapat dimuat." });
  }
});

app.post("/api/stores/:storeId/password", async (req, res) => {
  if (req.user.role !== "owner") {
    return res.status(403).json({ error: "Hanya pemilik utama yang dapat mengatur password akun cabang." });
  }
  if (!ObjectId.isValid(req.params.storeId)) {
    return res.status(400).json({ error: "Toko cabang tidak valid." });
  }
  const password = String(req.body?.password ?? "");
  if (password.length < 12) {
    return res.status(400).json({ error: "Password baru minimal 12 karakter." });
  }
  try {
    const storeId = new ObjectId(req.params.storeId);
    const [store, branchUser] = await Promise.all([
      storesCollection.findOne({ _id: storeId, isPrimary: { $ne: true } }),
      usersCollection.findOne({ storeId, role: "store" }),
    ]);
    if (!store || !branchUser) {
      return res.status(404).json({ error: "Akun toko cabang tidak ditemukan." });
    }
    await usersCollection.updateOne(
      { _id: branchUser._id },
      {
        $set: { passwordHash: await hashPassword(password), updatedAt: new Date() },
        $inc: { sessionVersion: 1 },
      },
    );
    res.status(204).end();
  } catch (error) {
    console.error("Gagal mengatur ulang password cabang:", error);
    res.status(500).json({ error: "Password akun cabang tidak dapat diatur ulang." });
  }
});

app.patch("/api/stores/:storeId/status", async (req, res) => {
  if (req.user.role !== "owner") {
    return res.status(403).json({ error: "Hanya pemilik utama yang dapat mengubah status toko." });
  }
  if (!ObjectId.isValid(req.params.storeId) || typeof req.body?.active !== "boolean") {
    return res.status(400).json({ error: "Toko atau status akun tidak valid." });
  }
  const storeId = new ObjectId(req.params.storeId);
  try {
    const store = await storesCollection.findOne({ _id: storeId });
    if (!store || store.isPrimary) {
      return res.status(404).json({ error: "Toko cabang tidak ditemukan." });
    }
    const branchUser = await usersCollection.findOne({ storeId, role: "store" });
    if (!branchUser) return res.status(404).json({ error: "Akun admin cabang tidak ditemukan." });
    const active = req.body.active;
    if (!active && await shiftsCollection.findOne({ storeId, status: { $in: ["open", "closing"] } })) {
      return res.status(409).json({ error: "Tutup shift cabang sebelum menonaktifkan toko." });
    }
    const updatedStore = await storesCollection.updateOne(
      { _id: storeId },
      { $set: { active, updatedAt: new Date() } },
    );
    if (updatedStore.matchedCount !== 1) {
      return res.status(404).json({ error: "Toko cabang tidak ditemukan." });
    }
    try {
      const updatedUser = await usersCollection.updateOne(
        { _id: branchUser._id },
        { $set: { active, updatedAt: new Date() }, $inc: { sessionVersion: 1 } },
      );
      if (updatedUser.matchedCount !== 1) {
        throw new Error("Akun admin cabang tidak ditemukan saat memperbarui status.");
      }
    } catch (userError) {
      await storesCollection.updateOne(
        { _id: storeId },
        { $set: { active: store.active !== false } },
      );
      throw userError;
    }
    res.json({ id: storeId.toString(), active });
  } catch (error) {
    console.error("Gagal mengubah status toko:", error);
    res.status(500).json({ error: "Status toko cabang tidak dapat diubah." });
  }
});

app.post("/api/stores", async (req, res) => {
  if (req.user.role !== "owner") {
    return res.status(403).json({ error: "Hanya pemilik utama yang dapat menambahkan toko." });
  }
  const name = String(req.body?.name ?? "").trim();
  const email = String(req.body?.email ?? "").trim().toLowerCase();
  const password = String(req.body?.password ?? "");
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || password.length < 12) {
    return res.status(400).json({ error: "Isi nama toko, email valid, dan password minimal 12 karakter." });
  }

  let storeId;
  try {
    const store = {
      name,
      isPrimary: false,
      active: true,
      createdAt: new Date(),
    };
    const result = await storesCollection.insertOne(store);
    storeId = result.insertedId;
    const user = {
      email,
      passwordHash: await hashPassword(password),
      role: "store",
      storeId,
      active: true,
      sessionVersion: 0,
      createdAt: new Date(),
    };
    await usersCollection.insertOne(user);
    res.status(201).json({
      id: storeId.toString(),
      name,
      isPrimary: false,
      accountEmail: email,
    });
  } catch (error) {
    if (storeId) await storesCollection.deleteOne({ _id: storeId });
    if (error.code === 11000) {
      return res.status(409).json({ error: "Nama toko atau email tersebut sudah digunakan." });
    }
    console.error("Gagal membuat toko:", error);
    res.status(500).json({ error: "Toko tidak dapat dibuat." });
  }
});

app.get("/api/products", async (req, res) => {
  try {
    const search = String(req.query.search ?? "").trim();
    const includeArchived = req.query.includeArchived === "true";
    const filter = {
      storeId: req.storeId,
      ...(includeArchived ? {} : { archivedAt: { $exists: false } }),
      ...(search
        ? {
            $or: [
              { name: { $regex: escapeRegex(search), $options: "i" } },
              { barcode: { $regex: escapeRegex(search) } },
            ],
          }
        : {}),
    };
    const products = await productsCollection.find(filter).sort({ name: 1 }).toArray();
    res.json(products.map(serializeProduct));
  } catch (error) {
    console.error("Gagal mengambil produk:", error);
    res.status(500).json({ error: "Produk tidak dapat dimuat." });
  }
});

app.get("/api/products/low-stock", async (req, res) => {
  try {
    const products = await productsCollection.find({
      storeId: req.storeId,
      archivedAt: { $exists: false },
      $expr: { $lte: ["$stock", { $ifNull: ["$lowStockThreshold", 5] }] },
    }).sort({ stock: 1, name: 1 }).toArray();
    res.json(products.map(serializeProduct));
  } catch (error) {
    console.error("Gagal mengambil daftar stok menipis:", error);
    res.status(500).json({ error: "Daftar stok menipis tidak dapat dimuat." });
  }
});

app.post("/api/products", async (req, res) => {
  const body = req.body ?? {};
  const name = String(body.name ?? "").trim();
  const category = String(body.category ?? "").trim() || "Lainnya";
  const price = Number(body.price);
  const stock = Number(body.stock);
  const lowStockThreshold = body.lowStockThreshold === undefined ? 5 : Number(body.lowStockThreshold);
  let barcode = String(body.barcode ?? "").trim();
  if (
    !name ||
    !Number.isFinite(price) ||
    price < 0 ||
    !Number.isInteger(stock) ||
    stock < 0 ||
    !Number.isSafeInteger(lowStockThreshold) ||
    lowStockThreshold < 0
  ) {
    return res.status(400).json({ error: "Nama, harga, stok, atau batas stok minimum tidak valid." });
  }
  if (barcode && !/^\d{8,13}$/.test(barcode)) {
    return res.status(400).json({ error: "Barcode harus berisi 8–13 angka." });
  }

  try {
    if (!barcode) barcode = await createInternalBarcode(countersCollection);
    const product = {
      storeId: req.storeId,
      name,
      category,
      price,
      stock,
      lowStockThreshold,
      barcode,
      createdAt: new Date(),
    };
    const result = await productsCollection.insertOne(product);
    if (stock > 0) {
      try {
        await stockMovementsCollection.insertOne({
          storeId: req.storeId,
          productId: result.insertedId,
          productName: name,
          type: "initial",
          quantity: stock,
          stockBefore: 0,
          stockAfter: stock,
          reason: "Stok awal produk",
          createdBy: req.user._id,
          createdAt: product.createdAt,
        });
      } catch (movementError) {
        await productsCollection.deleteOne({ _id: result.insertedId, storeId: req.storeId });
        throw movementError;
      }
    }
    res.status(201).json(serializeProduct({ ...product, _id: result.insertedId }));
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: "Barcode tersebut sudah digunakan di toko ini." });
    }
    console.error("Gagal menyimpan produk:", error);
    res.status(500).json({ error: "Produk tidak dapat disimpan." });
  }
});

app.put("/api/products/:productId", async (req, res) => {
  const { productId } = req.params;
  if (!ObjectId.isValid(productId)) return res.status(400).json({ error: "Produk tidak valid." });
  const body = req.body ?? {};
  const name = String(body.name ?? "").trim();
  const category = String(body.category ?? "").trim() || "Lainnya";
  const price = Number(body.price);
  const barcode = String(body.barcode ?? "").trim();
  const lowStockThreshold = body.lowStockThreshold === undefined ? undefined : Number(body.lowStockThreshold);
  if ("stock" in body) {
    return res.status(400).json({ error: "Perubahan stok harus dicatat melalui menu pergerakan stok." });
  }
  if (
    !name ||
    !Number.isFinite(price) ||
    price < 0 ||
    (lowStockThreshold !== undefined && (!Number.isSafeInteger(lowStockThreshold) || lowStockThreshold < 0))
  ) {
    return res.status(400).json({ error: "Nama, harga, atau batas stok minimum tidak valid." });
  }
  if (!/^\d{8,13}$/.test(barcode)) {
    return res.status(400).json({ error: "Barcode harus berisi 8–13 angka." });
  }
  try {
    const result = await productsCollection.findOneAndUpdate(
      { _id: new ObjectId(productId), storeId: req.storeId, archivedAt: { $exists: false } },
      {
        $set: {
          name,
          category,
          price,
          barcode,
          ...(lowStockThreshold === undefined ? {} : { lowStockThreshold }),
          updatedAt: new Date(),
        },
      },
      { returnDocument: "after" },
    );
    if (!result) return res.status(404).json({ error: "Produk tidak ditemukan." });
    res.json(serializeProduct(result));
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: "Barcode tersebut sudah digunakan di toko ini." });
    }
    console.error("Gagal memperbarui produk:", error);
    res.status(500).json({ error: "Produk tidak dapat diperbarui." });
  }
});

app.delete("/api/products/:productId", async (req, res) => {
  const { productId } = req.params;
  if (!ObjectId.isValid(productId)) return res.status(400).json({ error: "Produk tidak valid." });
  try {
    const result = await productsCollection.updateOne(
      { _id: new ObjectId(productId), storeId: req.storeId, archivedAt: { $exists: false } },
      { $set: { archivedAt: new Date() } },
    );
    if (result.matchedCount !== 1) return res.status(404).json({ error: "Produk tidak ditemukan." });
    res.status(204).end();
  } catch (error) {
    console.error("Gagal mengarsipkan produk:", error);
    res.status(500).json({ error: "Produk tidak dapat diarsipkan." });
  }
});

app.patch("/api/products/:productId/restore", async (req, res) => {
  const { productId } = req.params;
  if (!ObjectId.isValid(productId)) return res.status(400).json({ error: "Produk tidak valid." });
  try {
    const result = await productsCollection.findOneAndUpdate(
      { _id: new ObjectId(productId), storeId: req.storeId, archivedAt: { $exists: true } },
      { $unset: { archivedAt: "" } },
      { returnDocument: "after" },
    );
    if (!result) return res.status(404).json({ error: "Produk arsip tidak ditemukan." });
    res.json(serializeProduct(result));
  } catch (error) {
    console.error("Gagal memulihkan produk:", error);
    res.status(500).json({ error: "Produk tidak dapat dipulihkan." });
  }
});

app.get("/api/dashboard", async (req, res) => {
  try {
    const { start, end } = getDateRange(req.query);
    const storeFilter = { storeId: req.storeId };

    const [productCount, lowStockCount, dailySales, dailySalesReturns] = await Promise.all([
      productsCollection.countDocuments({ ...storeFilter, archivedAt: { $exists: false } }),
      productsCollection.countDocuments({
        ...storeFilter,
        archivedAt: { $exists: false },
        $expr: { $lte: ["$stock", { $ifNull: ["$lowStockThreshold", 5] }] },
      }),
      salesCollection.aggregate([
        { $match: { ...storeFilter, createdAt: { $gte: start, $lt: end } } },
        {
          $group: {
            _id: null,
            today_revenue: { $sum: "$total" },
            today_transactions: { $sum: 1 },
          },
        },
      ]).next(),
      salesCollection.aggregate([
        { $match: storeFilter },
        { $unwind: "$returns" },
        { $match: { "returns.createdAt": { $gte: start, $lt: end } } },
        { $group: { _id: null, returned_total: { $sum: "$returns.amount" } } },
      ]).next(),
    ]);

    res.json({
      product_count: productCount,
      low_stock_count: lowStockCount,
      today_revenue: (dailySales?.today_revenue ?? 0) - (dailySalesReturns?.returned_total ?? 0),
      today_transactions: dailySales?.today_transactions ?? 0,
    });
  } catch (error) {
    console.error("Gagal mengambil ringkasan:", error);
    res.status(error instanceof RangeError ? 400 : 500).json({
      error: error instanceof RangeError ? error.message : "Ringkasan tidak dapat dimuat.",
    });
  }
});

app.get("/api/reports", async (req, res) => {
  const reportAllStores = req.query.allStores === "true";
  if (reportAllStores && req.user.role !== "owner") {
    return res.status(403).json({ error: "Hanya pemilik utama yang dapat melihat laporan semua toko." });
  }

  try {
    const range = getDateRange(req.query);
    let selectedStoreId = req.storeId;
    if (req.user.role === "owner" && req.query.storeId) {
      if (!ObjectId.isValid(String(req.query.storeId))) {
        return res.status(400).json({ error: "Toko laporan tidak valid." });
      }
      selectedStoreId = new ObjectId(String(req.query.storeId));
      const selectedStore = await storesCollection.findOne({
        _id: selectedStoreId,
        active: { $ne: false },
      });
      if (!selectedStore) return res.status(404).json({ error: "Toko laporan tidak ditemukan." });
    }

    const storeFilter = reportAllStores ? {} : { storeId: selectedStoreId };
    const [salesSummaries, returnSummaries, paymentSummaries, refundPaymentSummaries, stores] = await Promise.all([
      salesCollection.aggregate([
        { $match: { ...storeFilter, createdAt: { $gte: range.start, $lt: range.end } } },
        {
          $group: {
            _id: "$storeId",
            revenue: { $sum: "$total" },
            transactions: { $sum: 1 },
          },
        },
      ]).toArray(),
      salesCollection.aggregate([
        { $match: storeFilter },
        { $unwind: "$returns" },
        { $match: { "returns.createdAt": { $gte: range.start, $lt: range.end } } },
        {
          $group: {
            _id: "$storeId",
            returned_total: { $sum: "$returns.amount" },
            return_transactions: { $sum: 1 },
          },
        },
      ]).toArray(),
      salesCollection.aggregate([
        { $match: { ...storeFilter, createdAt: { $gte: range.start, $lt: range.end } } },
        { $addFields: { reportPayments: { $ifNull: ["$payments", [{ method: "cash", amount: "$total" }]] } } },
        { $unwind: "$reportPayments" },
        {
          $group: {
            _id: "$reportPayments.method",
            revenue: { $sum: "$reportPayments.amount" },
          },
        },
      ]).toArray(),
      salesCollection.aggregate([
        { $match: storeFilter },
        { $unwind: "$returns" },
        { $match: { "returns.createdAt": { $gte: range.start, $lt: range.end } } },
        {
          $addFields: {
            reportRefundPayments: {
              $ifNull: ["$returns.payments", [{ method: "cash", amount: "$returns.amount" }]],
            },
          },
        },
        { $unwind: "$reportRefundPayments" },
        {
          $group: {
            _id: "$reportRefundPayments.method",
            returned_total: { $sum: "$reportRefundPayments.amount" },
          },
        },
      ]).toArray(),
      storesCollection.find({
        _id: reportAllStores ? { $exists: true } : selectedStoreId,
        active: { $ne: false },
      }).sort({ name: 1 }).toArray(),
    ]);

    const salesByStore = new Map(salesSummaries.map((entry) => [entry._id.toString(), entry]));
    const returnsByStore = new Map(returnSummaries.map((entry) => [entry._id.toString(), entry]));
    const revenueByMethod = new Map(paymentSummaries.map((entry) => [entry._id, entry.revenue]));
    const returnedByMethod = new Map(refundPaymentSummaries.map((entry) => [entry._id, entry.returned_total]));
    const paymentMethods = [...new Set([...revenueByMethod.keys(), ...returnedByMethod.keys()])].sort();
    const paymentBreakdown = paymentMethods.map((method) => {
      const methodRevenue = revenueByMethod.get(method) ?? 0;
      const methodReturns = returnedByMethod.get(method) ?? 0;
      return {
        method,
        revenue: methodRevenue,
        returned_total: methodReturns,
        net_revenue: methodRevenue - methodReturns,
      };
    });
    const storeSummaries = stores.map((store) => {
      const storeId = store._id.toString();
      const revenue = salesByStore.get(storeId)?.revenue ?? 0;
      const returnedTotal = returnsByStore.get(storeId)?.returned_total ?? 0;
      return {
        storeId,
        storeName: store.name,
        revenue,
        returned_total: returnedTotal,
        net_revenue: revenue - returnedTotal,
        transactions: salesByStore.get(storeId)?.transactions ?? 0,
        return_transactions: returnsByStore.get(storeId)?.return_transactions ?? 0,
      };
    });
    const revenue = storeSummaries.reduce((sum, store) => sum + store.revenue, 0);
    const returnedTotal = storeSummaries.reduce((sum, store) => sum + store.returned_total, 0);
    res.json({
      from: range.from,
      to: range.to,
      revenue,
      returned_total: returnedTotal,
      net_revenue: revenue - returnedTotal,
      transactions: storeSummaries.reduce((sum, store) => sum + store.transactions, 0),
      return_transactions: storeSummaries.reduce((sum, store) => sum + store.return_transactions, 0),
      payment_methods: paymentBreakdown,
      stores: storeSummaries,
    });
  } catch (error) {
    console.error("Gagal mengambil laporan:", error);
    res.status(error instanceof RangeError ? 400 : 500).json({
      error: error instanceof RangeError ? error.message : "Laporan tidak dapat dimuat.",
    });
  }
});

app.get("/api/sales", async (req, res) => {
  try {
    const range = getDateRange(req.query);
    const search = String(req.query.search ?? "").trim();
    const filter = {
      storeId: req.storeId,
      createdAt: { $gte: range.start, $lt: range.end },
    };
    if (search) {
      filter.$or = [
        { "items.productName": { $regex: escapeRegex(search), $options: "i" } },
        { $expr: { $regexMatch: { input: { $toString: "$_id" }, regex: { $literal: escapeRegex(search) }, options: "i" } } },
      ];
    }
    const sales = await salesCollection.find(filter).sort({ createdAt: -1 }).limit(100).toArray();
    res.json({
      from: range.from,
      to: range.to,
      limit: 100,
      sales: sales.map(serializeSale),
    });
  } catch (error) {
    console.error("Gagal mengambil riwayat transaksi:", error);
    res.status(error instanceof RangeError ? 400 : 500).json({
      error: error instanceof RangeError ? error.message : "Riwayat transaksi tidak dapat dimuat.",
    });
  }
});

app.get("/api/sales/:saleId", async (req, res) => {
  if (!ObjectId.isValid(req.params.saleId)) {
    return res.status(400).json({ error: "Transaksi tidak valid." });
  }
  try {
    const sale = await salesCollection.findOne({
      _id: new ObjectId(req.params.saleId),
      storeId: req.storeId,
    });
    if (!sale) return res.status(404).json({ error: "Transaksi tidak ditemukan." });
    res.json(serializeSale(sale));
  } catch (error) {
    console.error("Gagal mengambil detail transaksi:", error);
    res.status(500).json({ error: "Detail transaksi tidak dapat dimuat." });
  }
});

app.post("/api/sales/:saleId/returns", async (req, res) => {
  if (!ObjectId.isValid(req.params.saleId)) {
    return res.status(400).json({ error: "Transaksi tidak valid." });
  }
  const reason = String(req.body?.reason ?? "").trim();
  const requestedItems = Array.isArray(req.body?.items) ? req.body.items : [];
  if (!reason || reason.length > 200 || !requestedItems.length) {
    return res.status(400).json({ error: "Isi alasan retur dan pilih jumlah barang yang dikembalikan." });
  }

  const quantities = new Map();
  for (const item of requestedItems) {
    const productId = String(item.productId ?? "");
    const quantity = Number(item.quantity);
    if (!ObjectId.isValid(productId) || !Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: "Jumlah barang retur tidak valid." });
    }
    quantities.set(productId, (quantities.get(productId) ?? 0) + quantity);
  }

  let shift;
  let updatedSale;
  const returnId = new ObjectId();
  try {
    shift = await reserveOpenShift(req.storeId);
    if (!shift) return res.status(409).json({ error: "Buka shift kasir sebelum memproses retur." });

    const saleId = new ObjectId(req.params.saleId);
    const sale = await salesCollection.findOne({ _id: saleId, storeId: req.storeId });
    if (!sale) return res.status(404).json({ error: "Transaksi tidak ditemukan." });

    const returnItems = [];
    for (const [productId, quantity] of quantities) {
      const originalItem = sale.items.find((item) => item.productId.toString() === productId);
      if (!originalItem || (originalItem.returnedQuantity ?? 0) + quantity > originalItem.quantity) {
        return res.status(409).json({ error: "Jumlah retur melebihi sisa barang pada transaksi." });
      }
      returnItems.push({
        productId: originalItem.productId,
        productName: originalItem.productName,
        quantity,
        unitPrice: originalItem.unitPrice,
      });
    }
    const amount = returnItems.reduce((sum, item) => sum + item.unitPrice * item.quantity, 0);
    const refundPayments = allocateRefund(sale, amount);
    const cashAmount = refundPayments.find((payment) => payment.method === "cash")?.amount ?? 0;
    const pipelineLines = returnItems.map(({ productId, quantity }) => ({ productId, quantity }));
    const lineAvailability = pipelineLines.map((line) => ({
      $anyElementTrue: {
        $map: {
          input: "$items",
          as: "item",
          in: {
            $and: [
              { $eq: ["$$item.productId", line.productId] },
              {
                $lte: [
                  { $add: [{ $ifNull: ["$$item.returnedQuantity", 0] }, line.quantity] },
                  "$$item.quantity",
                ],
              },
            ],
          },
        },
      },
    }));
    const now = new Date();
    const receipt = {
      _id: returnId,
      items: returnItems,
      amount,
      payments: refundPayments,
      cashAmount,
      reason,
      shiftId: shift._id,
      createdAt: now,
      createdBy: req.user._id,
    };
    updatedSale = await salesCollection.findOneAndUpdate(
      { _id: saleId, storeId: req.storeId, $expr: { $and: lineAvailability } },
      [{
        $set: {
          items: {
            $map: {
              input: "$items",
              as: "item",
              in: {
                $let: {
                  vars: {
                    returnItem: {
                      $arrayElemAt: [{
                        $filter: {
                          input: { $literal: pipelineLines },
                          as: "line",
                          cond: { $eq: ["$$line.productId", "$$item.productId"] },
                        },
                      }, 0],
                    },
                  },
                  in: {
                    $mergeObjects: ["$$item", {
                      returnedQuantity: {
                        $add: [
                          { $ifNull: ["$$item.returnedQuantity", 0] },
                          { $ifNull: ["$$returnItem.quantity", 0] },
                        ],
                      },
                    }],
                  },
                },
              },
            },
          },
          returnedTotal: { $add: [{ $ifNull: ["$returnedTotal", 0] }, amount] },
          returns: { $concatArrays: [{ $ifNull: ["$returns", []] }, { $literal: [receipt] }] },
          status: {
            $cond: [
              {
                $allElementsTrue: {
                  $map: {
                    input: "$items",
                    as: "item",
                    in: {
                      $gte: [
                        {
                          $add: [
                            { $ifNull: ["$$item.returnedQuantity", 0] },
                            {
                              $ifNull: [{
                                $arrayElemAt: [{
                                  $map: {
                                    input: {
                                      $filter: {
                                        input: { $literal: pipelineLines },
                                        as: "line",
                                        cond: { $eq: ["$$line.productId", "$$item.productId"] },
                                      },
                                    },
                                    as: "line",
                                    in: "$$line.quantity",
                                  },
                                }, 0],
                              }, 0],
                            },
                          ],
                        },
                        "$$item.quantity",
                      ],
                    },
                  },
                },
              },
              "returned",
              "partially_returned",
            ],
          },
        },
      }],
      { returnDocument: "after" },
    );
    if (!updatedSale) {
      return res.status(409).json({ error: "Jumlah barang sudah berubah. Muat ulang transaksi lalu coba lagi." });
    }

    const restoredStock = [];
    try {
      for (const item of returnItems) {
        const result = await productsCollection.findOneAndUpdate(
          { _id: item.productId, storeId: req.storeId },
          { $inc: { stock: item.quantity } },
          { returnDocument: "after" },
        );
        if (!result) throw new Error(`Produk ${item.productName} tidak ditemukan saat mengembalikan stok.`);
        const restored = { productId: item.productId, quantity: item.quantity, movementId: null };
        restoredStock.push(restored);
        const movement = await stockMovementsCollection.insertOne({
          storeId: req.storeId,
          productId: item.productId,
          productName: item.productName,
          type: "return",
          quantity: item.quantity,
          stockBefore: result.stock - item.quantity,
          stockAfter: result.stock,
          reason: `Retur transaksi #${saleId.toString().slice(-6)}: ${reason}`,
          saleId,
          returnId,
          createdBy: req.user._id,
          createdAt: now,
        });
        restored.movementId = movement.insertedId;
      }
    } catch (stockError) {
      for (const restored of restoredStock) {
        await productsCollection.updateOne(
          { _id: restored.productId, storeId: req.storeId, stock: { $gte: restored.quantity } },
          { $inc: { stock: -restored.quantity } },
        );
        if (restored.movementId) {
          await stockMovementsCollection.deleteOne({ _id: restored.movementId, storeId: req.storeId });
        }
      }
      const reverseLines = pipelineLines.map(({ productId, quantity }) => ({ productId, quantity: -quantity }));
      await salesCollection.updateOne(
        { _id: saleId, storeId: req.storeId },
        [{
          $set: {
            items: {
              $map: {
                input: "$items",
                as: "item",
                in: {
                  $mergeObjects: ["$$item", {
                    returnedQuantity: {
                      $add: [
                        { $ifNull: ["$$item.returnedQuantity", 0] },
                        {
                          $ifNull: [{
                            $arrayElemAt: [{
                              $map: {
                                input: {
                                  $filter: {
                                    input: { $literal: reverseLines },
                                    as: "line",
                                    cond: { $eq: ["$$line.productId", "$$item.productId"] },
                                  },
                                },
                                as: "line",
                                in: "$$line.quantity",
                              },
                            }, 0],
                          }, 0],
                        },
                      ],
                    },
                  }],
                },
              },
            },
            returnedTotal: { $subtract: ["$returnedTotal", amount] },
            returns: {
              $filter: {
                input: "$returns",
                as: "entry",
                cond: { $ne: ["$$entry._id", returnId] },
              },
            },
            status: {
              $cond: [
                { $eq: [{ $subtract: ["$returnedTotal", amount] }, 0] },
                "completed",
                "partially_returned",
              ],
            },
          },
        }],
      );
      throw stockError;
    }

    res.status(201).json(serializeSale(updatedSale));
  } catch (error) {
    console.error("Gagal memproses retur:", error);
    res.status(500).json({ error: "Retur tidak dapat diproses." });
  } finally {
    if (shift) {
      try {
        await releaseShiftReservation(shift);
      } catch (error) {
        console.error("Gagal melepaskan shift setelah retur:", error);
      }
    }
  }
});

app.get("/api/stock-movements", async (req, res) => {
  try {
    const range = getDateRange(req.query);
    const filter = {
      storeId: req.storeId,
      createdAt: { $gte: range.start, $lt: range.end },
    };
    if (req.query.productId) {
      if (!ObjectId.isValid(String(req.query.productId))) {
        return res.status(400).json({ error: "Produk tidak valid." });
      }
      filter.productId = new ObjectId(String(req.query.productId));
    }
    const movements = await stockMovementsCollection.find(filter)
      .sort({ createdAt: -1 })
      .limit(200)
      .toArray();
    res.json(movements.map((movement) => ({
      id: movement._id.toString(),
      productId: movement.productId.toString(),
      productName: movement.productName,
      type: movement.type,
      quantity: movement.quantity,
      stockBefore: movement.stockBefore,
      stockAfter: movement.stockAfter,
      reason: movement.reason,
      createdAt: movement.createdAt,
    })));
  } catch (error) {
    console.error("Gagal mengambil pergerakan stok:", error);
    res.status(error instanceof RangeError ? 400 : 500).json({
      error: error instanceof RangeError ? error.message : "Riwayat stok tidak dapat dimuat.",
    });
  }
});

app.post("/api/stock-movements", async (req, res) => {
  const productId = String(req.body?.productId ?? "");
  const type = String(req.body?.type ?? "");
  const quantity = Number(req.body?.quantity);
  const direction = String(req.body?.direction ?? "");
  const reason = String(req.body?.reason ?? "").trim();
  if (
    !ObjectId.isValid(productId) ||
    !["in", "adjustment"].includes(type) ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    (type === "adjustment" && !["increase", "decrease"].includes(direction)) ||
    !reason ||
    reason.length > 200
  ) {
    return res.status(400).json({ error: "Jenis, jumlah, atau alasan pergerakan stok tidak valid." });
  }
  const change = type === "in" || direction === "increase" ? quantity : -quantity;
  try {
    const productObjectId = new ObjectId(productId);
    const updatedProduct = await productsCollection.findOneAndUpdate(
      {
        _id: productObjectId,
        storeId: req.storeId,
        archivedAt: { $exists: false },
        ...(change < 0 ? { stock: { $gte: -change } } : {}),
      },
      { $inc: { stock: change } },
      { returnDocument: "after" },
    );
    if (!updatedProduct) {
      return res.status(409).json({ error: "Produk tidak ditemukan atau stok tidak cukup untuk penyesuaian." });
    }
    const movement = {
      storeId: req.storeId,
      productId: productObjectId,
      productName: updatedProduct.name,
      type,
      quantity: change,
      stockBefore: updatedProduct.stock - change,
      stockAfter: updatedProduct.stock,
      reason,
      createdBy: req.user._id,
      createdAt: new Date(),
    };
    try {
      const result = await stockMovementsCollection.insertOne(movement);
      res.status(201).json({
        id: result.insertedId.toString(),
        productId,
        productName: movement.productName,
        type,
        quantity: change,
        stockBefore: movement.stockBefore,
        stockAfter: movement.stockAfter,
        reason,
        createdAt: movement.createdAt,
      });
    } catch (movementError) {
      await productsCollection.updateOne({ _id: productObjectId, storeId: req.storeId }, { $inc: { stock: -change } });
      throw movementError;
    }
  } catch (error) {
    console.error("Gagal mencatat pergerakan stok:", error);
    res.status(500).json({ error: "Pergerakan stok tidak dapat dicatat." });
  }
});

app.get("/api/shifts/current", async (req, res) => {
  try {
    const shift = await shiftsCollection.findOne({ storeId: req.storeId, status: "open" });
    if (!shift) return res.json(null);
    res.json(serializeShift(shift, await getShiftTotals(req.storeId, shift._id)));
  } catch (error) {
    console.error("Gagal mengambil shift aktif:", error);
    res.status(500).json({ error: "Shift aktif tidak dapat dimuat." });
  }
});

app.get("/api/shifts", async (req, res) => {
  try {
    const range = getDateRange(req.query);
    const shifts = await shiftsCollection.find({
      storeId: req.storeId,
      openedAt: { $gte: range.start, $lt: range.end },
    }).sort({ openedAt: -1 }).limit(100).toArray();
    const result = await Promise.all(shifts.map(async (shift) => (
      serializeShift(shift, await getShiftTotals(req.storeId, shift._id))
    )));
    res.json({ shifts: result });
  } catch (error) {
    console.error("Gagal mengambil riwayat shift:", error);
    res.status(error instanceof RangeError ? 400 : 500).json({
      error: error instanceof RangeError ? error.message : "Riwayat shift tidak dapat dimuat.",
    });
  }
});

app.post("/api/shifts", async (req, res) => {
  const openingCash = Number(req.body?.openingCash);
  if (!Number.isSafeInteger(openingCash) || openingCash < 0) {
    return res.status(400).json({ error: "Kas awal harus berupa angka bulat minimal Rp 0." });
  }
  try {
    const shift = {
      storeId: req.storeId,
      status: "open",
      openingCash,
      activeOperations: 0,
      openedAt: new Date(),
      openedBy: req.user._id,
    };
    const result = await shiftsCollection.insertOne(shift);
    shift._id = result.insertedId;
    res.status(201).json(serializeShift(shift, {
      revenue: 0,
      cash_revenue: 0,
      returned_total: 0,
      cash_returned_total: 0,
      net_revenue: 0,
      cash_net: 0,
      transactions: 0,
      return_transactions: 0,
    }));
  } catch (error) {
    if (error.code === 11000) {
      return res.status(409).json({ error: "Shift toko ini sudah dibuka." });
    }
    console.error("Gagal membuka shift:", error);
    res.status(500).json({ error: "Shift tidak dapat dibuka." });
  }
});

app.post("/api/shifts/:shiftId/close", async (req, res) => {
  if (!ObjectId.isValid(req.params.shiftId)) {
    return res.status(400).json({ error: "Shift tidak valid." });
  }
  const closingCash = Number(req.body?.closingCash);
  if (!Number.isSafeInteger(closingCash) || closingCash < 0) {
    return res.status(400).json({ error: "Kas aktual harus berupa angka bulat minimal Rp 0." });
  }
  let closingShift;
  try {
    closingShift = await shiftsCollection.findOneAndUpdate(
      {
        _id: new ObjectId(req.params.shiftId),
        storeId: req.storeId,
        status: "open",
        activeOperations: 0,
      },
      { $set: { status: "closing" } },
      { returnDocument: "after" },
    );
    if (!closingShift) {
      return res.status(409).json({ error: "Shift tidak aktif atau masih ada transaksi yang sedang diproses." });
    }
    const totals = await getShiftTotals(req.storeId, closingShift._id);
    const expectedCash = closingShift.openingCash + totals.cash_net;
    const closedAt = new Date();
    const result = await shiftsCollection.findOneAndUpdate(
      { _id: closingShift._id, storeId: req.storeId, status: "closing" },
      {
        $set: {
          status: "closed",
          closingCash,
          expectedCash,
          difference: closingCash - expectedCash,
          closedAt,
          closedBy: req.user._id,
        },
      },
      { returnDocument: "after" },
    );
    res.json(serializeShift(result, totals));
  } catch (error) {
    if (closingShift) {
      await shiftsCollection.updateOne(
        { _id: closingShift._id, status: "closing" },
        { $set: { status: "open" } },
      );
    }
    console.error("Gagal menutup shift:", error);
    res.status(500).json({ error: "Shift tidak dapat ditutup." });
  }
});

app.get("/api/backup", async (req, res) => {
  const allStores = req.query.allStores === "true";
  if (allStores && req.user.role !== "owner") {
    return res.status(403).json({ error: "Hanya pemilik utama yang dapat mengekspor semua toko." });
  }
  try {
    const stores = allStores
      ? await storesCollection.find({}).sort({ createdAt: 1 }).toArray()
      : [req.store];
    const storeIds = stores.map((store) => store._id);
    const scope = { storeId: { $in: storeIds } };
    const [products, sales, movements, shifts] = await Promise.all([
      productsCollection.find(scope).sort({ storeId: 1, name: 1 }).toArray(),
      salesCollection.find(scope).sort({ createdAt: 1 }).toArray(),
      stockMovementsCollection.find(scope).sort({ createdAt: 1 }).toArray(),
      shiftsCollection.find(scope).sort({ openedAt: 1 }).toArray(),
    ]);
    const backup = {
      format: "kasirku-backup",
      version: 1,
      generatedAt: new Date().toISOString(),
      stores: stores.map((store) => ({
        id: store._id.toString(),
        name: store.name,
        isPrimary: Boolean(store.isPrimary),
        active: store.active !== false,
        createdAt: store.createdAt ?? null,
      })),
      products: products.map((product) => ({
        ...serializeProduct(product),
        createdAt: product.createdAt ?? null,
        updatedAt: product.updatedAt ?? null,
        archivedAt: product.archivedAt ?? null,
      })),
      sales: sales.map(serializeSale),
      stockMovements: movements.map((movement) => ({
        id: movement._id.toString(),
        storeId: movement.storeId.toString(),
        productId: movement.productId.toString(),
        productName: movement.productName,
        type: movement.type,
        quantity: movement.quantity,
        stockBefore: movement.stockBefore,
        stockAfter: movement.stockAfter,
        reason: movement.reason,
        saleId: movement.saleId?.toString() ?? null,
        returnId: movement.returnId?.toString() ?? null,
        createdAt: movement.createdAt,
      })),
      shifts: await Promise.all(shifts.map(async (shift) => (
        serializeShift(shift, await getShiftTotals(shift.storeId, shift._id))
      ))),
      omitted: ["user credentials and password hashes", "authentication sessions", "temporary scanner sessions"],
    };
    const date = new Date().toISOString().slice(0, 10);
    const filename = `kasirku-backup-${allStores ? "semua-toko" : "toko"}-${date}.json`;
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Disposition", `attachment; filename="${filename}"`);
    res.type("application/json").send(JSON.stringify(backup, null, 2));
  } catch (error) {
    console.error("Gagal mengekspor cadangan:", error);
    res.status(500).json({ error: "Cadangan data tidak dapat diekspor." });
  }
});

app.post("/api/scanner-sessions", async (req, res) => {
  try {
    const token = randomBytes(32).toString("hex");
    const session = {
      _id: new ObjectId(),
      storeId: req.storeId,
      tokenHash: hashScannerToken(token),
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 30 * 60 * 1000),
    };
    await scannerSessionsCollection.insertOne(session);
    res.status(201).json({
      id: session._id.toString(),
      token,
      expiresAt: session.expiresAt,
    });
  } catch (error) {
    console.error("Gagal membuat sesi pemindai:", error);
    res.status(500).json({ error: "Sesi pemindai tidak dapat dibuat." });
  }
});

app.get("/api/scanner-sessions/:sessionId/scans", async (req, res) => {
  try {
    const session = await getActiveScannerSession(req);
    if (!session) return res.status(410).json({ error: "Sesi pemindai sudah berakhir. Hubungkan HP kembali." });
    if (session.storeId.toString() !== req.storeId.toString()) {
      return res.status(403).json({ error: "Sesi pemindai berasal dari toko lain." });
    }
    const after = String(req.query.after ?? "000000000000000000000000");
    if (!/^[a-f\d]{24}$/i.test(after)) {
      return res.status(400).json({ error: "Posisi pemindaian tidak valid." });
    }
    const scans = await scannerScansCollection
      .find({ sessionId: session._id, _id: { $gt: new ObjectId(after) } })
      .sort({ _id: 1 })
      .limit(50)
      .toArray();
    res.json(scans.map((scan) => ({
      id: scan._id.toString(),
      barcode: scan.barcode,
      createdAt: scan.createdAt,
    })));
  } catch (error) {
    console.error("Gagal mengambil hasil pemindaian:", error);
    res.status(500).json({ error: "Hasil pemindaian tidak dapat dimuat." });
  }
});

app.delete("/api/scanner-sessions/:sessionId", async (req, res) => {
  try {
    const session = await getActiveScannerSession(req);
    if (!session) return res.status(410).json({ error: "Sesi pemindai sudah berakhir." });
    if (session.storeId.toString() !== req.storeId.toString()) {
      return res.status(403).json({ error: "Sesi pemindai berasal dari toko lain." });
    }
    await Promise.all([
      scannerSessionsCollection.deleteOne({ _id: session._id }),
      scannerScansCollection.deleteMany({ sessionId: session._id }),
    ]);
    res.status(204).end();
  } catch (error) {
    console.error("Gagal mengakhiri sesi pemindai:", error);
    res.status(500).json({ error: "Sesi pemindai tidak dapat diakhiri." });
  }
});

app.post("/api/sales", async (req, res) => {
  const items = Array.isArray(req.body?.items) ? req.body.items : [];
  const requestedPayments = req.body?.payments;
  const hasPaymentBreakdown = Array.isArray(requestedPayments);
  const cashTendered = Number(
    req.body?.cashTendered ?? (hasPaymentBreakdown ? 0 : req.body?.paid),
  );
  if (!items.length || !Number.isFinite(cashTendered) || cashTendered < 0) {
    return res.status(400).json({ error: "Data transaksi tidak valid." });
  }
  const quantities = new Map();
  for (const item of items) {
    const id = String(item.productId ?? "");
    const quantity = Number(item.quantity);
    if (!ObjectId.isValid(id) || !Number.isInteger(quantity) || quantity < 1) {
      return res.status(400).json({ error: "Jumlah produk dalam transaksi tidak valid." });
    }
    quantities.set(id, (quantities.get(id) ?? 0) + quantity);
  }

  const reserved = [];
  const movementIds = [];
  let insertedSaleId;
  let shift;
  try {
    shift = await reserveOpenShift(req.storeId);
    if (!shift) return res.status(409).json({ error: "Buka shift kasir sebelum menyimpan transaksi." });

    const ids = [...quantities.keys()].map((id) => new ObjectId(id));
    const products = await productsCollection.find({
      _id: { $in: ids },
      storeId: req.storeId,
      archivedAt: { $exists: false },
    }).toArray();
    if (products.length !== ids.length) {
      return res.status(400).json({ error: "Ada produk yang tidak ditemukan di toko ini." });
    }
    for (const product of products) {
      if (product.stock < quantities.get(product._id.toString())) {
        return res.status(409).json({ error: `Stok ${product.name} tidak mencukupi.` });
      }
    }
    const total = products.reduce(
      (sum, product) => sum + product.price * quantities.get(product._id.toString()),
      0,
    );
    let paymentValidation;
    try {
      paymentValidation = validateSalePayment({
        total,
        cashTendered,
        payments: hasPaymentBreakdown
          ? requestedPayments
          : [{ method: "cash", amount: total }],
      });
    } catch (paymentError) {
      await releaseShiftReservation(shift);
      shift = null;
      return res.status(400).json({ error: paymentError.message });
    }
    const { payments, cashAmount, change } = paymentValidation;
    const paymentTotal = payments.reduce((sum, payment) => sum + payment.amount, 0);
    for (const product of products) {
      const quantity = quantities.get(product._id.toString());
      const updatedProduct = await productsCollection.findOneAndUpdate(
        { _id: product._id, storeId: req.storeId, stock: { $gte: quantity } },
        { $inc: { stock: -quantity } },
        { returnDocument: "after" },
      );
      if (!updatedProduct) {
        await restoreStock(reserved);
        reserved.length = 0;
        return res.status(409).json({ error: `Stok ${product.name} tidak mencukupi.` });
      }
      reserved.push({
        _id: product._id,
        storeId: req.storeId,
        quantity,
        stockBefore: updatedProduct.stock + quantity,
        stockAfter: updatedProduct.stock,
      });
    }

    const sale = {
      storeId: req.storeId,
      shiftId: shift._id,
      total,
      paid: paymentTotal + change,
      cashTendered,
      cashAmount,
      change,
      payments,
      items: products.map((product) => ({
        productId: product._id,
        productName: product.name,
        quantity: quantities.get(product._id.toString()),
        unitPrice: product.price,
      })),
      createdAt: new Date(),
    };
    const result = await salesCollection.insertOne(sale);
    insertedSaleId = result.insertedId;
    for (const product of products) {
      const quantity = quantities.get(product._id.toString());
      const movement = await stockMovementsCollection.insertOne({
        storeId: req.storeId,
        productId: product._id,
        productName: product.name,
        type: "sale",
        quantity: -quantity,
        stockBefore: reserved.find((entry) => entry._id.equals(product._id)).stockBefore,
        stockAfter: reserved.find((entry) => entry._id.equals(product._id)).stockAfter,
        reason: `Penjualan #${insertedSaleId.toString().slice(-6)}`,
        saleId: insertedSaleId,
        createdBy: req.user._id,
        createdAt: sale.createdAt,
      });
      movementIds.push(movement.insertedId);
    }
    res.status(201).json({
      id: insertedSaleId.toString(),
      total: sale.total,
      paid: sale.paid,
      cashTendered: sale.cashTendered,
      cashAmount: sale.cashAmount,
      change: sale.change,
      payments: sale.payments,
      createdAt: sale.createdAt,
    });
  } catch (error) {
    try {
      if (insertedSaleId) await salesCollection.deleteOne({ _id: insertedSaleId, storeId: req.storeId });
      if (movementIds.length) await stockMovementsCollection.deleteMany({ _id: { $in: movementIds }, storeId: req.storeId });
      if (reserved.length) await restoreStock(reserved);
    } catch (rollbackError) {
      console.error("Gagal memulihkan stok setelah transaksi gagal:", rollbackError);
    }
    console.error("Gagal menyimpan transaksi:", error);
    res.status(500).json({ error: "Transaksi tidak dapat disimpan." });
  } finally {
    if (shift) {
      try {
        await releaseShiftReservation(shift);
      } catch (error) {
        console.error("Gagal melepaskan shift setelah transaksi:", error);
      }
    }
  }
});

const distDir = path.resolve(process.cwd(), "dist");
if (existsSync(distDir)) {
  app.use(express.static(distDir));
  app.get("*", (req, res) => {
    if (req.path.startsWith("/api")) {
      return res.status(404).json({ error: "Endpoint tidak ditemukan." });
    }
    res.sendFile(path.join(distDir, "index.html"));
  });
}

const port = Number(process.env.PORT ?? 3000);
let usingMockDb = false;

try {
  getJwtSecret();
  let db;
  try {
    await mongoClient.connect();
    db = mongoClient.db();
    console.log("API KasirKu terhubung ke MongoDB.");
  } catch (mongoError) {
    usingMockDb = true;
    await mongoClient.close().catch(() => {});
    console.warn(
      `[AI Studio] MongoDB tidak terhubung (${mongoError.message}) — menggunakan database in-memory sementara.`,
    );
    db = await createMockDatabase();
  }

  usersCollection = db.collection("users");
  storesCollection = db.collection("stores");
  productsCollection = db.collection("products");
  salesCollection = db.collection("sales");
  countersCollection = db.collection("counters");
  scannerSessionsCollection = db.collection("scannerSessions");
  scannerScansCollection = db.collection("scannerScans");
  stockMovementsCollection = db.collection("stockMovements");
  shiftsCollection = db.collection("shifts");

  let productIndexes;
  try {
    productIndexes = await productsCollection.indexes();
  } catch (error) {
    if (error.code !== 26) throw error;
    productIndexes = [];
  }
  for (const index of productIndexes) {
    if (index.unique && index.key.barcode === 1 && Object.keys(index.key).length === 1) {
      await productsCollection.dropIndex(index.name);
    }
  }
  await Promise.all([
    usersCollection.createIndex({ email: 1 }, { unique: true }),
    storesCollection.createIndex({ name: 1 }, { unique: true }),
    productsCollection.createIndex({ storeId: 1, barcode: 1 }, { unique: true }),
    productsCollection.createIndex({ storeId: 1, name: 1 }),
    salesCollection.createIndex({ storeId: 1, createdAt: -1 }),
    salesCollection.createIndex({ storeId: 1, shiftId: 1 }),
    stockMovementsCollection.createIndex({ storeId: 1, createdAt: -1 }),
    stockMovementsCollection.createIndex({ storeId: 1, productId: 1, createdAt: -1 }),
    shiftsCollection.createIndex(
      { storeId: 1 },
      { unique: true, partialFilterExpression: { status: "open" } },
    ),
    scannerSessionsCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    scannerScansCollection.createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 }),
    scannerScansCollection.createIndex({ sessionId: 1, _id: 1 }),
  ]);
  app.listen(port, "0.0.0.0", () => {
    console.log(`KasirKu berjalan di http://0.0.0.0:${port}${usingMockDb ? " (mode in-memory)" : ""}`);
  });
} catch (error) {
  console.error("API gagal dimulai.", error);
  await mongoClient.close().catch(() => {});
  process.exitCode = 1;
}

process.on("SIGINT", async () => {
  await mongoClient.close().catch(() => {});
  process.exit(0);
});
