import sys
from fpdf import FPDF, HTMLMixin

class PDF(FPDF, HTMLMixin):
    pass

def generate_pdf():
    html = """
    <h1>Panduan Penggunaan JagatAudio</h1>
    <p>Selamat datang di panduan penggunaan aplikasi <strong>JagatAudio - AI Stem Separation & Karaoke</strong>. Aplikasi ini dirancang untuk memudahkan Anda memisahkan instrumen musik, membuat trek karaoke, dan masih banyak lagi.</p>

    <h2>1. Login dan Registrasi</h2>
    <ul>
        <li>Buka aplikasi JagatAudio.</li>
        <li>Jika Anda belum memiliki akun, klik <strong>Daftar Akun Baru</strong>, masukkan Username, Email, dan Password, lalu klik <strong>Daftar</strong>.</li>
        <li>Jika Anda sudah memiliki akun, masukkan Username dan Password Anda, lalu klik <strong>Login</strong>.</li>
    </ul>

    <h2>2. Aktivasi Lisensi</h2>
    <p>Agar dapat menggunakan fitur, pastikan lisensi Anda aktif:</p>
    <ul>
        <li>Klik bagian <strong>Aktivasi Lisensi</strong> jika aplikasi masih terkunci.</li>
        <li>Klik tombol atau <em>Drag & Drop</em> untuk mengunggah <strong>File Lisensi (.lic)</strong> Anda.</li>
        <li>Setelah divalidasi, sistem akan menampilkan "Lisensi Aktif".</li>
    </ul>
    
    <h2>3. Fitur Utama: Pemisahan AI (Stem Separator)</h2>
    <p>Fitur ini digunakan untuk memisahkan lagu (MP3/WAV) menjadi 6 bagian terpisah (Vokal, Drum, Bass, Gitar, Piano, dan Lainnya).</p>
    <h3>A. Cara Mengunggah dan Memproses Lagu:</h3>
    <ul>
        <li>Pilih tab <strong>Stem Separator</strong> di bagian atas layar.</li>
        <li>Klik kotak <strong>Upload atau Tarik file MP3/WAV kesini</strong> dan pilih file lagu Anda.</li>
        <li>Klik tombol <strong>Mulai Pemisahan AI</strong> (Warna Biru).</li>
        <li>Tunggu hingga proses AI selesai 100%. Setelah selesai, lagu akan dimuat ke dalam <em>Mixer Player</em>.</li>
    </ul>
    
    <h3>B. Menggunakan Mixer Player:</h3>
    <ul>
        <li><strong>Play/Pause:</strong> Gunakan tombol Play untuk memutar lagu.</li>
        <li><strong>Volume & Mute:</strong> Setiap instrumen (Vokal, Drum, dll.) memiliki penggeser volume dan tombol mute (ikon speaker). Anda bisa membisukan suara vokal untuk membuat versi karaoke.</li>
        <li><strong>Pengaturan Nada (Pitch):</strong> Anda dapat menaikkan atau menurunkan nada lagu (-12 hingga +12).</li>
        <li><strong>Pengaturan Tempo:</strong> Anda dapat mempercepat atau memperlambat lagu (0.5x hingga 2.0x).</li>
        <li><strong>Ekspor Mix:</strong> Jika setelan audio sudah pas, klik tombol <strong>Ekspor Mix ke MP3</strong> untuk mengunduh lagu hasil pengaturan Anda.</li>
    </ul>

    <h2>4. Fitur YouTube to MP3 & Karaoke</h2>
    <p>Anda bisa langsung memproses video YouTube tanpa perlu repot mengunduh lagunya terlebih dahulu.</p>
    <ul>
        <li>Pilih tab <strong>YouTube to MP3</strong>.</li>
        <li>Masukkan <strong>Link YouTube</strong> dari lagu yang Anda inginkan.</li>
        <li>Pilih <strong>Mode Pemrosesan</strong>:
            <ul>
                <li><em>Download Audio Only:</em> Hanya mengunduh audio.</li>
                <li><em>Quick Karaoke:</em> Pemisahan vokal super cepat dengan kualitas standar.</li>
                <li><em>Full Separation:</em> Pemisahan 6 instrumen mendalam (kualitas terbaik, memakan waktu lebih lama).</li>
            </ul>
        </li>
        <li>Klik <strong>Proses URL</strong>. Tunggu hingga proses selesai untuk mulai mendengarkan atau mengunduh.</li>
    </ul>

    <h2>5. Fitur Cari Tab Online</h2>
    <p>Anda dapat mencari <em>chord</em> atau tabulatur gitar langsung dari internet.</p>
    <ul>
        <li>Pilih lagu lalu klik tombol <strong>Cari Tab Online</strong> (warna Oranye).</li>
        <li>Masukkan judul lagu dan nama artis pada kolom pencarian.</li>
        <li>Klik <strong>Cari Tab</strong>. Tabulatur akan ditampilkan di layar.</li>
        <li>Anda dapat mengklik <strong>Download Text</strong> untuk menyimpannya sebagai file <code>.txt</code>.</li>
    </ul>

    <h3>Tips Tambahan:</h3>
    <p>Pastikan perangkat komputer Anda terhubung ke internet saat menggunakan fitur pencarian tab dan fitur YouTube. Proses pemisahan lagu sepenuhnya menggunakan kemampuan komputer Anda (AI Lokal), sehingga lamanya waktu proses bergantung pada spesifikasi komputer.</p>
    """
    
    pdf = PDF()
    pdf.add_page()
    pdf.write_html(html)
    pdf.output("Panduan_Penggunaan_Customer.pdf")

if __name__ == "__main__":
    generate_pdf()
