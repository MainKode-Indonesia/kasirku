import { useEffect, useRef, useState } from "react";

export function useCameraScanner(active, onScan, options = true) {
  const stopOnScan = typeof options === "boolean" ? options : (options?.stopOnScan ?? true);
  const facingMode = typeof options === "object" && options?.facingMode ? options.facingMode : "environment";
  const videoRef = useRef(null);
  const onScanRef = useRef(onScan);
  const lastScannedRef = useRef("");
  const lastScanTimeRef = useRef(0);
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
        const reader = new BrowserMultiFormatReader(undefined, { delayBetweenScanAttempts: 400 });
        reader.possibleFormats = [
          BarcodeFormat.CODE_128,
          BarcodeFormat.EAN_8,
          BarcodeFormat.EAN_13,
          BarcodeFormat.ITF,
          BarcodeFormat.UPC_A,
          BarcodeFormat.UPC_E,
        ];
        controls = await reader.decodeFromConstraints(
          { video: { facingMode: { ideal: facingMode } } },
          videoRef.current,
          (result, _decodeError, scannerControls) => {
            if (!running || !result) return;
            const text = result.getText();
            if (stopOnScan) {
              if (hasScanned) return;
              hasScanned = true;
              scannerControls.stop();
              onScanRef.current(text);
            } else {
              const now = Date.now();
              if (text === lastScannedRef.current && now - lastScanTimeRef.current < 1500) {
                return;
              }
              lastScannedRef.current = text;
              lastScanTimeRef.current = now;
              onScanRef.current(text);
            }
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
  }, [active, attempt, stopOnScan, facingMode]);

  return {
    videoRef,
    error,
    retry: () => setAttempt((value) => value + 1),
  };
}
