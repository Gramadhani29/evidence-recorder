# QA Evidence Recorder v1.9.0

## Stabilitas v1.9.0

- Mutasi Review (rename, reorder, delete, clear, dan undo) diserialkan melalui background agar aman ketika recorder aktif.
- Delete bersifat recoverable dengan tombol **Undo** selama 10 detik; sampah lama dibersihkan otomatis.
- Capture melaporkan keberhasilan/kegagalan nyata, mencatat diagnostik, dan melewati duplikat berdasarkan interaction/phase serta fingerprint gambar.
- Satu aksi tidak lagi menghasilkan dua screenshot pre-action (`click` + `pre-action`); pasangan aksi dan result tetap dipertahankan.
- Payload gambar dipisah dari metadata IndexedDB, screenshot baru disimpan sebagai `Blob`, dan thumbnail dimuat secara lazy.
- Koordinat anotasi dari iframe direlay dan diterjemahkan ke viewport tab utama.
- Log terbaru dapat diunduh dari tombol **Log Diagnostik** pada popup.

## Verifikasi developer

```powershell
npm test
npm run check
```

Patch fokus untuk workspace Review / UAT:

## Perubahan utama
- **Catatan Step dipindah ke toolbar atas** agar area footer lebih lega dan hint pintasan tidak terpotong.
- **Free Text Tool (`+ Teks` / shortcut `T`)**: bisa memberi arahan tanpa harus membuat kotak terlebih dahulu.
- **Label kotak bisa digeser**: teks seperti `cekcek` sekarang bisa dipindahkan di sekitar kotak dengan drag langsung pada labelnya.
- **Palet warna diperbanyak** untuk kotak dan free text.
- **Blur transparan**: area blur menggunakan efek seperti kamera blur, bukan fill hitam solid.
- Tetap memakai **Unified Multi-TC Review Workspace** sehingga semua TC ada dalam satu halaman review.

## Cara pakai tambahan
- Tekan **T** lalu klik pada gambar untuk menambahkan free text.
- Pilih kotak, isi teks label di toolbar, lalu **drag label** untuk memindahkan posisinya.
- Tekan **B** lalu drag area untuk membuat blur transparan.

## Catatan
- Patch ini terutama mengubah `review.html`, `review.css`, dan `review.js`.
- Data TC/session tetap memakai struktur sebelumnya.

- Free text sekarang tanpa background; hanya teks berwarna di atas screenshot.
