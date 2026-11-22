# KasirKu

KasirKu adalah aplikasi Point of Sale (POS) modern berbasis web yang dibangun dengan React, Vite, Tailwind CSS, dan Firebase Firestore & Auth. Dirancang khusus untuk mengelola operasional toko ritel tunggal maupun multi-cabang dengan fitur pemindaian barcode, manajemen inventaris, shift kasir, laporan keuangan, grafik tren pendapatan (Recharts), serta pencetakan resi / ekspor PDF nota yang elegan.

## Fitur Utama

1. **Point of Sale (POS) & Pembayaran Fleksibel**:
   - Keranjang belanja cepat dengan dukungan pencarian produk dan pemindai barcode.
   - Metode pembayaran Tunai (dengan kalkulator kembalian), QRIS, Transfer, dan Pembayaran Campuran (Mixed).
   - Cetak struk belanja / resi instan dan unduh nota format PDF dengan tampilan profesional dan elegan.

2. **Pemindai Barcode Multi-Mode**:
   - Pemindaian langsung menggunakan kamera perangkat (mendukung kamera depan/belakang).
   - Integrasi scanner USB / Bluetooth bertindak sebagai keyboard.
   - **Remote Scanner via HP**: Ubah smartphone menjadi pemindai barcode jarak jauh dengan menghubungkan perangkat via QR pairing. Sesi tetap aktif secara berkelanjutan dan mendukung kamera depan dengan pratinjau yang disesuaikan (*mirrored*).

3. **Manajemen Produk & Inventaris**:
   - Tambah dan edit produk dengan generator barcode otomatis atau pemindaian langsung via kamera/remote scanner.
   - Pengelolaan stok masuk, stok minimum, peringatan stok menipis, dan pengarsipan produk.

4. **Multi-Store & Cabang**:
   - Manajemen toko utama dan toko cabang.
   - Pengaturan penyuntingan nama dan detail toko utama maupun cabang secara fleksibel.
   - Pemilik dapat melihat laporan per cabang atau gabungan seluruh cabang.

5. **Shift Kasir & Laporan Keuangan (Recharts)**:
   - Buka dan tutup shift kasir dengan pencatatan modal awal dan kas aktual.
   - Dashboard laporan lengkap dengan grafik tren pendapatan harian menggunakan Recharts dan rentang waktu cepat ("Hari ini", "7 hari", "30 hari").
   - Riwayat transaksi dan retur barang (sebagian atau penuh) dengan penyesuaian otomatis stok dan pendapatan.

## Menjalankan Aplikasi

1. Pasang dependensi dengan menjalankan:
   ```bash
   npm install
   ```
2. Jalankan server pengembangan lokal (development server):
   ```bash
   npm run dev
   ```
3. Buka URL yang ditampilkan oleh Vite di browser Anda (biasanya `http://localhost:3000`).
4. Untuk menjalankan unit test:
   ```bash
   npm test
   ```
5. Untuk membangun aplikasi untuk produksi:
   ```bash
   npm run build
   ```

## Arsitektur & Keamanan
- **Frontend**: React SPA dengan Vite dan styling Tailwind CSS.
- **Database & Auth**: Google Firebase (Firestore untuk penyimpanan data real-time dan Firebase Authentication untuk login aman).
- **Grafik & Visualisasi**: Recharts untuk analisis tren pendapatan.
- **Pencetakan**: Print dialog native dengan optimasi tata letak `@media print` untuk resi thermal 58mm/80mm maupun pratinjau PDF.
