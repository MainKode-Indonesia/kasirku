import "dotenv/config";
import { input, password } from "@inquirer/prompts";
import { MongoClient } from "mongodb";
import { hashPassword } from "./passwords.js";

if (!process.env.MONGODB_URI) {
  process.env.MONGODB_URI = "mongodb://127.0.0.1:27017/kasirku";
}

const client = new MongoClient(process.env.MONGODB_URI);

try {
  await client.connect();
  const db = client.db();
  const users = db.collection("users");
  const stores = db.collection("stores");

  const existingOwner = await users.findOne({ role: "owner" });
  if (existingOwner) {
    const primaryStore = await stores.findOne({ _id: existingOwner.storeId, isPrimary: true });
    if (!primaryStore) throw new Error("Toko utama untuk akun pemilik tidak ditemukan.");
    await Promise.all([
      db.collection("products").updateMany(
        { storeId: { $exists: false } },
        { $set: { storeId: primaryStore._id } },
      ),
      db.collection("sales").updateMany(
        { storeId: { $exists: false } },
        { $set: { storeId: primaryStore._id } },
      ),
    ]);
    console.log("Akun pemilik utama sudah ada; data lama sudah dipindahkan ke toko utama.");
  } else {
    const storeName = await input({
      message: "Nama toko utama:",
      default: "Toko Berkah 1",
      validate: (value) => value.trim().length > 0 || "Nama toko wajib diisi.",
    });
    const email = (await input({
      message: "Email pemilik:",
      validate: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) || "Masukkan email yang valid.",
    })).trim().toLowerCase();
    const ownerPassword = await password({
      message: "Password pemilik (minimal 12 karakter):",
      validate: (value) => value.length >= 12 || "Password minimal 12 karakter.",
    });
    const confirmation = await password({ message: "Ulangi password:" });
    if (ownerPassword !== confirmation) throw new Error("Konfirmasi password tidak cocok.");

    const store = {
      name: storeName.trim(),
      isPrimary: true,
      createdAt: new Date(),
    };
    const { insertedId: storeId } = await stores.insertOne(store);
    try {
      await users.insertOne({
        email,
        passwordHash: await hashPassword(ownerPassword),
        role: "owner",
        storeId,
        active: true,
        createdAt: new Date(),
      });
    } catch (error) {
      await stores.deleteOne({ _id: storeId });
      throw error;
    }

    await Promise.all([
      db.collection("products").updateMany({ storeId: { $exists: false } }, { $set: { storeId } }),
      db.collection("sales").updateMany({ storeId: { $exists: false } }, { $set: { storeId } }),
    ]);
    console.log(`Toko utama "${store.name}" dan akun pemilik berhasil dibuat.`);
    console.log("Produk dan transaksi lama sudah dipindahkan ke toko utama.");
  }
} catch (error) {
  console.error("Gagal membuat akun pemilik:", error.message);
  process.exitCode = 1;
} finally {
  await client.close();
}
