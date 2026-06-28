import tkinter as tk
from tkinter import ttk, messagebox
import os
import sys

# Ensure backend directory is in path for imports
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

try:
    from license_manager import create_license, DURATION_MAP, HAS_CRYPTO
except ImportError as e:
    messagebox.showerror("Error", f"Gagal mengimpor modul license_manager.\nError: {e}")
    sys.exit(1)

class LicenseGeneratorApp:
    def __init__(self, root):
        self.root = root
        self.root.title("JagatAudio License Generator")
        self.root.geometry("450x350")
        self.root.resizable(False, False)
        
        # Style
        style = ttk.Style()
        style.configure("TLabel", font=("Segoe UI", 10))
        style.configure("TButton", font=("Segoe UI", 10, "bold"))
        style.configure("Header.TLabel", font=("Segoe UI", 14, "bold"))
        
        # Main Frame
        main_frame = ttk.Frame(self.root, padding="20")
        main_frame.pack(fill=tk.BOTH, expand=True)
        
        # Header
        ttk.Label(main_frame, text="🔑 Generator Lisensi JagatAudio", style="Header.TLabel").pack(pady=(0, 20))
        
        if not HAS_CRYPTO:
            ttk.Label(main_frame, text="ERROR: Modul 'cryptography' tidak terinstal!", foreground="red").pack()
            return
            
        # Form Frame
        form_frame = ttk.Frame(main_frame)
        form_frame.pack(fill=tk.X, expand=True)
        
        # Hardware ID
        ttk.Label(form_frame, text="Hardware ID Customer:").grid(row=0, column=0, sticky=tk.W, pady=5)
        self.hwid_var = tk.StringVar()
        ttk.Entry(form_frame, textvariable=self.hwid_var, width=40).grid(row=1, column=0, sticky=tk.W, pady=(0, 15))
        
        # Customer Name
        ttk.Label(form_frame, text="Nama Customer (Opsional):").grid(row=2, column=0, sticky=tk.W, pady=5)
        self.name_var = tk.StringVar()
        ttk.Entry(form_frame, textvariable=self.name_var, width=40).grid(row=3, column=0, sticky=tk.W, pady=(0, 15))
        
        # Duration
        ttk.Label(form_frame, text="Durasi Lisensi:").grid(row=4, column=0, sticky=tk.W, pady=5)
        self.duration_var = tk.StringVar()
        duration_options = ["3 Bulan (3m)", "6 Bulan (6m)", "1 Tahun (1y)"]
        self.duration_var.set(duration_options[2]) # Default 1y
        ttk.Combobox(form_frame, textvariable=self.duration_var, values=duration_options, state="readonly", width=20).grid(row=5, column=0, sticky=tk.W, pady=(0, 20))
        
        # Generate Button
        ttk.Button(main_frame, text="Generate File Lisensi (.lic)", command=self.generate).pack(fill=tk.X, pady=10)
        
    def generate(self):
        hwid = self.hwid_var.get().strip()
        name = self.name_var.get().strip()
        dur_str = self.duration_var.get()
        
        if not hwid:
            messagebox.showwarning("Peringatan", "Hardware ID tidak boleh kosong!")
            return
            
        # Parse duration
        duration_key = "1y"
        if "3m" in dur_str: duration_key = "3m"
        elif "6m" in dur_str: duration_key = "6m"
        
        try:
            # Panggil fungsi dari license_manager
            filepath = create_license(hwid, duration_key, name)
            if filepath:
                messagebox.showinfo("Sukses!", f"Lisensi berhasil dibuat!\n\nFile tersimpan di:\n{filepath}")
            else:
                messagebox.showerror("Gagal", "Gagal membuat lisensi.")
        except Exception as e:
            messagebox.showerror("Error", f"Terjadi kesalahan:\n{str(e)}")

def main():
    root = tk.Tk()
    app = LicenseGeneratorApp(root)
    root.mainloop()

if __name__ == "__main__":
    main()
