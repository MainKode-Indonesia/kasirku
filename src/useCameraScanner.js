import { useEffect, useRef, useState } from "react";

export function useCameraScanner(active, onScan, stopOnScan = true) {
  const videoRef = useRef(null);
  const onScanRef = useRef(onScan);
  const [error, setError] = useState("");
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    onScanRef.current = onScan;
  }, [onScan]);

  useEffect(() => {
    if (!active) return undefined;
    let running = true;
    let controls;
    let hasScanned = false;

    if (!navigator.mediaDevices?.getUserMedia) {
      setError("Browser ini tidak menyediakan akses kamera. Buka aplikasi melalui HTTPS.");
      return undefined;
    }
    if (!window.isSecureContext) {
      setError("Kamera membutuhkan HTTPS. Alamat IP lokal dengan HTTP tidak diizinkan browser.");
      return undefined;
    }

    setError("");
    const startScanning = async () => {
      try {
        const { BarcodeFormat, BrowserMultiFormatReader } = await import("@zxing/browser");
        if (!running) return;
        const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 500 });
        reader.possibleFormats = [
          BarcodeFormat.CODE_128,
          BarcodeFormat.EAN_8,
          BarcodeFormat.EAN_13,
          BarcodeFormat.ITF,
          BarcodeFormat.UPC_A,
          BarcodeFormat.UPC_E,
        ];
        controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: "environment" } } },
          videoRef.current,
          (result, _decodeError, scannerControls) => {
            if (!running || hasScanned || !result) return;
            if (stopOnScan) {
              hasScanned = true;
              scannerControls.stop();
            }
            onScanRef.current(result.getText());
          },
        );
        if (!running) controls.stop();
      } catch (cameraError) {
        if (!running) return;
        if (cameraError.name === "NotAllowedError") {
          setError("Izin kamera ditolak. Izinkan kamera di browser lalu coba lagi.");
        } else if (cameraError.name === "NotFoundError") {
          setError("Kamera tidak ditemukan di perangkat ini.");
        } else if (cameraError.name === "NotReadableError") {
          setError("Kamera sedang digunakan aplikasi lain. Tutup aplikasi tersebut lalu coba lagi.");
        } else {
          setError(cameraError.message || "Kamera tidak dapat dibuka.");
        }
      }
    };

    startScanning();
    return () => {
      running = false;
      controls?.stop();
    };
  }, [active, attempt, stopOnScan]);

  return {
    videoRef,
    error,
    retry: () => setAttempt((value) => value + 1),
  };
}
