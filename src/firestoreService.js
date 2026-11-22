import {
  collection,
  deleteDoc,
  doc,
  getDoc,
  getDocs,
  onSnapshot,
  query,
  runTransaction,
  serverTimestamp,
  setDoc,
  Timestamp,
  updateDoc,
  where,
  writeBatch,
} from "firebase/firestore";
import {
  allocateRefund,
  buildDailyRevenueTrend,
  ean13CheckDigit,
  validateSalePayment,
} from "../server/domain.js";
import { db, handleFirestoreError, OperationType } from "./firebase.js";

function toDate(value) {
  if (!value) return new Date();
  if (value instanceof Date) return value;
  if (typeof value.toDate === "function") return value.toDate();
  return new Date(value);
}

function isFirestoreError(error) {
  if (!error || typeof error !== "object") return false;
  return typeof error.code === "string" && (
    error.name === "FirebaseError" ||
    error.code.startsWith("firestore/") ||
    error.code === "permission-denied" ||
    error.code === "unavailable" ||
    error.code === "unauthenticated"
  );
}

async function sha256Hex(value) {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function randomHex(byteLength = 32) {
  const bytes = new Uint8Array(byteLength);
  crypto.getRandomValues(bytes);
  return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function defaultCriticalThreshold(lowStockThreshold) {
  const min = Number(lowStockThreshold ?? 0);
  return min > 0 ? Math.max(1, Math.floor(min / 2)) : 0;
}

function serializeProduct(docSnap) {
  const data = docSnap.data();
  const lowStockThreshold = data.lowStockThreshold ?? 5;
  return {
    id: docSnap.id,
    storeId: data.storeId,
    name: data.name,
    category: data.category,
    price: data.price,
    stock: data.stock,
    lowStockThreshold,
    criticalLowStockThreshold: data.criticalLowStockThreshold ?? defaultCriticalThreshold(lowStockThreshold),
    barcode: data.barcode,
    isArchived: Boolean(data.isArchived),
    createdAt: toDate(data.createdAt).toISOString(),
    updatedAt: toDate(data.updatedAt).toISOString(),
  };
}

function serializeSale(docSnap, returns = []) {
  const data = docSnap.data();
  return {
    id: docSnap.id,
    storeId: data.storeId,
    shiftId: data.shiftId,
    total: data.total,
    paid: data.paid,
    cashTendered: data.cashTendered ?? data.paid,
    cashAmount: data.cashAmount ?? data.total,
    change: data.change ?? 0,
    payments: data.payments ?? [{ method: "cash", amount: data.total }],
    returnedTotal: data.returnedTotal ?? 0,
    netTotal: data.netTotal ?? (data.total - (data.returnedTotal ?? 0)),
    status: data.status ?? "completed",
    items: (data.items ?? []).map((item) => ({
      productId: item.productId,
      productName: item.productName,
      quantity: item.quantity,
      returnedQuantity: item.returnedQuantity ?? 0,
      unitPrice: item.unitPrice,
    })),
    returns: returns.map((ret) => ({
      id: ret.id,
      amount: ret.amount,
      cashAmount: ret.cashAmount ?? ret.amount,
      payments: ret.payments ?? [{ method: "cash", amount: ret.amount }],
      reason: ret.reason,
      shiftId: ret.shiftId,
      createdAt: toDate(ret.createdAt).toISOString(),
      items: ret.items ?? [],
    })),
    createdAt: toDate(data.createdAt).toISOString(),
  };
}

function computeShiftTotals(openingCash, salesList, shiftId) {
  const shiftSales = salesList.filter((sale) => sale.shiftId === shiftId);
  const revenue = shiftSales.reduce((sum, sale) => sum + sale.total, 0);
  const cashRevenue = shiftSales.reduce((sum, sale) => sum + (sale.cashAmount ?? sale.total), 0);

  let returnedTotal = 0;
  let cashReturnedTotal = 0;
  let returnTransactions = 0;
  for (const sale of salesList) {
    for (const ret of sale.returns ?? []) {
      if (ret.shiftId === shiftId) {
        returnedTotal += ret.amount;
        cashReturnedTotal += ret.cashAmount ?? ret.amount;
        returnTransactions += 1;
      }
    }
  }

  const netRevenue = revenue - returnedTotal;
  const cashNet = cashRevenue - cashReturnedTotal;
  return {
    revenue,
    cash_revenue: cashRevenue,
    returned_total: returnedTotal,
    cash_returned_total: cashReturnedTotal,
    net_revenue: netRevenue,
    cash_net: cashNet,
    expectedCash: openingCash + cashNet,
    transactions: shiftSales.length,
    return_transactions: returnTransactions,
  };
}

function serializeShift(docSnap, salesList) {
  const data = docSnap.data();
  const totals = computeShiftTotals(data.openingCash, salesList, docSnap.id);
  return {
    id: docSnap.id,
    storeId: data.storeId,
    status: data.status,
    openingCash: data.openingCash,
    openedAt: toDate(data.openedAt).toISOString(),
    closedAt: data.closedAt ? toDate(data.closedAt).toISOString() : null,
    closingCash: data.closingCash ?? null,
    expectedCash: data.status === "closed" && typeof data.expectedCash === "number" ? data.expectedCash : totals.expectedCash,
    difference: data.difference ?? null,
    ...totals,
  };
}

export async function bootstrapUserSession(firebaseUser) {
  const uid = firebaseUser.uid;
  const email = String(firebaseUser.email ?? "").trim().toLowerCase();
  const displayName = String(firebaseUser.displayName ?? "").trim().slice(0, 120);

  const storesPath = "stores";
  let memberStoresSnap;
  try {
    memberStoresSnap = await getDocs(
      query(collection(db, storesPath), where("memberUids", "array-contains", uid)),
    );
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, storesPath);
  }

  let storesList = memberStoresSnap.docs.map((snap) => ({ id: snap.id, ...snap.data() }));

  if (email) {
    let invitedSnap;
    try {
      invitedSnap = await getDocs(
        query(collection(db, storesPath), where("branchEmail", "==", email)),
      );
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, storesPath);
    }
    for (const snap of invitedSnap.docs) {
      const data = snap.data();
      if (!data.memberUids?.includes(uid)) {
        try {
          await updateDoc(doc(db, storesPath, snap.id), {
            memberUids: [...(data.memberUids ?? []), uid],
            updatedAt: serverTimestamp(),
          });
          storesList.push({ id: snap.id, ...data, memberUids: [...(data.memberUids ?? []), uid] });
        } catch (error) {
          handleFirestoreError(error, OperationType.UPDATE, `${storesPath}/${snap.id}`);
        }
      }
    }
  }

  const userRef = doc(db, "users", uid);
  let userSnap;
  try {
    userSnap = await getDoc(userRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, `users/${uid}`);
  }

  if (storesList.length === 0) {
    const storeRef = doc(collection(db, "stores"));
    const storeId = storeRef.id;
    const starterProducts = [
      { name: "Kopi Susu Gula Aren", category: "Minuman", price: 18000, stock: 35, lowStockThreshold: 5, criticalLowStockThreshold: 2, barcode: "2000000000015" },
      { name: "Roti Bakar Cokelat", category: "Makanan", price: 15000, stock: 24, lowStockThreshold: 5, criticalLowStockThreshold: 2, barcode: "2000000000022" },
      { name: "Air Mineral 600ml", category: "Minuman", price: 5000, stock: 60, lowStockThreshold: 10, criticalLowStockThreshold: 5, barcode: "2000000000039" },
      { name: "Keripik Kentang Original", category: "Snack", price: 12000, stock: 4, lowStockThreshold: 5, criticalLowStockThreshold: 2, barcode: "2000000000046" },
      { name: "Teh Hijau Botol", category: "Minuman", price: 8000, stock: 40, lowStockThreshold: 8, criticalLowStockThreshold: 4, barcode: "2000000000053" },
    ];

    try {
      const storeBatch = writeBatch(db);
      storeBatch.set(storeRef, {
        ownerUid: uid,
        memberUids: [uid],
        name: "Toko Berkah 1",
        isPrimary: true,
        active: true,
        branchEmail: "",
        barcodeSeq: starterProducts.length,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
      if (!userSnap.exists()) {
        storeBatch.set(userRef, {
          uid,
          email: email || `${uid}@users.local`,
          displayName,
          role: "owner",
          primaryStoreId: storeId,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
      await storeBatch.commit();

      const productEntries = [];
      const productsBatch = writeBatch(db);
      for (const item of starterProducts) {
        const productRef = doc(collection(db, `stores/${storeId}/products`));
        productsBatch.set(productRef, {
          storeId,
          ownerUid: uid,
          memberUids: [uid],
          ...item,
          isArchived: false,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
        productEntries.push({ productId: productRef.id, item });
      }
      await productsBatch.commit();

      const movementsBatch = writeBatch(db);
      for (const { productId, item } of productEntries) {
        const movementRef = doc(collection(db, `stores/${storeId}/stockMovements`));
        movementsBatch.set(movementRef, {
          storeId,
          ownerUid: uid,
          memberUids: [uid],
          productId,
          productName: item.name,
          type: "initial",
          quantity: item.stock,
          stockBefore: 0,
          stockAfter: item.stock,
          reason: "Stok awal produk",
          createdByUid: uid,
          createdAt: serverTimestamp(),
        });
      }
      await movementsBatch.commit();
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, `stores/${storeId}`);
    }

    storesList = [{
      id: storeId,
      ownerUid: uid,
      memberUids: [uid],
      name: "Toko Berkah 1",
      isPrimary: true,
      active: true,
      branchEmail: "",
      barcodeSeq: starterProducts.length,
    }];
    return {
      id: uid,
      email: email || `${uid}@users.local`,
      displayName,
      role: "owner",
      storeId,
      storeName: "Toko Berkah 1",
      isPrimary: true,
    };
  }

  const ownedStore = storesList.find((s) => s.ownerUid === uid && s.isPrimary)
    ?? storesList.find((s) => s.ownerUid === uid)
    ?? storesList[0];
  const role = storesList.some((s) => s.ownerUid === uid) ? "owner" : "store";

  if (!userSnap.exists()) {
    try {
      await setDoc(userRef, {
        uid,
        email: email || `${uid}@users.local`,
        displayName,
        role,
        primaryStoreId: ownedStore.id,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, `users/${uid}`);
    }
  }

  const userData = userSnap.exists() ? userSnap.data() : null;
  return {
    id: uid,
    email: userData?.email ?? email,
    displayName: userData?.displayName ?? displayName,
    role: userData?.role ?? role,
    storeId: ownedStore.id,
    storeName: ownedStore.name,
    isPrimary: Boolean(ownedStore.isPrimary),
  };
}

export async function fetchStores({ uid, includeInactive = false }) {
  const path = "stores";
  try {
    const snap = await getDocs(
      query(collection(db, path), where("memberUids", "array-contains", uid)),
    );
    return snap.docs
      .map((d) => ({
        id: d.id,
        ownerUid: d.data().ownerUid,
        memberUids: d.data().memberUids ?? [d.data().ownerUid],
        name: d.data().name,
        isPrimary: Boolean(d.data().isPrimary),
        active: d.data().active !== false,
        accountEmail: d.data().branchEmail || "",
        accountActive: d.data().active !== false,
        createdAt: toDate(d.data().createdAt).toISOString(),
      }))
      .filter((s) => includeInactive || s.active)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function createBranchStore({ ownerUid, name, branchEmail }) {
  const cleanName = String(name ?? "").trim();
  const cleanEmail = String(branchEmail ?? "").trim().toLowerCase();
  if (!cleanName || cleanName.length > 80) {
    throw new Error("Nama toko wajib diisi (maksimal 80 karakter).");
  }
  if (cleanEmail.length > 120 || (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))) {
    throw new Error("Masukkan email admin cabang yang valid atau kosongkan.");
  }

  const path = "stores";
  try {
    const existingSnap = await getDocs(
      query(collection(db, path), where("ownerUid", "==", ownerUid)),
    );
    if (existingSnap.docs.some((d) => d.data().name.toLowerCase() === cleanName.toLowerCase())) {
      throw new Error("Nama toko tersebut sudah digunakan.");
    }
    const storeRef = doc(collection(db, path));
    await setDoc(storeRef, {
      ownerUid,
      memberUids: [ownerUid],
      name: cleanName,
      isPrimary: false,
      active: true,
      branchEmail: cleanEmail,
      barcodeSeq: 0,
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return {
      id: storeRef.id,
      name: cleanName,
      isPrimary: false,
      active: true,
      accountEmail: cleanEmail,
    };
  } catch (error) {
    if (isFirestoreError(error)) handleFirestoreError(error, OperationType.CREATE, path);
    throw error;
  }
}

export async function updateStoreDetails({ storeId, ownerUid, name, branchEmail }) {
  const cleanName = String(name ?? "").trim();
  const cleanEmail = String(branchEmail ?? "").trim().toLowerCase();
  if (!cleanName || cleanName.length > 80) {
    throw new Error("Nama toko wajib diisi (maksimal 80 karakter).");
  }
  if (cleanEmail.length > 120 || (cleanEmail && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail))) {
    throw new Error("Masukkan email admin cabang yang valid atau kosongkan.");
  }

  const storePath = `stores/${storeId}`;
  try {
    const storeRef = doc(db, "stores", storeId);
    const storeSnap = await getDoc(storeRef);
    if (!storeSnap.exists()) {
      throw new Error("Toko tidak ditemukan.");
    }
    const storeData = storeSnap.data();
    if (storeData.ownerUid !== ownerUid) {
      throw new Error("Hanya pemilik utama yang dapat mengubah data toko.");
    }

    const existingSnap = await getDocs(
      query(collection(db, "stores"), where("ownerUid", "==", ownerUid)),
    );
    if (existingSnap.docs.some((d) => d.id !== storeId && d.data().name.toLowerCase() === cleanName.toLowerCase())) {
      throw new Error("Nama toko tersebut sudah digunakan.");
    }

    const isPrimary = Boolean(storeData.isPrimary);
    const updates = isPrimary
      ? { name: cleanName, updatedAt: serverTimestamp() }
      : { name: cleanName, branchEmail: cleanEmail, updatedAt: serverTimestamp() };

    await updateDoc(storeRef, updates);
    return {
      id: storeId,
      name: cleanName,
      isPrimary,
      accountEmail: isPrimary ? "" : cleanEmail,
    };
  } catch (error) {
    if (isFirestoreError(error)) handleFirestoreError(error, OperationType.UPDATE, storePath);
    throw error;
  }
}

export async function toggleStoreActive({ storeId, uid, active }) {
  const storePath = `stores/${storeId}`;
  try {
    if (!active) {
      const openShifts = await getDocs(
        query(
          collection(db, `stores/${storeId}/shifts`),
          where("memberUids", "array-contains", uid),
          where("status", "==", "open"),
        ),
      );
      if (!openShifts.empty) {
        throw new Error("Tutup shift cabang sebelum menonaktifkan toko.");
      }
    }
    await updateDoc(doc(db, "stores", storeId), {
      active: Boolean(active),
      updatedAt: serverTimestamp(),
    });
    return { id: storeId, active: Boolean(active) };
  } catch (error) {
    if (isFirestoreError(error)) handleFirestoreError(error, OperationType.UPDATE, storePath);
    throw error;
  }
}

export async function fetchProducts({ storeId, uid, includeArchived = false }) {
  const path = `stores/${storeId}/products`;
  try {
    const snap = await getDocs(
      query(collection(db, path), where("memberUids", "array-contains", uid)),
    );
    return snap.docs
      .map(serializeProduct)
      .filter((product) => includeArchived || !product.isArchived)
      .sort((a, b) => a.name.localeCompare(b.name, "id"));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function createProduct({ storeId, uid, data }) {
  const name = String(data.name ?? "").trim();
  const category = String(data.category ?? "").trim() || "Lainnya";
  const price = Number(data.price);
  const stock = Number(data.stock);
  const lowStockThreshold = data.lowStockThreshold === undefined || data.lowStockThreshold === ""
    ? 5
    : Number(data.lowStockThreshold);
  const criticalLowStockThreshold = data.criticalLowStockThreshold === undefined || data.criticalLowStockThreshold === ""
    ? defaultCriticalThreshold(lowStockThreshold)
    : Number(data.criticalLowStockThreshold);
  const requestedBarcode = String(data.barcode ?? "").trim();

  if (
    !name ||
    name.length > 120 ||
    category.length > 60 ||
    !Number.isFinite(price) ||
    price < 0 ||
    !Number.isInteger(stock) ||
    stock < 0 ||
    !Number.isSafeInteger(lowStockThreshold) ||
    lowStockThreshold < 0
  ) {
    throw new Error("Nama, harga, stok, atau batas stok minimum tidak valid.");
  }
  if (
    !Number.isSafeInteger(criticalLowStockThreshold) ||
    criticalLowStockThreshold < 0 ||
    criticalLowStockThreshold > lowStockThreshold
  ) {
    throw new Error("Batas stok kritis harus berupa angka bulat antara 0 dan batas stok minimum.");
  }
  if (requestedBarcode && !/^\d{8,13}$/.test(requestedBarcode)) {
    throw new Error("Barcode harus berisi 8–13 angka.");
  }

  const productsPath = `stores/${storeId}/products`;
  try {
    const existingSnap = await getDocs(
      query(collection(db, productsPath), where("memberUids", "array-contains", uid)),
    );
    if (requestedBarcode && existingSnap.docs.some((d) => d.data().barcode === requestedBarcode)) {
      throw new Error("Barcode tersebut sudah digunakan di toko ini.");
    }

    let createdProduct;
    await runTransaction(db, async (tx) => {
      const storeRef = doc(db, "stores", storeId);
      const storeSnap = await tx.get(storeRef);
      if (!storeSnap.exists()) throw new Error("Toko tidak ditemukan.");
      const storeData = storeSnap.data();

      let barcode = requestedBarcode;
      if (!barcode) {
        const nextSeq = (storeData.barcodeSeq ?? 0) + 1;
        const body = `20${String(nextSeq).padStart(10, "0")}`;
        if (body.length !== 12) throw new Error("Nomor barcode internal sudah mencapai batas.");
        barcode = body + ean13CheckDigit(body);
        tx.update(storeRef, { barcodeSeq: nextSeq, updatedAt: serverTimestamp() });
      }

      const productRef = doc(collection(db, productsPath));
      const memberUids = storeData.memberUids ?? [storeData.ownerUid];
      const payload = {
        storeId,
        ownerUid: storeData.ownerUid,
        memberUids,
        name,
        category,
        price,
        stock,
        lowStockThreshold,
        criticalLowStockThreshold,
        barcode,
        isArchived: false,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      };
      tx.set(productRef, payload);

      if (stock > 0) {
        const movementRef = doc(collection(db, `stores/${storeId}/stockMovements`));
        tx.set(movementRef, {
          storeId,
          ownerUid: storeData.ownerUid,
          memberUids,
          productId: productRef.id,
          productName: name,
          type: "initial",
          quantity: stock,
          stockBefore: 0,
          stockAfter: stock,
          reason: "Stok awal produk",
          createdByUid: uid,
          createdAt: serverTimestamp(),
        });
      }

      createdProduct = {
        id: productRef.id,
        storeId,
        name,
        category,
        price,
        stock,
        lowStockThreshold,
        criticalLowStockThreshold,
        barcode,
        isArchived: false,
      };
    });

    return createdProduct;
  } catch (error) {
    if (isFirestoreError(error)) handleFirestoreError(error, OperationType.WRITE, productsPath);
    throw error;
  }
}

export async function updateProduct({ storeId, productId, uid, data }) {
  const name = String(data.name ?? "").trim();
  const category = String(data.category ?? "").trim() || "Lainnya";
  const price = Number(data.price);
  const barcode = String(data.barcode ?? "").trim();
  const lowStockThreshold = Number(data.lowStockThreshold ?? 5);
  const criticalLowStockThreshold = data.criticalLowStockThreshold === undefined || data.criticalLowStockThreshold === ""
    ? defaultCriticalThreshold(lowStockThreshold)
    : Number(data.criticalLowStockThreshold);

  if (
    !name ||
    name.length > 120 ||
    category.length > 60 ||
    !Number.isFinite(price) ||
    price < 0 ||
    !Number.isSafeInteger(lowStockThreshold) ||
    lowStockThreshold < 0
  ) {
    throw new Error("Nama, harga, atau batas stok minimum tidak valid.");
  }
  if (
    !Number.isSafeInteger(criticalLowStockThreshold) ||
    criticalLowStockThreshold < 0 ||
    criticalLowStockThreshold > lowStockThreshold
  ) {
    throw new Error("Batas stok kritis harus berupa angka bulat antara 0 dan batas stok minimum.");
  }
  if (!/^\d{8,13}$/.test(barcode)) {
    throw new Error("Barcode harus berisi 8–13 angka.");
  }

  const productPath = `stores/${storeId}/products/${productId}`;
  try {
    const existingSnap = await getDocs(
      query(collection(db, `stores/${storeId}/products`), where("memberUids", "array-contains", uid)),
    );
    if (existingSnap.docs.some((d) => d.id !== productId && d.data().barcode === barcode)) {
      throw new Error("Barcode tersebut sudah digunakan di toko ini.");
    }
    await updateDoc(doc(db, "stores", storeId, "products", productId), {
      name,
      category,
      price,
      lowStockThreshold,
      criticalLowStockThreshold,
      barcode,
      updatedAt: serverTimestamp(),
    });
    return { id: productId, name, category, price, lowStockThreshold, criticalLowStockThreshold, barcode };
  } catch (error) {
    if (isFirestoreError(error)) handleFirestoreError(error, OperationType.UPDATE, productPath);
    throw error;
  }
}

export async function setProductArchived({ storeId, productId, isArchived }) {
  const productPath = `stores/${storeId}/products/${productId}`;
  try {
    await updateDoc(doc(db, "stores", storeId, "products", productId), {
      isArchived: Boolean(isArchived),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, productPath);
  }
}

export async function fetchStockMovements({ storeId, uid, start, end, productId }) {
  const path = `stores/${storeId}/stockMovements`;
  try {
    const snap = await getDocs(
      query(collection(db, path), where("memberUids", "array-contains", uid)),
    );
    return snap.docs
      .map((d) => {
        const data = d.data();
        const createdAt = toDate(data.createdAt);
        return {
          id: d.id,
          productId: data.productId,
          productName: data.productName,
          type: data.type,
          quantity: data.quantity,
          stockBefore: data.stockBefore,
          stockAfter: data.stockAfter,
          reason: data.reason,
          createdAt: createdAt.toISOString(),
          _ts: createdAt.getTime(),
        };
      })
      .filter((m) => (!productId || m.productId === productId) && m._ts >= start.getTime() && m._ts < end.getTime())
      .sort((a, b) => b._ts - a._ts)
      .slice(0, 200);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, path);
  }
}

export async function createStockMovement({ storeId, uid, productId, type, quantity, direction, reason }) {
  const cleanReason = String(reason ?? "").trim();
  if (
    !["in", "adjustment"].includes(type) ||
    !Number.isInteger(quantity) ||
    quantity < 1 ||
    (type === "adjustment" && !["increase", "decrease"].includes(direction)) ||
    !cleanReason ||
    cleanReason.length > 200
  ) {
    throw new Error("Jenis, jumlah, atau alasan pergerakan stok tidak valid.");
  }
  const change = type === "in" || direction === "increase" ? quantity : -quantity;
  const productPath = `stores/${storeId}/products/${productId}`;

  try {
    let createdMovement;
    await runTransaction(db, async (tx) => {
      const productRef = doc(db, "stores", storeId, "products", productId);
      const productSnap = await tx.get(productRef);
      if (!productSnap.exists() || productSnap.data().isArchived) {
        throw new Error("Produk tidak ditemukan.");
      }
      const pData = productSnap.data();
      const stockBefore = pData.stock;
      const stockAfter = stockBefore + change;
      if (stockAfter < 0) {
        throw new Error("Stok tidak mencukupi untuk penyesuaian pengurangan.");
      }

      tx.update(productRef, { stock: stockAfter, updatedAt: serverTimestamp() });

      const movementRef = doc(collection(db, `stores/${storeId}/stockMovements`));
      tx.set(movementRef, {
        storeId,
        ownerUid: pData.ownerUid,
        memberUids: pData.memberUids,
        productId,
        productName: pData.name,
        type,
        quantity: change,
        stockBefore,
        stockAfter,
        reason: cleanReason,
        createdByUid: uid,
        createdAt: serverTimestamp(),
      });

      createdMovement = {
        id: movementRef.id,
        productId,
        productName: pData.name,
        type,
        quantity: change,
        stockBefore,
        stockAfter,
        reason: cleanReason,
      };
    });
    return createdMovement;
  } catch (error) {
    if (isFirestoreError(error)) handleFirestoreError(error, OperationType.WRITE, productPath);
    throw error;
  }
}

async function loadStoreSalesWithReturns(storeId, uid) {
  const salesPath = `stores/${storeId}/sales`;
  const salesSnap = await getDocs(
    query(collection(db, salesPath), where("memberUids", "array-contains", uid)),
  );
  return Promise.all(
    salesSnap.docs.map(async (saleDoc) => {
      const returnsPath = `stores/${storeId}/sales/${saleDoc.id}/returns`;
      const returnsSnap = await getDocs(
        query(collection(db, returnsPath), where("memberUids", "array-contains", uid)),
      );
      const returns = returnsSnap.docs
        .map((r) => ({ id: r.id, ...r.data() }))
        .sort((a, b) => toDate(a.createdAt).getTime() - toDate(b.createdAt).getTime());
      return serializeSale(saleDoc, returns);
    }),
  );
}

export async function fetchCurrentShift({ storeId, uid }) {
  const shiftsPath = `stores/${storeId}/shifts`;
  try {
    const snap = await getDocs(
      query(
        collection(db, shiftsPath),
        where("memberUids", "array-contains", uid),
        where("status", "==", "open"),
      ),
    );
    if (snap.empty) return null;
    const salesList = await loadStoreSalesWithReturns(storeId, uid);
    return serializeShift(snap.docs[0], salesList);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, shiftsPath);
  }
}

export async function fetchShifts({ storeId, uid, start, end }) {
  const shiftsPath = `stores/${storeId}/shifts`;
  try {
    const [snap, salesList] = await Promise.all([
      getDocs(query(collection(db, shiftsPath), where("memberUids", "array-contains", uid))),
      loadStoreSalesWithReturns(storeId, uid),
    ]);
    return snap.docs
      .map((d) => serializeShift(d, salesList))
      .filter((s) => {
        const ts = new Date(s.openedAt).getTime();
        return ts >= start.getTime() && ts < end.getTime();
      })
      .sort((a, b) => new Date(b.openedAt).getTime() - new Date(a.openedAt).getTime())
      .slice(0, 100);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, shiftsPath);
  }
}

export async function openShift({ storeId, uid, openingCash }) {
  const cashInt = Number(openingCash);
  if (!Number.isSafeInteger(cashInt) || cashInt < 0) {
    throw new Error("Kas awal harus berupa angka bulat minimal Rp 0.");
  }
  const shiftsPath = `stores/${storeId}/shifts`;
  try {
    const existingOpen = await getDocs(
      query(
        collection(db, shiftsPath),
        where("memberUids", "array-contains", uid),
        where("status", "==", "open"),
      ),
    );
    if (!existingOpen.empty) {
      throw new Error("Shift toko ini sudah dibuka.");
    }
    const storeSnap = await getDoc(doc(db, "stores", storeId));
    if (!storeSnap.exists()) throw new Error("Toko tidak ditemukan.");
    const storeData = storeSnap.data();

    const shiftRef = doc(collection(db, shiftsPath));
    await setDoc(shiftRef, {
      storeId,
      ownerUid: storeData.ownerUid,
      memberUids: storeData.memberUids ?? [storeData.ownerUid],
      status: "open",
      openingCash: cashInt,
      openedByUid: uid,
      openedAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
    return { id: shiftRef.id, openingCash: cashInt };
  } catch (error) {
    if (isFirestoreError(error)) handleFirestoreError(error, OperationType.CREATE, shiftsPath);
    throw error;
  }
}

export async function closeShift({ storeId, uid, shiftId, closingCash }) {
  const cashInt = Number(closingCash);
  if (!Number.isSafeInteger(cashInt) || cashInt < 0) {
    throw new Error("Kas aktual harus berupa angka bulat minimal Rp 0.");
  }
  const shiftPath = `stores/${storeId}/shifts/${shiftId}`;
  try {
    const salesList = await loadStoreSalesWithReturns(storeId, uid);
    let closedResult;
    await runTransaction(db, async (tx) => {
      const shiftRef = doc(db, "stores", storeId, "shifts", shiftId);
      const shiftSnap = await tx.get(shiftRef);
      if (!shiftSnap.exists() || shiftSnap.data().status !== "open") {
        throw new Error("Shift tidak aktif atau sudah ditutup.");
      }
      const sData = shiftSnap.data();
      const totals = computeShiftTotals(sData.openingCash, salesList, shiftId);
      const expectedCash = totals.expectedCash;
      const difference = cashInt - expectedCash;

      tx.update(shiftRef, {
        status: "closed",
        closingCash: cashInt,
        expectedCash,
        difference,
        closedAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      closedResult = {
        id: shiftId,
        expectedCash,
        closingCash: cashInt,
        difference,
      };
    });
    return closedResult;
  } catch (error) {
    if (isFirestoreError(error)) handleFirestoreError(error, OperationType.UPDATE, shiftPath);
    throw error;
  }
}

export async function createSale({ storeId, uid, shiftId, items, payments, cashTendered }) {
  if (!Array.isArray(items) || !items.length) {
    throw new Error("Data transaksi tidak valid.");
  }
  const quantities = new Map();
  for (const item of items) {
    const id = String(item.productId ?? "");
    const qty = Number(item.quantity);
    if (!id || !Number.isInteger(qty) || qty < 1) {
      throw new Error("Jumlah produk dalam transaksi tidak valid.");
    }
    quantities.set(id, (quantities.get(id) ?? 0) + qty);
  }

  const salesPath = `stores/${storeId}/sales`;
  try {
    let createdSale;
    await runTransaction(db, async (tx) => {
      const shiftRef = doc(db, "stores", storeId, "shifts", shiftId);
      const shiftSnap = await tx.get(shiftRef);
      if (!shiftSnap.exists() || shiftSnap.data().status !== "open") {
        throw new Error("Buka shift kasir sebelum menyimpan transaksi.");
      }

      const productIds = [...quantities.keys()];
      const productRefs = productIds.map((id) => doc(db, "stores", storeId, "products", id));
      const productSnaps = await Promise.all(productRefs.map((ref) => tx.get(ref)));

      const products = [];
      for (const snap of productSnaps) {
        if (!snap.exists() || snap.data().isArchived) {
          throw new Error("Ada produk yang tidak ditemukan di toko ini.");
        }
        const pData = snap.data();
        const qty = quantities.get(snap.id);
        if (pData.stock < qty) {
          throw new Error(`Stok ${pData.name} tidak mencukupi.`);
        }
        products.push({ id: snap.id, ref: snap.ref, ...pData, qty });
      }

      const total = products.reduce((sum, p) => sum + p.price * p.qty, 0);
      const validation = validateSalePayment({
        total,
        cashTendered: Number(cashTendered ?? 0),
        payments,
      });
      const paymentTotal = validation.payments.reduce((sum, p) => sum + p.amount, 0);
      const paid = paymentTotal + validation.change;

      const saleRef = doc(collection(db, salesPath));
      const ownerUid = shiftSnap.data().ownerUid;
      const memberUids = shiftSnap.data().memberUids;

      for (const p of products) {
        tx.update(p.ref, {
          stock: p.stock - p.qty,
          updatedAt: serverTimestamp(),
        });
      }

      tx.set(saleRef, {
        storeId,
        ownerUid,
        memberUids,
        shiftId,
        cashierUid: uid,
        total,
        paid,
        cashTendered: Number(cashTendered ?? 0),
        cashAmount: validation.cashAmount,
        change: validation.change,
        payments: validation.payments,
        items: products.map((p) => ({
          productId: p.id,
          productName: p.name,
          quantity: p.qty,
          returnedQuantity: 0,
          unitPrice: p.price,
        })),
        returnedTotal: 0,
        netTotal: total,
        status: "completed",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      for (const p of products) {
        const movementRef = doc(collection(db, `stores/${storeId}/stockMovements`));
        tx.set(movementRef, {
          storeId,
          ownerUid,
          memberUids,
          productId: p.id,
          productName: p.name,
          type: "sale",
          quantity: -p.qty,
          stockBefore: p.stock,
          stockAfter: p.stock - p.qty,
          reason: `Penjualan #${saleRef.id.slice(-6).toUpperCase()}`,
          saleId: saleRef.id,
          createdByUid: uid,
          createdAt: serverTimestamp(),
        });
      }

      createdSale = {
        id: saleRef.id,
        total,
        paid,
        cashTendered: Number(cashTendered ?? 0),
        cashAmount: validation.cashAmount,
        change: validation.change,
        payments: validation.payments,
      };
    });
    return createdSale;
  } catch (error) {
    if (isFirestoreError(error)) handleFirestoreError(error, OperationType.WRITE, salesPath);
    throw error;
  }
}

export async function fetchSales({ storeId, uid, start, end, search = "" }) {
  const salesPath = `stores/${storeId}/sales`;
  try {
    const allSales = await loadStoreSalesWithReturns(storeId, uid);
    const term = search.trim().toLowerCase();
    return allSales
      .filter((sale) => {
        const ts = new Date(sale.createdAt).getTime();
        if (ts < start.getTime() || ts >= end.getTime()) return false;
        if (!term) return true;
        return (
          sale.id.toLowerCase().includes(term) ||
          sale.items.some((item) => item.productName.toLowerCase().includes(term))
        );
      })
      .sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime())
      .slice(0, 100);
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, salesPath);
  }
}

export async function submitSaleReturn({ storeId, saleId, uid, shiftId, items, reason }) {
  const cleanReason = String(reason ?? "").trim();
  if (!cleanReason || cleanReason.length > 200 || !Array.isArray(items) || !items.length) {
    throw new Error("Isi alasan retur dan pilih jumlah barang yang dikembalikan.");
  }

  const quantities = new Map();
  for (const item of items) {
    const productId = String(item.productId ?? "");
    const qty = Number(item.quantity);
    if (!productId || !Number.isInteger(qty) || qty < 1) {
      throw new Error("Jumlah barang retur tidak valid.");
    }
    quantities.set(productId, (quantities.get(productId) ?? 0) + qty);
  }

  const salePath = `stores/${storeId}/sales/${saleId}`;
  try {
    const existingReturnsSnap = await getDocs(
      query(collection(db, `${salePath}/returns`), where("memberUids", "array-contains", uid)),
    );
    const existingReturns = existingReturnsSnap.docs.map((d) => ({ id: d.id, ...d.data() }));

    await runTransaction(db, async (tx) => {
      const shiftRef = doc(db, "stores", storeId, "shifts", shiftId);
      const saleRef = doc(db, "stores", storeId, "sales", saleId);
      const [shiftSnap, saleSnap] = await Promise.all([tx.get(shiftRef), tx.get(saleRef)]);
      if (!shiftSnap.exists() || shiftSnap.data().status !== "open") {
        throw new Error("Buka shift kasir sebelum memproses retur.");
      }
      if (!saleSnap.exists()) throw new Error("Transaksi tidak ditemukan.");

      const saleData = saleSnap.data();
      const returnItems = [];
      for (const [productId, qty] of quantities) {
        const orig = (saleData.items ?? []).find((i) => i.productId === productId);
        if (!orig || (orig.returnedQuantity ?? 0) + qty > orig.quantity) {
          throw new Error("Jumlah retur melebihi sisa barang pada transaksi.");
        }
        returnItems.push({
          productId,
          productName: orig.productName,
          quantity: qty,
          unitPrice: orig.unitPrice,
        });
      }

      const productRefs = returnItems.map((i) => doc(db, "stores", storeId, "products", i.productId));
      const productSnaps = await Promise.all(productRefs.map((ref) => tx.get(ref)));

      const amount = returnItems.reduce((sum, i) => sum + i.unitPrice * i.quantity, 0);
      const refundPayments = allocateRefund({ ...saleData, returns: existingReturns }, amount);
      const cashAmount = refundPayments.find((p) => p.method === "cash")?.amount ?? 0;

      const updatedItems = (saleData.items ?? []).map((item) => {
        const retQty = quantities.get(item.productId) ?? 0;
        return {
          ...item,
          returnedQuantity: (item.returnedQuantity ?? 0) + retQty,
        };
      });
      const nextReturnedTotal = (saleData.returnedTotal ?? 0) + amount;
      const allReturned = updatedItems.every((i) => (i.returnedQuantity ?? 0) >= i.quantity);
      const nextStatus = allReturned ? "returned" : "partially_returned";

      tx.update(saleRef, {
        items: updatedItems,
        returnedTotal: nextReturnedTotal,
        netTotal: saleData.total - nextReturnedTotal,
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });

      const returnRef = doc(collection(db, `${salePath}/returns`));
      tx.set(returnRef, {
        storeId,
        saleId,
        ownerUid: saleData.ownerUid,
        memberUids: saleData.memberUids,
        shiftId,
        cashierUid: uid,
        amount,
        cashAmount,
        payments: refundPayments,
        items: returnItems,
        reason: cleanReason,
        createdAt: serverTimestamp(),
      });

      for (let i = 0; i < returnItems.length; i += 1) {
        const retItem = returnItems[i];
        const pSnap = productSnaps[i];
        if (!pSnap.exists()) {
          throw new Error(`Produk ${retItem.productName} tidak ditemukan saat mengembalikan stok.`);
        }
        const stockBefore = pSnap.data().stock;
        const stockAfter = stockBefore + retItem.quantity;
        tx.update(pSnap.ref, { stock: stockAfter, updatedAt: serverTimestamp() });

        const movementRef = doc(collection(db, `stores/${storeId}/stockMovements`));
        tx.set(movementRef, {
          storeId,
          ownerUid: saleData.ownerUid,
          memberUids: saleData.memberUids,
          productId: retItem.productId,
          productName: retItem.productName,
          type: "return",
          quantity: retItem.quantity,
          stockBefore,
          stockAfter,
          reason: `Retur transaksi #${saleId.slice(-6).toUpperCase()}: ${cleanReason}`,
          saleId,
          returnId: returnRef.id,
          createdByUid: uid,
          createdAt: serverTimestamp(),
        });
      }
    });

    const refreshedSnap = await getDoc(doc(db, "stores", storeId, "sales", saleId));
    const refreshedReturns = await getDocs(
      query(collection(db, `${salePath}/returns`), where("memberUids", "array-contains", uid)),
    );
    return serializeSale(
      refreshedSnap,
      refreshedReturns.docs.map((d) => ({ id: d.id, ...d.data() })),
    );
  } catch (error) {
    if (isFirestoreError(error)) handleFirestoreError(error, OperationType.WRITE, salePath);
    throw error;
  }
}

export async function fetchDashboard({ storeId, uid, start, end }) {
  try {
    const [products, salesList] = await Promise.all([
      fetchProducts({ storeId, uid, includeArchived: false }),
      loadStoreSalesWithReturns(storeId, uid),
    ]);

    const lowStockCount = products.filter((p) => p.stock <= p.lowStockThreshold).length;
    const rangeSales = salesList.filter((s) => {
      const ts = new Date(s.createdAt).getTime();
      return ts >= start.getTime() && ts < end.getTime();
    });
    const grossRevenue = rangeSales.reduce((sum, s) => sum + s.total, 0);

    let returnedTotal = 0;
    for (const s of salesList) {
      for (const ret of s.returns ?? []) {
        const ts = new Date(ret.createdAt).getTime();
        if (ts >= start.getTime() && ts < end.getTime()) {
          returnedTotal += ret.amount;
        }
      }
    }

    return {
      product_count: products.length,
      low_stock_count: lowStockCount,
      today_revenue: grossRevenue - returnedTotal,
      today_transactions: rangeSales.length,
    };
  } catch (error) {
    if (isFirestoreError(error)) handleFirestoreError(error, OperationType.GET, `stores/${storeId}`);
    throw error;
  }
}

export async function fetchReport({ stores, selectedStoreId, reportAllStores, uid, start, end, from, to }) {
  const targetStores = reportAllStores
    ? stores.filter((s) => s.active !== false)
    : stores.filter((s) => s.id === selectedStoreId);

  const revenueByMethod = new Map();
  const returnedByMethod = new Map();
  const storeSummaries = [];
  const allTargetSales = [];

  for (const store of targetStores) {
    const salesList = await loadStoreSalesWithReturns(store.id, uid);
    allTargetSales.push(...salesList);
    let revenue = 0;
    let transactions = 0;
    let returnedTotal = 0;
    let returnTransactions = 0;

    for (const sale of salesList) {
      const saleTs = new Date(sale.createdAt).getTime();
      if (saleTs >= start.getTime() && saleTs < end.getTime()) {
        revenue += sale.total;
        transactions += 1;
        for (const p of sale.payments ?? [{ method: "cash", amount: sale.total }]) {
          revenueByMethod.set(p.method, (revenueByMethod.get(p.method) ?? 0) + p.amount);
        }
      }
      for (const ret of sale.returns ?? []) {
        const retTs = new Date(ret.createdAt).getTime();
        if (retTs >= start.getTime() && retTs < end.getTime()) {
          returnedTotal += ret.amount;
          returnTransactions += 1;
          for (const p of ret.payments ?? [{ method: "cash", amount: ret.amount }]) {
            returnedByMethod.set(p.method, (returnedByMethod.get(p.method) ?? 0) + p.amount);
          }
        }
      }
    }

    storeSummaries.push({
      storeId: store.id,
      storeName: store.name,
      revenue,
      returned_total: returnedTotal,
      net_revenue: revenue - returnedTotal,
      transactions,
      return_transactions: returnTransactions,
    });
  }

  const methods = [...new Set([...revenueByMethod.keys(), ...returnedByMethod.keys()])].sort();
  const paymentBreakdown = methods.map((method) => {
    const rev = revenueByMethod.get(method) ?? 0;
    const ret = returnedByMethod.get(method) ?? 0;
    return { method, revenue: rev, returned_total: ret, net_revenue: rev - ret };
  });

  const revenue = storeSummaries.reduce((sum, s) => sum + s.revenue, 0);
  const returnedTotal = storeSummaries.reduce((sum, s) => sum + s.returned_total, 0);

  let trendFrom = from;
  if (from && to && from === to) {
    const base = new Date(`${to}T00:00:00`);
    base.setDate(base.getDate() - 6);
    trendFrom = `${base.getFullYear()}-${String(base.getMonth() + 1).padStart(2, "0")}-${String(base.getDate()).padStart(2, "0")}`;
  }
  const dailyTrend = buildDailyRevenueTrend({
    sales: allTargetSales,
    from: trendFrom,
    to,
  });

  return {
    from,
    to,
    trend_from: trendFrom,
    trend_to: to,
    daily_trend: dailyTrend,
    revenue,
    returned_total: returnedTotal,
    net_revenue: revenue - returnedTotal,
    transactions: storeSummaries.reduce((sum, s) => sum + s.transactions, 0),
    return_transactions: storeSummaries.reduce((sum, s) => sum + s.return_transactions, 0),
    payment_methods: paymentBreakdown,
    stores: storeSummaries,
  };
}

export async function exportBackupData({ stores, selectedStoreId, allStores, uid }) {
  const targetStores = allStores ? stores : stores.filter((s) => s.id === selectedStoreId);
  const allProducts = [];
  const allSales = [];
  const allMovements = [];
  const allShifts = [];

  for (const store of targetStores) {
    const [products, salesList, movementsSnap, shiftsSnap] = await Promise.all([
      fetchProducts({ storeId: store.id, uid, includeArchived: true }),
      loadStoreSalesWithReturns(store.id, uid),
      getDocs(query(collection(db, `stores/${store.id}/stockMovements`), where("memberUids", "array-contains", uid))),
      getDocs(query(collection(db, `stores/${store.id}/shifts`), where("memberUids", "array-contains", uid))),
    ]);

    allProducts.push(...products);
    allSales.push(...salesList);
    allMovements.push(
      ...movementsSnap.docs.map((d) => ({
        id: d.id,
        storeId: store.id,
        ...d.data(),
        createdAt: toDate(d.data().createdAt).toISOString(),
      })),
    );
    allShifts.push(...shiftsSnap.docs.map((d) => serializeShift(d, salesList)));
  }

  return {
    format: "kasirku-backup",
    version: 2,
    generatedAt: new Date().toISOString(),
    stores: targetStores,
    products: allProducts,
    sales: allSales,
    stockMovements: allMovements,
    shifts: allShifts,
    omitted: ["user credentials", "temporary scanner sessions"],
  };
}

export async function createScannerSession({ storeId }) {
  const path = `stores/${storeId}/scannerSessions`;
  try {
    const storeSnap = await getDoc(doc(db, "stores", storeId));
    if (!storeSnap.exists()) throw new Error("Toko tidak ditemukan.");
    const storeData = storeSnap.data();

    const token = randomHex(32);
    const tokenHash = await sha256Hex(token);
    const expiresAt = Timestamp.fromDate(new Date("2099-12-31T23:59:59.000Z"));
    const sessionRef = doc(collection(db, path));

    await setDoc(sessionRef, {
      storeId,
      ownerUid: storeData.ownerUid,
      memberUids: storeData.memberUids ?? [storeData.ownerUid],
      tokenHash,
      active: true,
      createdAt: serverTimestamp(),
      expiresAt,
    });

    return {
      id: sessionRef.id,
      storeId,
      token,
      expiresAt: expiresAt.toDate().toISOString(),
    };
  } catch (error) {
    if (isFirestoreError(error)) handleFirestoreError(error, OperationType.CREATE, path);
    throw error;
  }
}

export async function isScannerSessionActive({ storeId, sessionId, token }) {
  const path = `stores/${storeId}/scannerSessions/${sessionId}`;
  try {
    const sessionSnap = await getDoc(doc(db, "stores", storeId, "scannerSessions", sessionId));
    if (!sessionSnap.exists()) return false;
    const data = sessionSnap.data();
    if (!data.active) return false;
    if (token) {
      const expectedHash = await sha256Hex(token);
      if (data.tokenHash !== expectedHash) return false;
    }
    return true;
  } catch (error) {
    if (isFirestoreError(error)) handleFirestoreError(error, OperationType.GET, path);
    return false;
  }
}

export async function stopScannerSession({ storeId, sessionId }) {
  const path = `stores/${storeId}/scannerSessions/${sessionId}`;
  try {
    await deleteDoc(doc(db, "stores", storeId, "scannerSessions", sessionId));
  } catch (error) {
    handleFirestoreError(error, OperationType.DELETE, path);
  }
}

export function subscribeScannerSession({ storeId, sessionId, onEnded, onError }) {
  const path = `stores/${storeId}/scannerSessions/${sessionId}`;
  return onSnapshot(
    doc(db, "stores", storeId, "scannerSessions", sessionId),
    (snapshot) => {
      if (!snapshot.exists() || !snapshot.data()?.active) {
        onEnded();
      }
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.GET, path);
      } catch (wrapped) {
        onError?.(wrapped);
      }
    },
  );
}

export function subscribeScannerScans({ storeId, sessionId, uid, skipInitial = false, onScans, onError }) {
  const path = `stores/${storeId}/scannerSessions/${sessionId}/scans`;
  const q = query(collection(db, path), where("memberUids", "array-contains", uid));
  let initialized = false;
  return onSnapshot(
    q,
    (snapshot) => {
      if (!initialized) {
        initialized = true;
        if (skipInitial) return;
      }
      const added = snapshot
        .docChanges()
        .filter((change) => change.type === "added")
        .map((change) => ({
          id: change.doc.id,
          barcode: change.doc.data().barcode,
          createdAt: toDate(change.doc.data().createdAt).getTime(),
        }))
        .sort((a, b) => a.createdAt - b.createdAt);
      if (added.length) onScans(added);
    },
    (error) => {
      try {
        handleFirestoreError(error, OperationType.LIST, path);
      } catch (wrapped) {
        onError(wrapped);
      }
    },
  );
}

export async function submitRemoteScan({ storeId, sessionId, token, barcode }) {
  const cleanBarcode = String(barcode ?? "").trim();
  if (!/^\d{8,13}$/.test(cleanBarcode)) {
    throw new Error("Barcode harus berisi 8–13 angka.");
  }
  const sessionPath = `stores/${storeId}/scannerSessions/${sessionId}`;
  try {
    const sessionSnap = await getDoc(doc(db, "stores", storeId, "scannerSessions", sessionId));
    if (!sessionSnap.exists()) {
      throw new Error("Sesi pemindai sudah berakhir. Minta kode baru dari kasir.");
    }
    const sData = sessionSnap.data();
    const expectedHash = await sha256Hex(token);
    if (!sData.active || sData.tokenHash !== expectedHash) {
      throw new Error("Sesi pemindai sudah berakhir. Minta kode baru dari kasir.");
    }
    const scanRef = doc(collection(db, `${sessionPath}/scans`));
    await setDoc(scanRef, {
      storeId,
      sessionId,
      ownerUid: sData.ownerUid,
      memberUids: sData.memberUids,
      barcode: cleanBarcode,
      createdAt: serverTimestamp(),
    });
    return { id: scanRef.id, barcode: cleanBarcode };
  } catch (error) {
    if (isFirestoreError(error)) handleFirestoreError(error, OperationType.WRITE, sessionPath);
    throw error;
  }
}
