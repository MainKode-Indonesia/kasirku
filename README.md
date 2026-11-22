# KasirKu

Aplikasi kasir React dengan API Express dan MongoDB. Barcode bisa dipindai lewat kamera perangkat atau scanner USB/Bluetooth yang bertindak sebagai keyboard.

## Menjalankan aplikasi

1. Pastikan Node.js dan MongoDB Server berjalan. MongoDB Compass adalah GUI untuk mengelola server, bukan pengganti MongoDB Server.
2. Salin `.env.example` menjadi `.env`, lalu atur `MONGODB_URI` dan buat `JWT_SECRET` acak minimal 32 byte. Jangan gunakan secret contoh untuk deployment.
3. Pasang dependensi dengan `npm install`.
4. Buat akun pemilik utama dan pindahkan produk/transaksi lama ke toko utama dengan `npm run create-owner`. Jalankan sekali di terminal interaktif; email dan password tidak disimpan di source code.
5. Jalankan API dengan `npm run api` dan frontend di terminal lain dengan `npm run dev`.
6. Buka URL yang ditampilkan Vite dan masuk menggunakan akun pemilik.

Untuk menjalankan pengujian aturan domain kasir:

```bash
npm test
```

Default URI adalah `mongodb://127.0.0.1:27017/kasirku`. Menu Inventaris membuat barcode EAN-13 internal otomatis bila kolom barcode dibiarkan kosong. Barcode produk dapat dicetak sebagai label dari daftar inventaris. Transaksi menyimpan ringkasan dan item penjualan, lalu mengurangi stok produk.

Pemilik dapat membuat toko cabang beserta akun adminnya dari menu **Toko**. Setiap toko mempunyai produk, stok, dan laporan transaksi tersendiri. Hanya pemilik utama yang dapat berpindah toko atau memilih laporan semua toko. Penghapusan produk mengarsipkan produk tanpa menghapus riwayat penjualan.

## Operasional toko

- **Laporan:** pilih tanggal awal dan akhir (maksimal 366 hari), toko, atau semua toko untuk pemilik utama. Ekspor CSV mengikuti filter aktif. Retur mengurangi pendapatan pada tanggal retur diproses.
- **Riwayat transaksi dan retur:** cari transaksi berdasarkan kode atau nama produk, lihat detail, lalu masukkan jumlah dan alasan retur. Retur sebagian maupun seluruh sisa barang mengembalikan stok dan mengoreksi pendapatan.
- **Pergerakan stok:** stok awal, penjualan, retur, stok masuk, dan penyesuaian dicatat dengan perubahan jumlah dan alasan. Perubahan stok produk yang sudah ada hanya dapat dilakukan melalui menu **Stok**.
- **Shift kasir:** buka shift dengan kas awal sebelum transaksi atau retur. Saat tutup, masukkan kas aktual untuk membandingkannya dengan kas yang seharusnya; riwayat shift dan selisih tersedia pada laporan.
- **Stok minimum:** batas minimum dapat diatur per produk. Menu **Stok menipis** dan peringatan kasir menampilkan produk yang perlu direstock.
- **Akun:** pengguna dapat mengganti password dengan verifikasi password saat ini. Pemilik dapat mengatur ulang password admin cabang atau menonaktifkan/mengaktifkan cabang; cabang yang memiliki shift terbuka harus menutupnya dahulu.
- **Cadangan:** menu **Akun** mengunduh ekspor JSON per toko; pemilik juga dapat mengekspor semua toko. File berisi data operasional tetapi tidak berisi hash password atau token sesi. Ekspor ini tidak menyediakan pemulihan/import otomatis.
- **Pembayaran:** transaksi dapat dicatat sebagai tunai, QRIS, transfer, atau campuran. QRIS/transfer dikonfirmasi manual oleh kasir; aplikasi tidak menghubungkan payment gateway. Retur mencatat pengembalian sesuai metode asal, sedangkan pengiriman uang tetap dilakukan di luar aplikasi.

Login menggunakan cookie HTTP-only dan password bcrypt; pendaftaran mandiri tidak tersedia. Untuk deployment HTTPS, atur `NODE_ENV=production` dan `TRUST_PROXY=1` di belakang reverse proxy tepercaya. Endpoint API hanya bind ke loopback.

Pemindai kamera meminta izin kamera dan membutuhkan halaman HTTPS (atau `localhost`). Gunakan URL HTTPS dengan sertifikat tepercaya saat memindai dari HP.

Untuk memakai HP sebagai pemindai terpisah, buka kasir PC melalui URL HTTPS, pilih **Hubungkan HP**, lalu pindai QR dengan kamera bawaan HP. Halaman pemindai di HP akan mengirim barcode ke keranjang PC; setiap barang perlu satu tap untuk memulai pemindaian berikutnya. Sesi pairing kedaluwarsa otomatis setelah 30 menit.
"# kasirku" 
