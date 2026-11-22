import { useCallback, useEffect, useState } from "react";
import { onAuthStateChanged, signInWithPopup } from "firebase/auth";
import { AlertCircle, Barcode, Check, Camera, Smartphone } from "lucide-react";
import { auth, googleAuthProvider } from "./firebase.js";
import { submitRemoteScan } from "./firestoreService.js";
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
    });
    return () => unsubscribe();
  }, []);

  const sendBarcode = useCallback(async (barcode) => {
    setSending(true);
    setStatus("Mengirim barcode ke kasir...");
    try {
      await submitRemoteScan({
        storeId: credentials.storeId,
        sessionId: credentials.id,
        token: credentials.token,
        barcode,
      });
      setLastBarcode(barcode);
      setStatus("Barcode terkirim. Tekan tombol di bawah untuk scan berikutnya.");
      navigator.vibrate?.(80);
    } catch (sendError) {
      setError(sendError.message);
      setStatus("Tidak dapat mengirim barcode.");
    } finally {
      setSending(false);
      setActive(false);
    }
  }, [credentials]);

  const camera = useCameraScanner(active && !error && Boolean(firebaseUser), sendBarcode);
  const cameraError = camera.error;
  const canStart = Boolean(credentials.id && credentials.storeId && credentials.token && firebaseUser) && !error && !cameraError && !sending;

  function startScanning() {
    setError("");
    setStatus("Arahkan kamera ke barcode produk.");
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
    } catch (authError) {
      setError(authError.message || "Gagal masuk dengan Google.");
    }
  }

  return (
    <main className="remote-scanner-page">
      <header className="remote-scanner-brand">
        <span><Smartphone size={20} /></span>
        <strong>Kasir<span>Ku</span></strong>
        <small>PEMINDAI HP</small>
      </header>
      <section className="remote-scanner-card">
        <div className="remote-scanner-title">
          <span className="remote-scanner-icon"><Barcode size={22} /></span>
          <div><h1>Pemindai barcode</h1><p>Hasil scan dikirim langsung ke kasir PC.</p></div>
        </div>
        <div className="remote-camera-view">
          {active && <video ref={camera.videoRef} autoPlay muted playsInline />}
          {active && !cameraError && <div className="camera-frame"><span /></div>}
          {!active && !error && (
            <div className="remote-camera-placeholder">
              <Camera size={28} />
              <span>{firebaseUser ? "Kamera belum aktif" : "Masuk Google untuk memulai"}</span>
            </div>
          )}
          {(error || cameraError) && (
            <div className="camera-error"><AlertCircle size={23} /><span>{error || cameraError}</span></div>
          )}
        </div>
        <div className={`remote-scan-status ${error || cameraError ? "has-error" : ""}`}>
          {error || cameraError ? <AlertCircle size={16} /> : lastBarcode ? <Check size={16} /> : <span className="live-dot" />}
          <span>{error || cameraError || status}</span>
        </div>
        {lastBarcode && !error && <div className="remote-last-scan">Barcode terakhir <strong>{lastBarcode}</strong></div>}
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
            <Camera size={17} /> {active ? "Arahkan ke barcode" : lastBarcode ? "Scan barang berikutnya" : "Mulai scan"}
          </button>
        )}
        <p className="remote-help">Gunakan kamera belakang. Pastikan barcode berada di dalam kotak dan terlihat jelas.</p>
      </section>
      <footer className="remote-footer">Jangan tutup halaman ini selama digunakan.</footer>
    </main>
  );
}

export default RemoteScanner;
