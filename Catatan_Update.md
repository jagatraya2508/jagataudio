# Catatan Update Jagat Audio

**Versi:** 1.1  
**Tanggal:** 2 Juli 2026  
**Dari versi sebelumnya:** 1.0

Dokumen ini merangkum fitur baru, perbaikan, dan perubahan teknis pada Jagat Audio sejak rilis 1.0.

---

## Ringkasan

Update ini menambahkan **manajemen proyek**, **lirik karaoke sinkron (LRC)**, **tab MP3 Playlist**, **Audio Enhancer** di mixer, serta perbaikan ekspor dan performa pemisahan AI.

---

## Fitur Baru

### 1. Proyek Tersimpan (Stem Separator)

- Lagu yang sudah dipisah AI disimpan otomatis sebagai proyek — tidak perlu pemisahan ulang.
- Tab **Proyek Tersimpan** di halaman Stem Separator menampilkan daftar semua proyek siap pakai.
- Klik nama lagu untuk langsung membuka mixer.
- **Ubah nama proyek** langsung dari daftar atau dari panel studio.
- **Hapus proyek** (stem, file upload, dan metadata) dari daftar.
- Pengaturan mixer (volume, mute, pitch, tempo, EQ, compressor, sinkron lirik) **disimpan otomatis** per proyek dan dimuat kembali saat proyek dibuka.

### 2. Lirik Karaoke (Stem Separator & MP3 Playlist)

- Pencarian lirik otomatis dari internet via **LRCLIB** (format LRC sinkron & teks biasa).
- Panel **Lirik Karaoke** di samping mixer stem — lirik mengikuti waktu putar lagu.
- Dukungan **sinkron per kata** untuk file LRC yang memiliki timestamp per segmen.
- Penyesuaian **offset waktu** dan **kecepatan lirik** jika lirik tidak pas dengan audio.
- **Cari Lirik Manual** jika lirik otomatis salah atau tidak ditemukan — pilih dari daftar hasil pencarian.
- Lirik di-cache di server agar pemuatan berikutnya lebih cepat.

### 3. Tab MP3 Playlist (Baru)

- Tab baru **MP3 Playlist** untuk memutar koleksi MP3 dari satu folder.
- Pilih folder berisi file MP3 — aplikasi membuat playlist otomatis.
- Kontrol **Play/Pause**, **Sebelumnya/Berikutnya**, dan **seek bar**.
- Panel lirik karaoke untuk lagu yang sedang diputar (sama seperti di Stem Separator).
- **Auto-load** file `.lrc` / `.txt` dari folder jika sudah ada di samping file MP3.
- **Simpan lirik ke folder MP3** (Chrome/Edge dengan File System Access API) — file lirik tersimpan di folder yang sama dengan MP3.
- **Pitch shift** (-12 s/d +12 semitone) pada pemutar MP3 via Tone.js.
- Hapus lagu individual dari playlist tanpa menghapus file asli.

### 4. Audio Enhancer (Mixer Stem)

- Panel **Audio Enhancer** di studio mixer:
  - **EQ 3-band:** Bass, Mid, Treble (-12 s/d +12 dB)
  - **Compressor** on/off untuk mastering ringan
- Pengaturan ikut tersimpan ke metadata proyek.

### 5. Studio Mixer — Perbaikan UI

- Layout studio full-page dengan mixer + panel lirik berdampingan.
- **Timeline seek bar** pada pemutar stem studio.
- Tombol **Proyek Baru** untuk kembali ke halaman upload/proyek.
- Nama file ekspor menggunakan **nama proyek + " edit.mp3"** (bukan UUID acak).

---

## Perbaikan & Peningkatan

| Area | Perubahan |
|------|-----------|
| **Ekspor mix** | Nama file ekspor mengikuti nama proyek; perbaikan mixing agar durasi track terpanjang dipertahankan |
| **Demucs AI** | Preset MP3 diubah ke kualitas lebih cepat (preset 2) — pemisahan lebih ringan tanpa mengorbankan fungsionalitas |
| **YouTube to MP3** | Peningkatan alur audio dan pitch pada mode karaoke YouTube |
| **Responsif** | CSS studio, playlist, dan panel lirik dioptimalkan untuk berbagai ukuran layar |

---

## Perubahan Backend (API Baru)

| Endpoint | Fungsi |
|----------|--------|
| `GET /projects` | Daftar semua proyek tersimpan |
| `GET /projects/{file_id}` | Detail satu proyek |
| `PATCH /projects/{file_id}/name` | Ubah nama tampilan proyek |
| `PUT /projects/{file_id}/settings` | Simpan pengaturan mixer & lirik |
| `DELETE /projects/{file_id}` | Hapus proyek |
| `POST /lyrics/fetch` | Ambil lirik otomatis (dengan cache) |
| `POST /lyrics/search` | Cari kandidat lirik manual |
| `POST /lyrics/select` | Pilih & simpan lirik dari hasil pencarian |
| `GET /lyrics/download` | Unduh lirik yang sudah di-cache |

**File baru:** `backend/lyrics_fetcher.py` — modul pencarian & cache lirik (LRCLIB + fallback lyrics.ovh).

**Folder data baru:** `lyrics_cache/` — cache lirik per nama lagu.

---

## Cara Menggunakan Fitur Baru

### Membuka proyek lama
1. Buka tab **Stem Separator**.
2. Pilih sub-tab **Proyek Tersimpan**.
3. Klik nama lagu → mixer terbuka dengan pengaturan terakhir.

### Lirik karaoke di mixer
1. Setelah proyek terbuka, lirik otomatis dicari.
2. Jika salah, klik **Cari Lirik Manual**, isi penyanyi & judul, pilih dari daftar.
3. Geser **Offset** atau **Kecepatan** jika timing lirik tidak pas.

### MP3 Playlist
1. Buka tab **MP3 Playlist**.
2. Klik **Pilih Folder MP3** → pilih folder (gunakan Chrome/Edge untuk fitur simpan lirik).
3. Klik lagu di daftar untuk memutar; lirik muncul otomatis jika tersedia.

---

## Persyaratan & Catatan

- **Internet** diperlukan untuk pencarian lirik online dan fitur YouTube.
- **Simpan lirik ke folder MP3** membutuhkan browser Chromium (Chrome/Edge) dengan izin akses folder.
- Proyek tersimpan disimpan di folder data aplikasi (`%APPDATA%\JagatAudio`) — tidak hilang saat menutup aplikasi.
- Lisensi dan login tetap diperlukan seperti versi sebelumnya.

---

## File yang Diubah (Rilis 1.1)

- `backend/main.py` — API proyek, lirik, perbaikan ekspor
- `backend/lyrics_fetcher.py` — **baru**
- `frontend/src/App.jsx` — UI proyek, playlist, lirik karaoke, audio enhancer
- `frontend/src/index.css` — styling studio, playlist, panel lirik

---

*Jagat Audio — AI Stem Separation & Karaoke*
