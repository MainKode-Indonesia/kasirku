import { useCallback, useEffect, useState } from "react";
import { onAuthStateChanged, signInWithPopup } from "firebase/auth";
import { AlertCircle, Barcode, Check, Camera, Smartphone } from "lucide-react";
import { auth, googleAuthProvider } from "./firebase.js";
import { submitRemoteScan, subscribeScannerSession } from "./firestoreService.js";
import { useCameraScanner } from "./useCameraScanner.js";

function readPairingCredentials() {
  const params = new URLSearchParams(window.location.hash.slice(1));
  return {
    id: params.get("id") ?? "",
    storeId: params.get("storeId") ?? "",
    token: params.get("token") ?? "",
  };
}

function RemoteScanner() {
  const [credentials] = useState(readPairingCredentials);
  const [firebaseUser, setFirebaseUser] = useState(() => auth.currentUser);
  const [authReady, setAuthReady] = useState(false);
  const [active, setActive] = useState(false);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState(
    credentials.id && credentials.storeId && credentials.token
      ? ""
      : "Link pemindai tidak lengkap. Pindai QR dari layar kasir PC.",
  );
  const [status, setStatus] = useState("Siap dihubungkan ke kasir PC.");
  const [lastBarcode, setLastBarcode] = useState("");

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setFirebaseUser(user);
      setAuthReady(true);
      if (user && !error) {
        setActive(true);
      }
    });
    return () => unsubscribe();
  }, [error]);

  useEffect(() => {
    if (!firebaseUser || !credentials.id || !credentials.storeId) return undefined;
    const unsubscribe = subscribeScannerSession({
      storeId: credentials.storeId,
      sessionId: credentials.id,
      onEnded: () => {
        setActive(false);
        setError("Sesi pemindai telah diputus dari kasir. Pindai QR baru untuk menghubungkan lagi.");
        setStatus("Sesi pemindai berakhir.");
      },
      onError: () => {
        setActive(false);
        setError("Tidak dapat mengakses sesi pemindai. Pastikan akun Google sama dengan kasir.");
      },
    });
    return () => unsubscribe();
  }, [credentials.id, credentials.storeId, firebaseUser]);

  const sendBarcode = useCallback(async (barcode) => {
    setSending(true);
    setStatus(`Berhasil scan: ${barcode}. Mengirim ke PC...`);
    try {
      await submitRemoteScan({
        storeId: credentials.storeId,
        sessionId: credentials.id,
        token: credentials.token,
        barcode,
      });
      setLastBarcode(barcode);
      setStatus("Terkirim ke kasir PC! Arahkan barcode berikutnya.");
      navigator.vibrate?.(80);
    } catch (sendError) {
      setError(sendError.message);
      setStatus("Tidak dapat mengirim barcode.");
    } finally {
      setSending(false);
    }
  }, [credentials]);

  // Using back camera (environment) exclusively for sharpness & focus, acting purely as a camera feed
  const camera = useCameraScanner(active && !error && Boolean(firebaseUser), sendBarcode, { facingMode: "environment", stopOnScan: false });
  const cameraError = camera.error;
  const canStart = Boolean(credentials.id && credentials.storeId && credentials.token && firebaseUser) && !error && !cameraError;

  function startScanning() {
    setError("");
    setStatus("Kamera belakang aktif. Arahkan barcode ke dalam kotak.");
    setActive(true);
  }

  function retryCamera() {
    setError("");
    camera.retry();
  }

  async function signInGoogle() {
    setError("");
    try {
      await signInWithPopup(auth, googleAuthProvider);
      setActive(true);
    } catch (authError) {
      setError(authError.message || "Gagal masuk dengan Google.");
    }
  }

  return (
    <main className="remote-scanner-page">
      <header className="remote-scanner-brand">
        <span><Smartphone size={20} /></span>
        <strong>Kasir<span>Ku</span></strong>
        <small>KAMERA PEMINDAI HP</small>
      </header>
      <section className="remote-scanner-card">
        <div className="remote-scanner-title">
          <span className="remote-scanner-icon"><Barcode size={22} /></span>
          <div><h1>Kamera Belakang Aktif</h1><p>HP ditaruh di stand. Semua keranjang & transaksi dikelola di PC.</p></div>
        </div>

        <div className="remote-camera-view" style={{ minHeight: "260px" }}>
          {active && <video ref={camera.videoRef} autoPlay muted playsInline />}
          {active && !cameraError && <div className="camera-frame"><span /></div>}
          {!active && !error && (
            <div className="remote-camera-placeholder">
              <Camera size={28} />
              <span>{firebaseUser ? "Kamera siap diaktifkan" : "Masuk Google untuk memulai"}</span>
            </div>
          )}
          {(error || cameraError) && (
            <div className="remote-camera-error"><AlertCircle size={23} /><span>{error || cameraError}</span></div>
          )}
        </div>

        <div className={`remote-scan-status ${error || cameraError ? "has-error" : ""}`}>
          {error || cameraError ? <AlertCircle size={16} /> : lastBarcode ? <Check size={16} /> : <span className="live-dot" />}
          <span>{error || cameraError || status}</span>
        </div>

        {lastBarcode && !error && <div className="remote-last-scan">Barcode terakhir: <strong>{lastBarcode}</strong></div>}

        {authReady && !firebaseUser ? (
          <button className="primary-button remote-action-button" onClick={signInGoogle}>
            Masuk dengan Google
          </button>
        ) : error ? null : cameraError ? (
          <button className="primary-button remote-action-button" onClick={retryCamera}>
            <Camera size={17} /> Coba lagi
          </button>
        ) : (
          <button
            className="primary-button remote-action-button"
            disabled={!canStart}
            onClick={startScanning}
          >
            <Camera size={17} /> {active ? "Kamera Belakang Standby (Siap Scan)" : "Mulai Kamera Pemindai"}
          </button>
        )}
        <p className="remote-help">Menggunakan kamera belakang penuh untuk fokus tajam. Letakkan HP di stand, scan produk langsung masuk ke PC.</p>
      </section>
      <footer className="remote-footer">Sesi aktif terus selama belum diputus dari kasir PC.</footer>
    </main>
  );
}

export default RemoteScanner;
