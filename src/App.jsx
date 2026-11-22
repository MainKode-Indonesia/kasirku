import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import JsBarcode from "jsbarcode";
import { QRCodeSVG } from "qrcode.react";
import {
  AlertCircle,
  ArrowDownToLine,
  Barcode,
  Boxes,
  Camera,
  Check,
  ChevronDown,
  CircleHelp,
  Clock3,
  CreditCard,
  LayoutDashboard,
  LogOut,
  Minus,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  ShoppingBag,
  ShoppingCart,
  Sparkles,
  Smartphone,
  Tag,
  Trash2,
  Wallet,
  X,
} from "lucide-react";
import { request } from "./api.js";
import { useCameraScanner } from "./useCameraScanner.js";

const rupiah = new Intl.NumberFormat("id-ID", {
  style: "currency",
  currency: "IDR",
  maximumFractionDigits: 0,
});

function localDateString(date = new Date()) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

function dateRangeQuery(range) {
  return new URLSearchParams({
    from: range.from,
    to: range.to,
    timezoneOffset: String(new Date().getTimezoneOffset()),
  });
}

function formatDateTime(value) {
  return new Intl.DateTimeFormat("id-ID", {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

function csvValue(value) {
  return `"${String(value ?? "").replaceAll('"', '""')}"`;
}

function paymentLabel(method) {
  return ({ cash: "Tunai", qris: "QRIS", transfer: "Transfer" })[method] ?? method;
}

function BarcodeGraphic({ value, height = 66 }) {
  const ref = useRef(null);
  useEffect(() => {
    if (ref.current && value) {
      JsBarcode(ref.current, value, {
        format: /^\d{13}$/.test(value) ? "EAN13" : "CODE128",
        width: 1.65,
        height,
        margin: 0,
        fontSize: 13,
        displayValue: true,
        background: "transparent",
      });
    }
  }, [value, height]);
  return <svg ref={ref} className="barcode-svg" aria-label={`Barcode ${value}`} />;
}

function CashierApp({ user, onLogout }) {
  const [products, setProducts] = useState([]);
  const [stores, setStores] = useState([{
    id: user.storeId,
    name: user.storeName,
    isPrimary: user.isPrimary,
  }]);
  const [selectedStoreId, setSelectedStoreId] = useState(user.storeId);
  const [report, setReport] = useState(null);
  const [storeAccounts, setStoreAccounts] = useState([]);
  const [passwordForm, setPasswordForm] = useState({ currentPassword: "", newPassword: "", confirmPassword: "" });
  const [resetPasswordStore, setResetPasswordStore] = useState(null);
  const [branchPassword, setBranchPassword] = useState("");
  const [paymentMethod, setPaymentMethod] = useState("cash");
  const [paymentSplits, setPaymentSplits] = useState({ cash: "", qris: "", transfer: "" });
  const [digitalConfirmed, setDigitalConfirmed] = useState(false);
  const [reportScope, setReportScope] = useState("store");
  const [dateRange, setDateRange] = useState(() => {
    const today = localDateString();
    return { from: today, to: today };
  });
  const [sales, setSales] = useState([]);
  const [shifts, setShifts] = useState([]);
  const [transactionSearch, setTransactionSearch] = useState("");
  const [selectedSale, setSelectedSale] = useState(null);
  const [returnQuantities, setReturnQuantities] = useState({});
  const [returnReason, setReturnReason] = useState("");
  const [stockProduct, setStockProduct] = useState(null);
  const [stockForm, setStockForm] = useState({ type: "in", quantity: "", direction: "increase", reason: "" });
  const [stockMovements, setStockMovements] = useState([]);
  const [shift, setShift] = useState(null);
  const [openingCash, setOpeningCash] = useState("");
  const [closingCash, setClosingCash] = useState("");
  const [transactionCode, setTransactionCode] = useState(() => String(Date.now()).slice(-6));
  const [connected, setConnected] = useState(false);
  const [dashboard, setDashboard] = useState({
    product_count: 0,
    low_stock_count: 0,
    today_revenue: 0,
    today_transactions: 0,
  });
  const [cart, setCart] = useState([]);
  const [activeTab, setActiveTab] = useState("Kasir");
  const [category, setCategory] = useState("Semua");
  const [search, setSearch] = useState("");
  const [scanValue, setScanValue] = useState("");
  const [cash, setCash] = useState("");
  const [showCameraScanner, setShowCameraScanner] = useState(false);
  const [showPairing, setShowPairing] = useState(false);
  const [remoteSession, setRemoteSession] = useState(null);
  const [showProductForm, setShowProductForm] = useState(false);
  const [editingProduct, setEditingProduct] = useState(null);
  const [showArchivedProducts, setShowArchivedProducts] = useState(false);
  const [showStoreForm, setShowStoreForm] = useState(false);
  const [storeForm, setStoreForm] = useState({ name: "", email: "", password: "" });
  const [productForm, setProductForm] = useState({
    name: "",
    category: "",
    price: "",
    stock: "",
    lowStockThreshold: "5",
    barcode: "",
  });
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [printProduct, setPrintProduct] = useState(null);
  const scanRef = useRef(null);
  const lastScannerEventId = useRef("000000000000000000000000");
  const apiRequest = useCallback((path, options = {}) => request(path, {
    ...options,
    headers: {
      "X-Store-Id": selectedStoreId,
      ...options.headers,
    },
  }).catch((requestError) => {
    if (requestError.status === 401 && /sesi|silakan masuk/i.test(requestError.message)) {
      onLogout();
    }
    throw requestError;
  }), [onLogout, selectedStoreId]);

  const loadData = useCallback(async () => {
    try {
      const currentDay = localDateString();
      const dayQuery = dateRangeQuery({ from: currentDay, to: currentDay });
      const [productData, summary, availableStores, activeShift] = await Promise.all([
        apiRequest(`/api/products${showArchivedProducts ? "?includeArchived=true" : ""}`),
        apiRequest(`/api/dashboard?${dayQuery}`),
        apiRequest("/api/stores"),
        apiRequest("/api/shifts/current"),
      ]);
      setProducts(productData);
      setDashboard(summary);
      setStores(availableStores);
      setShift(activeShift);
      setConnected(true);
    } catch (loadError) {
      setConnected(false);
      throw loadError;
    }
  }, [apiRequest, showArchivedProducts]);

  useEffect(() => {
    loadData().catch((loadError) => setError(loadError.message));
  }, [loadData]);

  const loadStoreAccounts = useCallback(async () => {
    setStoreAccounts(await apiRequest("/api/stores?includeInactive=true", {
      headers: { "X-Store-Id": user.storeId },
    }));
  }, [apiRequest, user.storeId]);

  useEffect(() => {
    if (activeTab === "Toko" && user.role === "owner") {
      loadStoreAccounts().catch((loadError) => setError(loadError.message));
    }
  }, [activeTab, loadStoreAccounts, user.role]);

  const addToCart = useCallback((product) => {
    if (product.stock < 1) {
      setError("Stok produk sedang habis.");
      return;
    }
    setError("");
    setCart((current) => {
      const existing = current.find((item) => item.id === product.id);
      if (existing) {
        return current.map((item) =>
          item.id === product.id && item.quantity < product.stock
            ? { ...item, quantity: item.quantity + 1 }
            : item,
        );
      }
      return [...current, { ...product, quantity: 1 }];
    });
  }, []);

  const processBarcode = useCallback((code) => {
    const value = code.trim();
    if (!value) return;
    const product = products.find((item) => item.barcode === value);
    if (product) addToCart(product);
    else setError(`Barcode ${value} belum terdaftar. Tambahkan produknya di menu Inventaris.`);
  }, [products, addToCart]);

  const cameraScanner = useCameraScanner(showCameraScanner, (code) => {
    processBarcode(code);
    setShowCameraScanner(false);
  });

  const loadReport = useCallback(async () => {
    const params = dateRangeQuery(dateRange);
    if (reportScope === "all") params.set("allStores", "true");
    else params.set("storeId", selectedStoreId);
    setReport(await apiRequest(`/api/reports?${params}`));
  }, [apiRequest, dateRange, reportScope, selectedStoreId]);

  const loadShifts = useCallback(async () => {
    const params = dateRangeQuery(dateRange);
    const result = await apiRequest(`/api/shifts?${params}`);
    setShifts(result.shifts);
  }, [apiRequest, dateRange]);

  useEffect(() => {
    if (activeTab === "Laporan") {
      Promise.all([loadReport(), loadShifts()]).catch((loadError) => setError(loadError.message));
    }
  }, [activeTab, loadReport, loadShifts]);

  const loadSales = useCallback(async () => {
    const params = dateRangeQuery(dateRange);
    if (transactionSearch.trim()) params.set("search", transactionSearch.trim());
    const result = await apiRequest(`/api/sales?${params}`);
    setSales(result.sales);
  }, [apiRequest, dateRange, transactionSearch]);

  useEffect(() => {
    if (activeTab !== "Transaksi") return undefined;
    const timeout = window.setTimeout(() => {
      loadSales().catch((loadError) => setError(loadError.message));
    }, 250);
    return () => window.clearTimeout(timeout);
  }, [activeTab, loadSales]);

  const loadStockMovements = useCallback(async (productId) => {
    const params = dateRangeQuery(dateRange);
    if (productId) params.set("productId", productId);
    setStockMovements(await apiRequest(`/api/stock-movements?${params}`));
  }, [apiRequest, dateRange]);
  const pairingUrl = remoteSession
    ? `${window.location.origin}/scanner#${new URLSearchParams({
        id: remoteSession.id,
        token: remoteSession.token,
      }).toString()}`
    : "";

  useEffect(() => {
    if (!remoteSession) return undefined;
    let active = true;
    let timeout;
    const pollScans = async () => {
      try {
        const events = await request(
          `/api/scanner-sessions/${remoteSession.id}/scans?after=${lastScannerEventId.current}`,
          { headers: { "X-Scanner-Token": remoteSession.token, "X-Store-Id": selectedStoreId } },
        );
        if (!active) return;
        for (const event of events) {
          lastScannerEventId.current = event.id;
          processBarcode(event.barcode);
        }
        timeout = window.setTimeout(pollScans, 700);
      } catch (pollError) {
        if (!active) return;
        setError(pollError.message);
        setRemoteSession(null);
      }
    };
    pollScans();
    return () => {
      active = false;
      window.clearTimeout(timeout);
    };
  }, [remoteSession, processBarcode, selectedStoreId]);

  useEffect(() => {
    if (!printProduct) return undefined;
    const timeout = window.setTimeout(() => window.print(), 180);
    const afterPrint = () => setPrintProduct(null);
    window.addEventListener("afterprint", afterPrint, { once: true });
    return () => {
      window.clearTimeout(timeout);
      window.removeEventListener("afterprint", afterPrint);
    };
  }, [printProduct]);

  const categories = useMemo(
    () => ["Semua", ...new Set(products.map((product) => product.category))],
    [products],
  );
  const filteredProducts = useMemo(() => {
    const query = search.trim().toLowerCase();
    return products.filter((product) => {
      const matchesCategory = category === "Semua" || product.category === category;
      const matchesSearch =
        !query ||
        product.name.toLowerCase().includes(query) ||
        product.barcode.includes(query);
      return matchesCategory && matchesSearch;
    });
  }, [products, category, search]);
  const totalItems = cart.reduce((sum, item) => sum + item.quantity, 0);
  const total = cart.reduce((sum, item) => sum + Number(item.price) * item.quantity, 0);
  const splitCash = Number(paymentSplits.cash || 0);
  const splitTotal = Number(paymentSplits.cash || 0) + Number(paymentSplits.qris || 0) + Number(paymentSplits.transfer || 0);
  const cashApplied = paymentMethod === "cash" ? total : paymentMethod === "mixed" ? splitCash : 0;
  const change = paymentMethod === "cash" || paymentMethod === "mixed"
    ? Math.max(0, Number(cash || 0) - cashApplied)
    : 0;
  const paymentIsValid = paymentMethod === "cash"
    ? Number(cash) >= total
    : paymentMethod === "mixed"
      ? splitTotal === total && Number(cash) >= splitCash && (!(Number(paymentSplits.qris) || Number(paymentSplits.transfer)) || digitalConfirmed)
      : total > 0 && digitalConfirmed;
  const lowStockProducts = products.filter((product) => !product.isArchived && product.stock <= product.lowStockThreshold);

  function scanProduct(event) {
    event.preventDefault();
    processBarcode(scanValue);
    setScanValue("");
    scanRef.current?.focus();
  }

  async function connectPhoneScanner() {
    setError("");
    try {
      const session = await apiRequest("/api/scanner-sessions", { method: "POST" });
      lastScannerEventId.current = "000000000000000000000000";
      setRemoteSession(session);
      setShowPairing(true);
    } catch (sessionError) {
      setError(sessionError.message);
    }
  }

  async function stopPhoneScanner() {
    if (!remoteSession) return;
    const session = remoteSession;
    setRemoteSession(null);
    setShowPairing(false);
    try {
      await apiRequest(`/api/scanner-sessions/${session.id}`, {
        method: "DELETE",
        headers: { "X-Scanner-Token": session.token },
      });
      setNotice("Sesi pemindai HP sudah diakhiri.");
    } catch (sessionError) {
      setError(sessionError.message);
    }
  }

  function updateQuantity(productId, delta) {
    setCart((current) =>
      current
        .map((item) =>
          item.id === productId
            ? { ...item, quantity: Math.min(item.stock, item.quantity + delta) }
            : item,
        )
        .filter((item) => item.quantity > 0),
    );
  }

  async function saveProduct(event) {
    event.preventDefault();
    setError("");
    try {
      const saved = await apiRequest(editingProduct ? `/api/products/${editingProduct.id}` : "/api/products", {
        method: editingProduct ? "PUT" : "POST",
        body: JSON.stringify(editingProduct
          ? {
              name: productForm.name,
              category: productForm.category,
              price: productForm.price,
              lowStockThreshold: Number(productForm.lowStockThreshold),
              barcode: productForm.barcode,
            }
          : productForm),
      });
      await loadData();
      setProductForm({ name: "", category: "", price: "", stock: "", lowStockThreshold: "5", barcode: "" });
      setShowProductForm(false);
      setEditingProduct(null);
      setNotice(`Produk ${saved.name} ${editingProduct ? "diperbarui" : "ditambahkan"}.`);
    } catch (saveError) {
      setError(saveError.message);
    }
  }

  function openProductForm(product = null) {
    setEditingProduct(product);
    setProductForm(product
      ? {
          name: product.name,
          category: product.category,
          price: String(product.price),
          stock: String(product.stock),
          lowStockThreshold: String(product.lowStockThreshold),
          barcode: product.barcode,
        }
      : { name: "", category: "", price: "", stock: "", lowStockThreshold: "5", barcode: "" });
    setShowProductForm(true);
  }

  async function archiveProduct(product) {
    if (!window.confirm(`Arsipkan produk "${product.name}"? Riwayat penjualan tetap disimpan.`)) return;
    try {
      await apiRequest(`/api/products/${product.id}`, { method: "DELETE" });
      await loadData();
      setNotice(`Produk ${product.name} diarsipkan.`);
    } catch (archiveError) {
      setError(archiveError.message);
    }
  }

  async function restoreProduct(product) {
    try {
      await apiRequest(`/api/products/${product.id}/restore`, { method: "PATCH" });
      await loadData();
      setNotice(`Produk ${product.name} dipulihkan.`);
    } catch (restoreError) {
      setError(restoreError.message);
    }
  }

  async function createStore(event) {
    event.preventDefault();
    try {
      const store = await apiRequest("/api/stores", {
        method: "POST",
        body: JSON.stringify(storeForm),
      });
      setStoreForm({ name: "", email: "", password: "" });
      setShowStoreForm(false);
      await Promise.all([loadData(), loadStoreAccounts()]);
      setNotice(`Toko ${store.name} ditambahkan. Akun cabang: ${store.accountEmail}`);
    } catch (storeError) {
      setError(storeError.message);
    }
  }

  async function toggleStoreStatus(store) {
    const active = !store.active;
    if (!active && !window.confirm(`Nonaktifkan ${store.name}? Akun admin akan dikeluarkan dan tidak dapat login.`)) return;
    setError("");
    try {
      await apiRequest(`/api/stores/${store.id}/status`, {
        method: "PATCH",
        body: JSON.stringify({ active }),
      });
      if (!active && selectedStoreId === store.id) {
        setSelectedStoreId(user.storeId);
        setCart([]);
        await loadStoreAccounts();
      } else {
        await Promise.all([loadStoreAccounts(), loadData()]);
      }
      setNotice(`Toko ${store.name} ${active ? "diaktifkan" : "dinonaktifkan"}.`);
    } catch (statusError) {
      setError(statusError.message);
    }
  }

  async function resetBranchPassword(event) {
    event.preventDefault();
    if (!resetPasswordStore) return;
    setError("");
    try {
      await apiRequest(`/api/stores/${resetPasswordStore.id}/password`, {
        method: "POST",
        body: JSON.stringify({ password: branchPassword }),
      });
      setResetPasswordStore(null);
      setBranchPassword("");
      setNotice(`Password akun ${resetPasswordStore.accountEmail} berhasil diatur ulang.`);
    } catch (passwordError) {
      setError(passwordError.message);
    }
  }

  async function changeOwnPassword(event) {
    event.preventDefault();
    if (passwordForm.newPassword !== passwordForm.confirmPassword) {
      setError("Konfirmasi password baru tidak cocok.");
      return;
    }
    setError("");
    try {
      await apiRequest("/api/auth/change-password", {
        method: "POST",
        body: JSON.stringify({
          currentPassword: passwordForm.currentPassword,
          newPassword: passwordForm.newPassword,
        }),
      });
      setPasswordForm({ currentPassword: "", newPassword: "", confirmPassword: "" });
      await onLogout("Password berhasil diganti. Silakan masuk kembali.");
    } catch (passwordError) {
      setError(passwordError.message);
    }
  }

  async function downloadBackup(allStores = false) {
    setError("");
    try {
      const response = await fetch(`/api/backup${allStores ? "?allStores=true" : ""}`, {
        headers: { "X-Store-Id": selectedStoreId },
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.error || "Cadangan data tidak dapat diunduh.");
      }
      const blob = await response.blob();
      const filename = response.headers.get("Content-Disposition")?.match(/filename="([^"]+)"/)?.[1]
        ?? "kasirku-backup.json";
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = filename;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
      setNotice("Cadangan data berhasil diunduh. Simpan file dengan aman.");
    } catch (backupError) {
      setError(backupError.message);
    }
  }

  async function saveStockMovement(event) {
    event.preventDefault();
    if (!stockProduct) return;
    setError("");
    try {
      const movement = await apiRequest("/api/stock-movements", {
        method: "POST",
        body: JSON.stringify({
          productId: stockProduct.id,
          type: stockForm.type,
          quantity: Number(stockForm.quantity),
          direction: stockForm.direction,
          reason: stockForm.reason,
        }),
      });
      setStockProduct((product) => ({ ...product, stock: movement.stockAfter }));
      await Promise.all([loadData(), loadStockMovements(stockProduct.id)]);
      setStockForm({ type: "in", quantity: "", direction: "increase", reason: "" });
      setNotice(`Pergerakan stok ${stockProduct.name} berhasil dicatat.`);
    } catch (movementError) {
      setError(movementError.message);
    }
  }

  async function openShift(event) {
    event.preventDefault();
    setError("");
    try {
      await apiRequest("/api/shifts", {
        method: "POST",
        body: JSON.stringify({ openingCash: Number(openingCash) }),
      });
      setOpeningCash("");
      await loadData();
      setNotice("Shift dibuka. Catat kas akhir saat shift selesai.");
    } catch (shiftError) {
      setError(shiftError.message);
    }
  }

  async function closeShift(event) {
    event.preventDefault();
    if (!shift) return;
    setError("");
    try {
      const closed = await apiRequest(`/api/shifts/${shift.id}/close`, {
        method: "POST",
        body: JSON.stringify({ closingCash: Number(closingCash) }),
      });
      setClosingCash("");
      setShift(null);
      await loadData();
      setNotice(
        `Shift ditutup. Kas seharusnya ${rupiah.format(closed.expectedCash)}; selisih ${rupiah.format(closed.difference)}.`,
      );
    } catch (shiftError) {
      setError(shiftError.message);
    }
  }

  async function submitReturn(event) {
    event.preventDefault();
    if (!selectedSale) return;
    const items = selectedSale.items
      .map((item) => ({ productId: item.productId, quantity: Number(returnQuantities[item.productId] ?? 0) }))
      .filter((item) => item.quantity > 0);
    if (!items.length) {
      setError("Pilih jumlah barang yang akan dikembalikan.");
      return;
    }
    setError("");
    try {
      const returnedSale = await apiRequest(`/api/sales/${selectedSale.id}/returns`, {
        method: "POST",
        body: JSON.stringify({ items, reason: returnReason }),
      });
      setSelectedSale(returnedSale);
      setReturnQuantities(Object.fromEntries(returnedSale.items.map((item) => [item.productId, 0])));
      setReturnReason("");
      await Promise.all([loadSales(), loadData()]);
      setNotice(`Retur ${rupiah.format(returnedSale.returnedTotal)} berhasil dicatat dan stok diperbarui.`);
    } catch (returnError) {
      setError(returnError.message);
    }
  }

  function exportReport() {
    if (!report) return;
    const rows = [
      ["Toko", "Pendapatan kotor", "Retur", "Pendapatan bersih", "Transaksi", "Jumlah retur"],
      ...report.stores.map((store) => [
        store.storeName,
        store.revenue,
        store.returned_total,
        store.net_revenue,
        store.transactions,
        store.return_transactions,
      ]),
      ["TOTAL", report.revenue, report.returned_total, report.net_revenue, report.transactions, report.return_transactions],
      [],
      ["METODE PEMBAYARAN", "Pendapatan kotor", "Retur", "Pendapatan bersih"],
      ...(report.payment_methods ?? []).map((payment) => [
        paymentLabel(payment.method),
        payment.revenue,
        payment.returned_total,
        payment.net_revenue,
      ]),
    ];
    const content = `\uFEFF${rows.map((row) => row.map(csvValue).join(",")).join("\r\n")}`;
    const url = URL.createObjectURL(new Blob([content], { type: "text/csv;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `laporan-${report.from}-${report.to}.csv`;
    link.click();
    window.setTimeout(() => URL.revokeObjectURL(url), 0);
  }

  async function checkout() {
    setError("");
    try {
      const payments = paymentMethod === "cash"
        ? [{ method: "cash", amount: total }]
        : paymentMethod === "mixed"
          ? ["cash", "qris", "transfer"]
            .map((method) => ({ method, amount: Number(paymentSplits[method] || 0) }))
            .filter((payment) => payment.amount > 0)
          : [{ method: paymentMethod, amount: total }];
      const sale = await apiRequest("/api/sales", {
        method: "POST",
        body: JSON.stringify({
          cashTendered: paymentMethod === "cash" || paymentMethod === "mixed" ? Number(cash) : 0,
          payments,
          items: cart.map((item) => ({ productId: item.id, quantity: item.quantity })),
        }),
      });
      setNotice(`Transaksi berhasil. Kembalian ${rupiah.format(Number(sale.change))}.`);
      setCart([]);
      setCash("");
      setPaymentSplits({ cash: "", qris: "", transfer: "" });
      setDigitalConfirmed(false);
      setTransactionCode(String(Date.now()).slice(-6));
      await loadData();
    } catch (checkoutError) {
      setError(checkoutError.message);
    }
  }

  const navItems = [
    { name: "Kasir", icon: ShoppingCart },
    { name: "Inventaris", icon: Boxes },
    { name: "Stok menipis", icon: AlertCircle },
    { name: "Transaksi", icon: CreditCard },
    { name: "Laporan", icon: LayoutDashboard },
    { name: "Akun", icon: Wallet },
    ...(user.role === "owner" ? [{ name: "Toko", icon: Smartphone }] : []),
  ];

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <a className="brand" href="#" onClick={(event) => event.preventDefault()}>
          <span className="brand-mark"><ShoppingBag size={21} strokeWidth={2.5} /></span>
          <span>kasir<span className="brand-green">ku</span><small>POINT OF SALE</small></span>
        </a>
        <div className="store-switcher">
          <span className="store-avatar">T</span>
          {user.role === "owner" ? (
            <label className="store-copy store-select-label">
              <strong>Lokasi aktif</strong>
              <select value={selectedStoreId} onChange={(event) => {
                setSelectedStoreId(event.target.value);
                setCart([]);
                setRemoteSession(null);
                setError("");
              }}>
                {stores.map((store) => <option value={store.id} key={store.id}>{store.name}{store.isPrimary ? " · Utama" : ""}</option>)}
              </select>
            </label>
          ) : (
            <span className="store-copy"><strong>{user.storeName}</strong><small>Cabang toko</small></span>
          )}
        </div>
        <div className="nav-label">MENU UTAMA</div>
        <nav className="navigation">
          {navItems.map(({ name, icon: Icon }) => (
            <button
              className={`nav-item ${activeTab === name ? "active" : ""}`}
              key={name}
              onClick={() => setActiveTab(name)}
            >
              <Icon size={18} />
              <span>{name}</span>
              {name === "Kasir" && cart.length > 0 && <span className="nav-count">{totalItems}</span>}
              {name === "Stok menipis" && lowStockProducts.length > 0 && <span className="nav-count">{lowStockProducts.length}</span>}
            </button>
          ))}
        </nav>
        <div className="sidebar-bottom">
          <div className="help-card">
            <span className="help-icon"><CircleHelp size={17} /></span>
            <div><strong>Butuh bantuan?</strong><small>Pelajari cara pakai KasirKu</small></div>
            <ArrowDownToLine size={15} />
          </div>
          <div className="user-profile">
            <div className="user-avatar">A</div>
            <div className="user-copy"><strong>{user.email}</strong><small>{user.role === "owner" ? "Pemilik utama" : "Admin cabang"}</small></div>
            <button className="logout-button" onClick={onLogout} aria-label="Keluar" title="Keluar"><LogOut size={15} /></button>
          </div>
        </div>
      </aside>

      <main className="main-content">
        <header className="topbar">
          <div className="breadcrumb">{stores.find((store) => store.id === selectedStoreId)?.name ?? user.storeName} <span>/</span> <strong>{activeTab}</strong></div>
          <div className="topbar-right">
            {user.role === "owner" && (
              <select
                className="topbar-store-select"
                aria-label="Pilih toko"
                value={selectedStoreId}
                onChange={(event) => {
                  setSelectedStoreId(event.target.value);
                  setCart([]);
                  setRemoteSession(null);
                  setError("");
                }}
              >
                {stores.map((store) => <option value={store.id} key={store.id}>{store.name}</option>)}
              </select>
            )}
            <span className={`connection-status ${connected ? "" : "offline"}`}><span />{connected ? "Terhubung" : "Tidak terhubung"}</span>
            <span className="date-chip"><Clock3 size={15} />{new Intl.DateTimeFormat("id-ID", { dateStyle: "medium" }).format(new Date())}</span>
            <button className="icon-button" aria-label="Bantuan"><CircleHelp size={18} /></button>
          </div>
        </header>

        <section className="page-heading">
          <div>
            <div className="eyebrow">{activeTab === "Kasir" ? "TRANSAKSI HARI INI" : "KELOLA TOKO"}</div>
            <h1>{activeTab === "Kasir" ? "Kasir" : activeTab === "Toko" ? "Kelola toko" : activeTab}</h1>
            <p>{activeTab === "Kasir" ? "Scan barcode atau pilih produk untuk memulai transaksi." : activeTab === "Toko" ? "Buat cabang, kelola akses akun, dan ekspor data." : activeTab === "Laporan" ? "Pantau performa penjualan toko." : activeTab === "Transaksi" ? "Cari transaksi, periksa detail, atau catat retur barang." : activeTab === "Stok menipis" ? "Periksa produk di bawah batas minimum dan lakukan restock." : activeTab === "Akun" ? "Atur keamanan akun dan unduh cadangan data." : "Pantau dan kelola produk tokomu dengan mudah."}</p>
          </div>
          {activeTab === "Inventaris" && (
            <div className="heading-actions">
              {user.role === "owner" && (
                <button className="secondary-button" onClick={() => setShowArchivedProducts((value) => !value)}>
                  {showArchivedProducts ? "Produk aktif" : "Produk arsip"}
                </button>
              )}
              <button className="primary-button" onClick={() => openProductForm()}>
                <Plus size={17} /> Tambah produk
              </button>
            </div>
          )}
          {activeTab === "Laporan" && (
            <div className="heading-actions">
              {user.role === "owner" && (
                <select className="report-scope-select" value={reportScope} onChange={(event) => setReportScope(event.target.value)}>
                  <option value="store">Toko ini</option>
                  <option value="all">Semua toko</option>
                </select>
              )}
              <label className="date-filter">Dari<input aria-label="Tanggal awal laporan" type="date" value={dateRange.from} max={dateRange.to} onChange={(event) => setDateRange((range) => ({ ...range, from: event.target.value }))} /></label>
              <label className="date-filter">Sampai<input aria-label="Tanggal akhir laporan" type="date" value={dateRange.to} min={dateRange.from} onChange={(event) => setDateRange((range) => ({ ...range, to: event.target.value }))} /></label>
              <button className="secondary-button" onClick={exportReport} disabled={!report}>
                <ArrowDownToLine size={16} /> Ekspor CSV
              </button>
              <button className="secondary-button" onClick={() => Promise.all([loadReport(), loadShifts()]).catch((e) => setError(e.message))}>
                <ArrowDownToLine size={16} /> Perbarui data
              </button>
            </div>
          )}
          {activeTab === "Transaksi" && (
            <div className="heading-actions">
              <label className="date-filter">Dari<input aria-label="Tanggal awal transaksi" type="date" value={dateRange.from} max={dateRange.to} onChange={(event) => setDateRange((range) => ({ ...range, from: event.target.value }))} /></label>
              <label className="date-filter">Sampai<input aria-label="Tanggal akhir transaksi" type="date" value={dateRange.to} min={dateRange.from} onChange={(event) => setDateRange((range) => ({ ...range, to: event.target.value }))} /></label>
            </div>
          )}
          {activeTab === "Toko" && (
            <button className="primary-button" onClick={() => setShowStoreForm(true)}>
              <Plus size={17} /> Tambah toko
            </button>
          )}
        </section>

        {(error || notice) && (
          <div className={`alert ${error ? "alert-error" : "alert-success"}`}>
            {error ? <AlertCircle size={17} /> : <Check size={17} />}
            <span>{error || notice}</span>
            <button onClick={() => { setError(""); setNotice(""); }} aria-label="Tutup notifikasi"><X size={16} /></button>
          </div>
        )}

        {activeTab === "Kasir" && (
          <>
          {lowStockProducts.length > 0 && (
            <div className="low-stock-alert">
              <AlertCircle size={17} />
              <span><strong>{lowStockProducts.length} produk perlu restock</strong> — beberapa stok sudah menyentuh batas minimum.</span>
              <button className="text-button" onClick={() => setActiveTab("Stok menipis")}>Lihat daftar</button>
            </div>
          )}
          <section className="shift-card">
            <div className="shift-summary">
              <span className={`shift-indicator ${shift ? "shift-open" : ""}`} />
              <div>
                <strong>{shift ? "Shift sedang berjalan" : "Belum ada shift kasir"}</strong>
                <small>{shift ? `Dibuka ${formatDateTime(shift.openedAt)} · ${shift.transactions} transaksi` : "Buka shift dan masukkan jumlah kas awal sebelum berjualan."}</small>
              </div>
            </div>
            {shift ? (
              <form className="shift-form" onSubmit={closeShift}>
                <span className="shift-expected">Kas seharusnya <strong>{rupiah.format(shift.expectedCash)}</strong></span>
                <label>Kas aktual<input aria-label="Kas aktual saat tutup shift" type="number" min="0" step="1" required value={closingCash} onChange={(event) => setClosingCash(event.target.value)} placeholder="Hitung kas laci" /></label>
                <button className="secondary-button" type="submit">Tutup shift</button>
              </form>
            ) : (
              <form className="shift-form" onSubmit={openShift}>
                <label>Kas awal<input aria-label="Kas awal shift" type="number" min="0" step="1" required value={openingCash} onChange={(event) => setOpeningCash(event.target.value)} placeholder="Masukkan kas awal" /></label>
                <button className="primary-button" type="submit">Buka shift</button>
              </form>
            )}
          </section>
          <div className="pos-layout">
            <section className="catalog-panel">
              <div className="scanner-card">
                <div className="scanner-icon"><Barcode size={22} /></div>
                <div className="scanner-copy"><strong>Scan barcode produk</strong><small>Arahkan scanner ke barcode produk</small></div>
                <div className="scanner-entry">
                  <form className="scanner-form" onSubmit={scanProduct}>
                    <Barcode size={17} />
                    <input
                      ref={scanRef}
                      aria-label="Scan atau ketik barcode"
                      placeholder="Scan atau ketik barcode..."
                      value={scanValue}
                      onChange={(event) => setScanValue(event.target.value)}
                    />
                    <kbd>ENTER</kbd>
                  </form>
                  <button
                    className="camera-button"
                    onClick={() => setShowCameraScanner(true)}
                    aria-label="Scan barcode dengan kamera"
                  >
                    <Camera size={16} /><span>Kamera</span>
                  </button>
                  <button
                    className={`camera-button ${remoteSession ? "phone-scanner-active" : ""}`}
                    onClick={() => remoteSession ? setShowPairing(true) : connectPhoneScanner()}
                    aria-label={remoteSession ? "Lihat QR pemindai HP" : "Hubungkan pemindai HP"}
                  >
                    <Smartphone size={16} /><span>{remoteSession ? "Lihat QR" : "Hubungkan HP"}</span>
                  </button>
                </div>
              </div>
              <div className="catalog-toolbar">
                <div><h2>Pilih produk</h2><span>{filteredProducts.length} produk tersedia</span></div>
                <label className="search-field">
                  <Search size={17} />
                  <input placeholder="Cari produk..." value={search} onChange={(event) => setSearch(event.target.value)} />
                  <kbd>⌘ K</kbd>
                </label>
              </div>
              <div className="category-list">
                {categories.map((item) => (
                  <button className={`category-chip ${category === item ? "selected" : ""}`} key={item} onClick={() => setCategory(item)}>
                    {item === "Semua" && <Tag size={14} />}{item}
                  </button>
                ))}
              </div>
              {filteredProducts.length ? (
                <div className="product-grid">
                  {filteredProducts.map((product, index) => (
                    <button className="product-card" key={product.id} onClick={() => addToCart(product)} disabled={product.stock < 1}>
                      <div className={`product-visual visual-${index % 6}`}>
                        <ShoppingBag size={29} strokeWidth={1.6} />
                        <span className="stock-tag">{product.stock > 0 ? `Stok ${product.stock}` : "Habis"}</span>
                      </div>
                      <div className="product-info">
                        <span className="product-category">{product.category}</span>
                        <strong>{product.name}</strong>
                        <span className="product-price">{rupiah.format(Number(product.price))}</span>
                      </div>
                      <span className="add-product"><Plus size={16} /></span>
                    </button>
                  ))}
                </div>
              ) : (
                <div className="empty-products">
                  <span><ShoppingBag size={23} /></span>
                  <strong>Belum ada produk</strong>
                  <p>Tambahkan produk dari menu Inventaris untuk mulai transaksi.</p>
                  <button className="text-button" onClick={() => setActiveTab("Inventaris")}>Buka inventaris <span>→</span></button>
                </div>
              )}
            </section>

            <aside className="cart-panel">
              <div className="cart-header"><div><h2>Pesanan</h2><span>{totalItems} item dipilih</span></div><span className="cart-icon"><ShoppingCart size={18} /></span></div>
              <div className="cart-meta"><span><span className="live-dot" /> TRANSAKSI BARU</span><span>#{transactionCode}</span></div>
              <div className="cart-items">
                {cart.length ? cart.map((item) => (
                  <div className="cart-item" key={item.id}>
                    <div className="cart-product-icon"><ShoppingBag size={17} /></div>
                    <div className="cart-product-copy"><strong>{item.name}</strong><span>{rupiah.format(Number(item.price))}</span></div>
                    <div className="quantity-control">
                      <button onClick={() => updateQuantity(item.id, -1)} aria-label={`Kurangi ${item.name}`}><Minus size={13} /></button>
                      <span>{item.quantity}</span>
                      <button onClick={() => updateQuantity(item.id, 1)} aria-label={`Tambah ${item.name}`}><Plus size={13} /></button>
                    </div>
                    <button className="remove-item" onClick={() => setCart((current) => current.filter((product) => product.id !== item.id))} aria-label={`Hapus ${item.name}`}><Trash2 size={15} /></button>
                  </div>
                )) : (
                  <div className="empty-cart">
                    <span><ShoppingCart size={23} /></span>
                    <strong>Belum ada pesanan</strong>
                    <small>Scan barcode atau pilih produk di samping</small>
                  </div>
                )}
              </div>
              <div className="payment-section">
                <div className="summary-row"><span>Subtotal</span><span>{rupiah.format(total)}</span></div>
                <div className="summary-row"><span>Diskon</span><span className="muted-value">—</span></div>
                <div className="summary-total"><strong>Total bayar</strong><strong>{rupiah.format(total)}</strong></div>
                <label className="cash-label" htmlFor="payment-method">Metode pembayaran</label>
                <select
                  id="payment-method"
                  className="payment-method-select"
                  aria-label="Metode pembayaran"
                  value={paymentMethod}
                  onChange={(event) => {
                    setPaymentMethod(event.target.value);
                    setCash("");
                    setPaymentSplits({ cash: "", qris: "", transfer: "" });
                    setDigitalConfirmed(false);
                  }}
                >
                  <option value="cash">Tunai</option>
                  <option value="qris">QRIS</option>
                  <option value="transfer">Transfer bank</option>
                  <option value="mixed">Pembayaran campuran</option>
                </select>
                {paymentMethod === "cash" && (
                  <>
                    <label className="cash-label" htmlFor="cash">Uang diterima</label>
                    <div className="cash-input"><Wallet size={17} /><input id="cash" type="number" min="0" step="1" placeholder="Masukkan nominal" value={cash} onChange={(event) => setCash(event.target.value)} /><button type="button" onClick={() => setCash(String(total))}>Uang pas</button></div>
                  </>
                )}
                {paymentMethod === "mixed" && (
                  <>
                    <div className="mixed-payments-grid">
                      {["cash", "qris", "transfer"].map((method) => (
                        <label key={method}>{paymentLabel(method)}<input aria-label={`Nominal ${paymentLabel(method)}`} type="number" min="0" step="1" value={paymentSplits[method]} onChange={(event) => {
                          setPaymentSplits({ ...paymentSplits, [method]: event.target.value });
                          setDigitalConfirmed(false);
                        }} /></label>
                      ))}
                    </div>
                    <div className={`payment-split-status ${splitTotal === total ? "payment-split-valid" : ""}`}>
                      Dibagi {rupiah.format(splitTotal)} dari {rupiah.format(total)}
                    </div>
                    {splitCash > 0 && (
                      <>
                        <label className="cash-label" htmlFor="cash">Tunai diterima</label>
                        <div className="cash-input"><Wallet size={17} /><input id="cash" type="number" min={splitCash} step="1" placeholder="Nominal tunai" value={cash} onChange={(event) => setCash(event.target.value)} /><button type="button" onClick={() => setCash(String(splitCash))}>Uang pas</button></div>
                      </>
                    )}
                  </>
                )}
                {paymentMethod !== "cash" && (paymentMethod !== "mixed" || Number(paymentSplits.qris) > 0 || Number(paymentSplits.transfer) > 0) && (
                  <>
                    <label className="payment-confirmation"><input type="checkbox" checked={digitalConfirmed} onChange={(event) => setDigitalConfirmed(event.target.checked)} />Pembayaran QRIS/transfer sudah diterima</label>
                    <small className="payment-manual-note">Pembayaran dicatat manual; aplikasi tidak terhubung ke payment gateway.</small>
                  </>
                )}
                <div className="change-row"><span>Kembalian</span><strong>{rupiah.format(change)}</strong></div>
                <button className="checkout-button" disabled={!shift || !cart.length || !paymentIsValid} onClick={checkout}>
                  <CreditCard size={18} /> Bayar sekarang <span>{rupiah.format(total)}</span>
                </button>
                <div className="secure-note"><Sparkles size={14} />{shift ? "Transaksi aman tersimpan otomatis" : "Buka shift untuk mengaktifkan pembayaran"}</div>
              </div>
            </aside>
          </div>
          </>
        )}

        {activeTab === "Inventaris" && (
          <>
            <div className="stats-row">
              <div className="stat-card"><span className="stat-icon mint"><Boxes size={18} /></span><span className="stat-caption">TOTAL PRODUK</span><strong>{dashboard.product_count}</strong><small>Produk terdaftar</small></div>
              <div className="stat-card"><span className="stat-icon amber"><AlertCircle size={18} /></span><span className="stat-caption">STOK MENIPIS</span><strong>{dashboard.low_stock_count}</strong><small>Mencapai batas minimum produk</small></div>
              <div className="stat-card"><span className="stat-icon lilac"><Barcode size={18} /></span><span className="stat-caption">BARCODE</span><strong>{products.length}</strong><small>Barcode aktif</small></div>
            </div>
            <section className="inventory-card">
              <div className="inventory-toolbar">
                <div><h2>Daftar produk</h2><p>Produk tersimpan dengan barcode untuk pemindaian kasir.</p></div>
                <label className="search-field"><Search size={17} /><input placeholder="Cari nama atau barcode..." value={search} onChange={(event) => setSearch(event.target.value)} /></label>
              </div>
              <div className="table-scroll">
                <table>
                  <thead><tr><th>PRODUK</th><th>KATEGORI</th><th>BARCODE</th><th>HARGA</th><th>STOK</th><th>BATAS MIN.</th><th>AKSI</th></tr></thead>
                  <tbody>
                    {filteredProducts.map((product) => (
                      <tr key={product.id}>
                        <td><span className="table-product-icon"><ShoppingBag size={16} /></span><strong>{product.name}</strong></td>
                        <td><span className="table-category">{product.category}</span></td>
                        <td><span className="barcode-text">{product.barcode}</span></td>
                        <td>{rupiah.format(Number(product.price))}</td>
                        <td><span className={`stock-value ${product.stock <= product.lowStockThreshold ? "low" : ""}`}>{product.stock} unit</span></td>
                        <td>{product.lowStockThreshold} unit</td>
                        <td>
                          <div className="table-actions">
                            {!product.isArchived && (
                              <>
                                <button className="print-button" onClick={() => openProductForm(product)}><Pencil size={14} /> Edit</button>
                                <button className="print-button" onClick={() => {
                                  setStockProduct(product);
                                  setStockForm({ type: "in", quantity: "", direction: "increase", reason: "" });
                                  loadStockMovements(product.id).catch((movementError) => setError(movementError.message));
                                }}><Boxes size={14} /> Stok</button>
                                <button className="print-button" onClick={() => setPrintProduct(product)}><Barcode size={14} /> Label</button>
                              </>
                            )}
                            {product.isArchived
                              ? <button className="print-button" onClick={() => restoreProduct(product)}><RotateCcw size={14} /> Pulihkan</button>
                              : <button className="print-button archive-action" onClick={() => archiveProduct(product)}><Trash2 size={14} /> Arsip</button>}
                          </div>
                        </td>
                      </tr>
                    ))}
                    {!filteredProducts.length && <tr><td className="table-empty" colSpan="7">{showArchivedProducts ? "Tidak ada produk yang diarsipkan." : "Produk belum tersedia. Tambahkan produk pertamamu."}</td></tr>}
                  </tbody>
                </table>
              </div>
            </section>
          </>
        )}

        {activeTab === "Stok menipis" && (
          <section className="inventory-card">
            <div className="inventory-toolbar"><div><h2>Produk perlu restock</h2><p>{lowStockProducts.length} produk berada di atau di bawah batas minimum.</p></div></div>
            <div className="table-scroll">
              <table>
                <thead><tr><th>PRODUK</th><th>STOK SAAT INI</th><th>BATAS MINIMUM</th><th>AKSI</th></tr></thead>
                <tbody>
                  {lowStockProducts.map((product) => (
                    <tr key={product.id}>
                      <td><span className="table-sale-cell"><strong>{product.name}</strong><small className="table-subtext">{product.category}</small></span></td>
                      <td><span className="stock-value low">{product.stock} unit</span></td>
                      <td>{product.lowStockThreshold} unit</td>
                      <td><button className="print-button" onClick={() => {
                        setStockProduct(product);
                        setStockForm({ type: "in", quantity: "", direction: "increase", reason: "" });
                        loadStockMovements(product.id).catch((movementError) => setError(movementError.message));
                      }}><Boxes size={14} /> Tambah stok</button></td>
                    </tr>
                  ))}
                  {!lowStockProducts.length && <tr><td className="table-empty" colSpan="4">Tidak ada produk yang perlu direstock.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {activeTab === "Laporan" && (
          <div className="report-grid">
            <div className="report-card report-highlight"><span className="stat-icon mint"><Wallet size={19} /></span><span className="stat-caption">PENDAPATAN KOTOR</span><strong>{rupiah.format(Number(report?.revenue ?? 0))}</strong><small>{report?.transactions ?? 0} transaksi dalam rentang</small></div>
            <div className="report-card"><span className="stat-icon amber"><RotateCcw size={19} /></span><span className="stat-caption">RETUR</span><strong>{rupiah.format(Number(report?.returned_total ?? 0))}</strong><small>{report?.return_transactions ?? 0} transaksi retur</small></div>
            <div className="report-card"><span className="stat-icon lilac"><CreditCard size={19} /></span><span className="stat-caption">PENDAPATAN BERSIH</span><strong>{rupiah.format(Number(report?.net_revenue ?? 0))}</strong><small>Penjualan dikurangi retur</small></div>
            <div className="report-card"><span className="stat-icon mint"><Clock3 size={19} /></span><span className="stat-caption">RENTANG TANGGAL</span><strong>{report?.transactions ?? 0}</strong><small>{dateRange.from} — {dateRange.to}</small></div>
            <div className="report-card"><span className="stat-icon amber"><Boxes size={19} /></span><span className="stat-caption">PRODUK TERDAFTAR</span><strong>{dashboard.product_count}</strong><small>{dashboard.low_stock_count} produk perlu restock</small></div>
            <section className="store-report-list">
              <h2>{reportScope === "all" ? "Rincian semua toko" : "Rincian toko"}</h2>
              <div className="store-report-header"><span>TOKO</span><span>KOTOR</span><span>RETUR</span><span>BERSIH</span></div>
              {(report?.stores ?? []).map((store) => (
                <div className="store-report-row" key={store.storeId}>
                  <span><strong>{store.storeName}</strong><small>{store.transactions} transaksi · {store.return_transactions} retur</small></span>
                  <b>{rupiah.format(Number(store.revenue))}</b>
                  <b className="returned-amount">{rupiah.format(Number(store.returned_total))}</b>
                  <b>{rupiah.format(Number(store.net_revenue))}</b>
                </div>
              ))}
            </section>
            <section className="store-report-list payment-report-list">
              <h2>Rincian metode pembayaran</h2>
              <div className="store-report-header"><span>METODE</span><span>KOTOR</span><span>RETUR</span><span>BERSIH</span></div>
              {(report?.payment_methods ?? []).map((payment) => (
                <div className="store-report-row" key={payment.method}>
                  <span><strong>{paymentLabel(payment.method)}</strong></span>
                  <b>{rupiah.format(payment.revenue)}</b>
                  <b className="returned-amount">{rupiah.format(payment.returned_total)}</b>
                  <b>{rupiah.format(payment.net_revenue)}</b>
                </div>
              ))}
              {!report?.payment_methods?.length && <p>Belum ada pembayaran pada rentang tanggal ini.</p>}
            </section>
            <section className="store-report-list shift-history">
              <h2>Riwayat shift kasir</h2>
              <div className="store-report-header"><span>WAKTU / STATUS</span><span>KAS SEHARUSNYA</span><span>KAS AKTUAL</span><span>SELISIH</span></div>
              {shifts.map((item) => (
                <div className="store-report-row" key={item.id}>
                  <span><strong>{formatDateTime(item.openedAt)}</strong><small>{item.status === "closed" ? `Ditutup ${formatDateTime(item.closedAt)}` : "Masih berjalan"}</small></span>
                  <b>{rupiah.format(item.expectedCash)}</b>
                  <b>{item.closingCash === null ? "—" : rupiah.format(item.closingCash)}</b>
                  <b className={item.difference < 0 ? "returned-amount" : ""}>{item.difference === null ? "—" : rupiah.format(item.difference)}</b>
                </div>
              ))}
              {!shifts.length && <p>Belum ada shift pada rentang tanggal ini.</p>}
            </section>
            <div className="report-note"><Sparkles size={17} /><span><strong>Ringkasan penjualan</strong><br />Retur mengurangi pendapatan pada tanggal retur diproses. Ekspor CSV mengikuti rentang dan toko yang dipilih.</span></div>
          </div>
        )}

        {activeTab === "Transaksi" && (
          <section className="inventory-card">
            <div className="inventory-toolbar history-toolbar">
              <div><h2>Riwayat transaksi</h2><p>Menampilkan maksimal 100 transaksi pada rentang tanggal terpilih.</p></div>
              <label className="search-field"><Search size={17} /><input aria-label="Cari transaksi" placeholder="Cari kode transaksi atau produk..." value={transactionSearch} onChange={(event) => setTransactionSearch(event.target.value)} /></label>
            </div>
            <div className="table-scroll">
              <table>
                <thead><tr><th>KODE / WAKTU</th><th>PRODUK</th><th>METODE BAYAR</th><th>KOTOR</th><th>RETUR</th><th>BERSIH</th><th>STATUS</th><th>AKSI</th></tr></thead>
                <tbody>
                  {sales.map((sale) => (
                    <tr key={sale.id}>
                      <td><span className="table-sale-cell"><strong>#{sale.id.slice(-6).toUpperCase()}</strong><small className="table-subtext">{formatDateTime(sale.createdAt)}</small></span></td>
                      <td>{sale.items.map((item) => `${item.productName} × ${item.quantity}`).join(", ")}</td>
                      <td>{sale.payments.map((payment) => paymentLabel(payment.method)).join(" + ")}</td>
                      <td>{rupiah.format(sale.total)}</td>
                      <td>{rupiah.format(sale.returnedTotal)}</td>
                      <td><strong>{rupiah.format(sale.netTotal)}</strong></td>
                      <td><span className={`table-category ${sale.status === "returned" ? "returned-status" : ""}`}>{sale.status === "returned" ? "Diretur penuh" : sale.status === "partially_returned" ? "Retur sebagian" : "Selesai"}</span></td>
                      <td><button className="print-button" onClick={() => {
                        setSelectedSale(sale);
                        setReturnQuantities(Object.fromEntries(sale.items.map((item) => [item.productId, 0])));
                        setReturnReason("");
                      }}>Rincian / retur</button></td>
                    </tr>
                  ))}
                  {!sales.length && <tr><td className="table-empty" colSpan="8">Tidak ada transaksi pada rentang tanggal ini.</td></tr>}
                </tbody>
              </table>
            </div>
          </section>
        )}

        {activeTab === "Toko" && user.role === "owner" && (
          <section className="inventory-card">
            <div className="inventory-toolbar"><div><h2>Daftar toko dan akun</h2><p>Nonaktifkan akses tanpa menghapus toko atau riwayat transaksinya.</p></div></div>
            <div className="store-management-list">
              {storeAccounts.map((store) => (
                <div className="store-management-row" key={store.id}>
                  <span className="store-avatar"><ShoppingBag size={16} /></span>
                  <span><strong>{store.name}</strong><small>{store.isPrimary ? `Toko utama · ${user.email}` : `${store.accountEmail} · ${store.active ? "Aktif" : "Nonaktif"}`}</small></span>
                  {store.isPrimary
                    ? <span className="table-category">UTAMA</span>
                    : (
                      <div className="store-account-actions">
                        <button className="secondary-button" onClick={() => { setResetPasswordStore(store); setBranchPassword(""); }}>Atur ulang password</button>
                        <button className="secondary-button" onClick={() => toggleStoreStatus(store)}>{store.active ? "Nonaktifkan" : "Aktifkan"}</button>
                      </div>
                    )}
                  {store.isPrimary && <button className="secondary-button" onClick={() => { setSelectedStoreId(store.id); setActiveTab("Inventaris"); }}>Kelola</button>}
                </div>
              ))}
            </div>
          </section>
        )}

        {activeTab === "Akun" && (
          <div className="account-settings">
            <section className="inventory-card">
              <div className="inventory-toolbar"><div><h2>Ganti password</h2><p>Perubahan password akan mengeluarkan sesi akun lain.</p></div></div>
              <form className="account-form" onSubmit={changeOwnPassword}>
                <label>Password saat ini<input required type="password" autoComplete="current-password" value={passwordForm.currentPassword} onChange={(event) => setPasswordForm({ ...passwordForm, currentPassword: event.target.value })} /></label>
                <label>Password baru<input required type="password" autoComplete="new-password" minLength="12" value={passwordForm.newPassword} onChange={(event) => setPasswordForm({ ...passwordForm, newPassword: event.target.value })} /></label>
                <label>Ulangi password baru<input required type="password" autoComplete="new-password" minLength="12" value={passwordForm.confirmPassword} onChange={(event) => setPasswordForm({ ...passwordForm, confirmPassword: event.target.value })} /></label>
                <button className="primary-button" type="submit">Ganti password</button>
              </form>
            </section>
            <section className="inventory-card backup-card">
              <div className="inventory-toolbar"><div><h2>Ekspor cadangan data</h2><p>File JSON berisi produk, transaksi, retur, pergerakan stok, dan shift; tanpa hash password atau token sesi.</p></div></div>
              <div className="backup-actions">
                <button className="secondary-button" onClick={() => downloadBackup(false)}><ArrowDownToLine size={16} /> Unduh cadangan toko ini</button>
                {user.role === "owner" && <button className="primary-button" onClick={() => downloadBackup(true)}><ArrowDownToLine size={16} /> Unduh semua toko</button>}
              </div>
            </section>
          </div>
        )}

        <footer className="footer-note"><span>© {new Date().getFullYear()} KasirKu</span><span>Dibuat untuk bisnis yang terus bertumbuh <span className="heart">♥</span></span></footer>
      </main>

      {showProductForm && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowProductForm(false); }}>
          <form className="product-modal" onSubmit={saveProduct}>
            <div className="modal-heading"><div><span className="modal-icon"><Boxes size={19} /></span><div><h2>{editingProduct ? "Edit produk" : "Tambah produk"}</h2><p>Produk hanya tersedia di toko yang sedang dipilih.</p></div></div><button type="button" className="icon-button" onClick={() => { setShowProductForm(false); setEditingProduct(null); }} aria-label="Tutup"><X size={19} /></button></div>
            <label>Nama produk<input required autoFocus placeholder="Contoh: Kopi susu 250ml" value={productForm.name} onChange={(event) => setProductForm({ ...productForm, name: event.target.value })} /></label>
            <div className="form-row">
              <label>Kategori<input placeholder="Contoh: Minuman" value={productForm.category} onChange={(event) => setProductForm({ ...productForm, category: event.target.value })} /></label>
              <label>Harga jual (Rp)<input required type="number" min="0" step="1" placeholder="15000" value={productForm.price} onChange={(event) => setProductForm({ ...productForm, price: event.target.value })} /></label>
            </div>
            <div className="form-row">
              <label>{editingProduct ? "Stok saat ini" : "Stok awal"}<input required type="number" min="0" step="1" placeholder="24" value={productForm.stock} disabled={Boolean(editingProduct)} onChange={(event) => setProductForm({ ...productForm, stock: event.target.value })} /></label>
              <label>Batas stok minimum<input required type="number" min="0" step="1" value={productForm.lowStockThreshold} onChange={(event) => setProductForm({ ...productForm, lowStockThreshold: event.target.value })} /></label>
            </div>
            <label>Barcode <span className="optional">(opsional)</span><input inputMode="numeric" placeholder="Kosongkan untuk dibuat otomatis" value={productForm.barcode} onChange={(event) => setProductForm({ ...productForm, barcode: event.target.value })} /></label>
            {editingProduct && <div className="barcode-hint"><Boxes size={16} /><span>Gunakan menu Stok untuk mencatat stok masuk atau penyesuaian beserta alasannya.</span></div>}
            <div className="barcode-hint"><Sparkles size={16} /><span>Barcode kosong? Kami buatkan barcode unik yang siap dipindai dan dicetak.</span></div>
            <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => { setShowProductForm(false); setEditingProduct(null); }}>Batal</button><button type="submit" className="primary-button"><Plus size={16} /> {editingProduct ? "Simpan perubahan" : "Simpan produk"}</button></div>
          </form>
        </div>
      )}

      {stockProduct && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setStockProduct(null); }}>
          <section className="product-modal stock-modal" role="dialog" aria-modal="true" aria-labelledby="stock-title">
            <div className="modal-heading">
              <div><span className="modal-icon"><Boxes size={19} /></span><div><h2 id="stock-title">Pergerakan stok</h2><p>{stockProduct.name} · stok saat ini {stockProduct.stock}</p></div></div>
              <button type="button" className="icon-button" onClick={() => setStockProduct(null)} aria-label="Tutup pergerakan stok"><X size={19} /></button>
            </div>
            <form onSubmit={saveStockMovement}>
              <label>Jenis pergerakan
                <select value={stockForm.type} onChange={(event) => setStockForm({ ...stockForm, type: event.target.value })}>
                  <option value="in">Stok masuk</option>
                  <option value="adjustment">Penyesuaian stok</option>
                </select>
              </label>
              {stockForm.type === "adjustment" && (
                <label>Arah penyesuaian
                  <select value={stockForm.direction} onChange={(event) => setStockForm({ ...stockForm, direction: event.target.value })}>
                    <option value="increase">Tambah stok</option>
                    <option value="decrease">Kurangi stok</option>
                  </select>
                </label>
              )}
              <label>Jumlah<input required type="number" min="1" step="1" value={stockForm.quantity} onChange={(event) => setStockForm({ ...stockForm, quantity: event.target.value })} /></label>
              <label>Alasan<input required maxLength="200" value={stockForm.reason} onChange={(event) => setStockForm({ ...stockForm, reason: event.target.value })} placeholder="Contoh: restock dari pemasok" /></label>
              <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setStockProduct(null)}>Tutup</button><button type="submit" className="primary-button">Simpan pergerakan</button></div>
            </form>
            <div className="movement-history">
              <h3>Riwayat stok pada tanggal terpilih</h3>
              {stockMovements.map((movement) => (
                <div className="movement-row" key={movement.id}>
                  <span><strong>{movement.productName}</strong><small>{formatDateTime(movement.createdAt)} · {movement.reason}</small></span>
                  <b className={movement.quantity < 0 ? "movement-out" : ""}>{movement.quantity > 0 ? "+" : ""}{movement.quantity}</b>
                </div>
              ))}
              {!stockMovements.length && <p>Belum ada pergerakan stok pada rentang tanggal terpilih.</p>}
            </div>
          </section>
        </div>
      )}

      {selectedSale && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setSelectedSale(null); }}>
          <form className="product-modal return-modal" onSubmit={submitReturn}>
            <div className="modal-heading">
              <div><span className="modal-icon"><CreditCard size={19} /></span><div><h2>Transaksi #{selectedSale.id.slice(-6).toUpperCase()}</h2><p>{formatDateTime(selectedSale.createdAt)} · {selectedSale.status === "returned" ? "Sudah diretur penuh" : selectedSale.status === "partially_returned" ? "Retur sebagian" : "Selesai"}</p></div></div>
              <button type="button" className="icon-button" onClick={() => setSelectedSale(null)} aria-label="Tutup detail transaksi"><X size={19} /></button>
            </div>
            <div className="return-items">
              {selectedSale.items.map((item) => {
                const remaining = item.quantity - item.returnedQuantity;
                return (
                  <div className="return-item" key={item.productId}>
                    <span><strong>{item.productName}</strong><small>{item.returnedQuantity} dari {item.quantity} sudah diretur · {rupiah.format(item.unitPrice)} / unit</small></span>
                    <label>Retur<input aria-label={`Jumlah retur ${item.productName}`} type="number" min="0" max={remaining} step="1" disabled={!remaining || !shift} value={returnQuantities[item.productId] ?? 0} onChange={(event) => setReturnQuantities({ ...returnQuantities, [item.productId]: event.target.value })} /></label>
                  </div>
                );
              })}
            </div>
            {selectedSale.items.some((item) => item.quantity > item.returnedQuantity) && (
              <>
                <button type="button" className="text-button select-all-returns" onClick={() => setReturnQuantities(Object.fromEntries(selectedSale.items.map((item) => [item.productId, item.quantity - item.returnedQuantity])))}>Pilih seluruh sisa barang</button>
                <label>Alasan retur<input required maxLength="200" value={returnReason} onChange={(event) => setReturnReason(event.target.value)} placeholder="Contoh: barang rusak" /></label>
                {!shift && <p className="shift-required-note">Buka shift kasir untuk memproses retur.</p>}
                <p className="payment-manual-note">Pengembalian dana dicatat ke metode pembayaran asal; proses transfer/QRIS dilakukan di luar aplikasi.</p>
              </>
            )}
            {selectedSale.returns.length > 0 && (
              <div className="return-history">
                <h3>Retur tercatat · total {rupiah.format(selectedSale.returnedTotal)}</h3>
                {selectedSale.returns.map((entry) => (
                  <p key={entry.id}>{formatDateTime(entry.createdAt)} · {entry.reason} · {rupiah.format(entry.amount)} ({entry.payments.map((payment) => `${paymentLabel(payment.method)} ${rupiah.format(payment.amount)}`).join(", ")})</p>
                ))}
              </div>
            )}
            <div className="return-total">
              <span>Total transaksi</span><strong>{rupiah.format(selectedSale.total)}</strong>
              <span>Metode bayar</span><strong>{selectedSale.payments.map((payment) => `${paymentLabel(payment.method)} ${rupiah.format(payment.amount)}`).join(" + ")}</strong>
              <span>Uang diterima</span><strong>{rupiah.format(selectedSale.paid)}</strong>
              <span>Kembalian</span><strong>{rupiah.format(selectedSale.change)}</strong>
              <span>Setelah retur</span><strong>{rupiah.format(selectedSale.netTotal)}</strong>
            </div>
            <div className="modal-actions">
              <button type="button" className="secondary-button" onClick={() => setSelectedSale(null)}>Tutup</button>
              {selectedSale.items.some((item) => item.quantity > item.returnedQuantity) && <button className="primary-button" type="submit" disabled={!shift}>Proses retur</button>}
            </div>
          </form>
        </div>
      )}

      {showStoreForm && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setShowStoreForm(false); }}>
          <form className="product-modal" onSubmit={createStore}>
            <div className="modal-heading"><div><span className="modal-icon"><Smartphone size={19} /></span><div><h2>Tambah toko</h2><p>Buat cabang dengan akun admin terpisah.</p></div></div><button type="button" className="icon-button" onClick={() => setShowStoreForm(false)} aria-label="Tutup"><X size={19} /></button></div>
            <label>Nama toko<input required autoFocus placeholder="Contoh: Toko Berkah 2" value={storeForm.name} onChange={(event) => setStoreForm({ ...storeForm, name: event.target.value })} /></label>
            <label>Email admin cabang<input required type="email" autoComplete="email" placeholder="admin@toko.com" value={storeForm.email} onChange={(event) => setStoreForm({ ...storeForm, email: event.target.value })} /></label>
            <label>Password awal admin<input required type="password" autoComplete="new-password" minLength="12" placeholder="Minimal 12 karakter" value={storeForm.password} onChange={(event) => setStoreForm({ ...storeForm, password: event.target.value })} /></label>
            <div className="barcode-hint"><AlertCircle size={16} /><span>Simpan password awal dengan aman dan berikan langsung kepada admin cabang.</span></div>
            <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setShowStoreForm(false)}>Batal</button><button type="submit" className="primary-button"><Plus size={16} /> Buat toko</button></div>
          </form>
        </div>
      )}

      {resetPasswordStore && (
        <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setResetPasswordStore(null); }}>
          <form className="product-modal" onSubmit={resetBranchPassword}>
            <div className="modal-heading"><div><span className="modal-icon"><Wallet size={19} /></span><div><h2>Atur ulang password</h2><p>{resetPasswordStore.accountEmail} · sesi lama akan berakhir.</p></div></div><button type="button" className="icon-button" onClick={() => setResetPasswordStore(null)} aria-label="Tutup atur ulang password"><X size={19} /></button></div>
            <label>Password sementara<input required autoFocus type="password" autoComplete="new-password" minLength="12" value={branchPassword} onChange={(event) => setBranchPassword(event.target.value)} placeholder="Minimal 12 karakter" /></label>
            <div className="barcode-hint"><AlertCircle size={16} /><span>Berikan password baru secara langsung dan aman kepada admin toko.</span></div>
            <div className="modal-actions"><button type="button" className="secondary-button" onClick={() => setResetPasswordStore(null)}>Batal</button><button type="submit" className="primary-button">Atur ulang</button></div>
          </form>
        </div>
      )}

      {showCameraScanner && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setShowCameraScanner(false);
          }}
        >
          <section className="camera-modal" role="dialog" aria-modal="true" aria-labelledby="camera-title">
            <div className="modal-heading">
              <div>
                <span className="modal-icon"><Camera size={19} /></span>
                <div><h2 id="camera-title">Scan dengan kamera</h2><p>Arahkan kamera belakang ke barcode produk.</p></div>
              </div>
              <button type="button" className="icon-button" onClick={() => setShowCameraScanner(false)} aria-label="Tutup pemindai"><X size={19} /></button>
            </div>
            <div className="camera-view">
              <video ref={cameraScanner.videoRef} autoPlay muted playsInline />
              {!cameraScanner.error && <div className="camera-frame"><span /></div>}
              {cameraScanner.error && <div className="camera-error"><AlertCircle size={23} /><span>{cameraScanner.error}</span></div>}
            </div>
            <p className="camera-instructions">Pastikan barcode terlihat jelas, tidak silau, dan berada di dalam kotak.</p>
            {cameraScanner.error && (
              <button className="primary-button camera-retry" onClick={cameraScanner.retry}>
                <Camera size={16} /> Coba lagi
              </button>
            )}
          </section>
        </div>
      )}

      {showPairing && remoteSession && (
        <div className="modal-backdrop" onMouseDown={(event) => {
          if (event.target === event.currentTarget) setShowPairing(false);
        }}>
          <section className="pairing-modal" role="dialog" aria-modal="true" aria-labelledby="pairing-title">
            <div className="modal-heading">
              <div>
                <span className="modal-icon"><Smartphone size={19} /></span>
                <div><h2 id="pairing-title">Hubungkan kamera HP</h2><p>Buka pemindai di HP menggunakan QR ini.</p></div>
              </div>
              <button className="icon-button" onClick={() => setShowPairing(false)} aria-label="Tutup QR"><X size={19} /></button>
            </div>
            <div className="pairing-qr"><QRCodeSVG value={pairingUrl} size={200} level="M" /></div>
            <div className="pairing-steps">
              <span><b>1</b> Pastikan HP membuka aplikasi lewat HTTPS yang sama.</span>
              <span><b>2</b> Pindai QR dengan kamera bawaan HP, lalu izinkan akses kamera di halaman.</span>
              <span><b>3</b> Hasil scan akan masuk otomatis ke keranjang PC.</span>
            </div>
            <p className="pairing-expiry">Sesi berakhir otomatis dalam 30 menit.</p>
            <div className="modal-actions">
              <button className="secondary-button" onClick={() => setShowPairing(false)}>Tutup</button>
              <button className="primary-button" onClick={stopPhoneScanner}><X size={16} /> Akhiri sesi</button>
            </div>
          </section>
        </div>
      )}

      {printProduct && (
        <div className="print-area">
          <strong>{printProduct.name}</strong>
          <BarcodeGraphic value={printProduct.barcode} height={54} />
          <span>{rupiah.format(Number(printProduct.price))}</span>
        </div>
      )}
    </div>
  );
}

function LoginScreen({ onLogin, error, notice, loading }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  function submit(event) {
    event.preventDefault();
    onLogin(email, password);
  }

  return (
    <main className="login-page">
      <form className="login-card" onSubmit={submit}>
        <a className="brand login-brand" href="#" onClick={(event) => event.preventDefault()}>
          <span className="brand-mark"><ShoppingBag size={21} strokeWidth={2.5} /></span>
          <span>kasir<span className="brand-green">ku</span><small>POINT OF SALE</small></span>
        </a>
        <div className="login-heading"><h1>Selamat datang</h1><p>Masuk dengan akun toko untuk melanjutkan.</p></div>
        {notice && <div className="alert alert-success"><Check size={17} /><span>{notice}</span></div>}
        {error && <div className="alert alert-error"><AlertCircle size={17} /><span>{error}</span></div>}
        <label>Email<input type="email" autoComplete="username" required autoFocus placeholder="nama@toko.com" value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <label>Password<input type="password" autoComplete="current-password" required placeholder="Masukkan password" value={password} onChange={(event) => setPassword(event.target.value)} /></label>
        <button className="primary-button login-submit" disabled={loading}>{loading ? "Memeriksa..." : "Masuk"}</button>
        <p className="login-help">Akun cabang dibuat oleh pemilik toko utama.</p>
      </form>
    </main>
  );
}

function App() {
  const [user, setUser] = useState(null);
  const [checkingSession, setCheckingSession] = useState(true);
  const [loginLoading, setLoginLoading] = useState(false);
  const [loginError, setLoginError] = useState("");
  const [loginNotice, setLoginNotice] = useState("");

  useEffect(() => {
    let active = true;
    request("/api/auth/me")
      .then(({ user: currentUser }) => {
        if (active) setUser(currentUser);
      })
      .catch((error) => {
        if (active && error.status !== 401) setLoginError(error.message);
      })
      .finally(() => {
        if (active) setCheckingSession(false);
      });
    return () => { active = false; };
  }, []);

  async function login(email, password) {
    setLoginLoading(true);
    setLoginError("");
    setLoginNotice("");
    try {
      const { user: authenticatedUser } = await request("/api/auth/login", {
        method: "POST",
        body: JSON.stringify({ email, password }),
      });
      setUser(authenticatedUser);
    } catch (error) {
      setLoginError(error.message);
    } finally {
      setLoginLoading(false);
    }
  }

  const logout = useCallback(async (notice = "") => {
    try {
      await request("/api/auth/logout", { method: "POST" });
      setUser(null);
      setLoginError("");
      setLoginNotice(notice);
    } catch (error) {
      setLoginError(error.message);
    }
  }, []);

  if (checkingSession) {
    return <main className="login-page"><p className="login-loading">Memeriksa sesi akun...</p></main>;
  }
  if (!user) return <LoginScreen onLogin={login} error={loginError} notice={loginNotice} loading={loginLoading} />;
  return <CashierApp key={user.id} user={user} onLogout={logout} />;
}

export default App;
