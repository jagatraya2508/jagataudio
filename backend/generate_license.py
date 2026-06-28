#!/usr/bin/env python3
"""
JagatAudio License Generator — Admin Tool

Usage:
  python generate_license.py --gen-keys                    # Generate RSA keys (first time only)
  python generate_license.py --hardware-id XXXX --duration 3m    # 3 bulan
  python generate_license.py --hardware-id XXXX --duration 6m    # 6 bulan
  python generate_license.py --hardware-id XXXX --duration 1y    # 1 tahun
  python generate_license.py --hardware-id XXXX --duration 3m --name "Customer Name"
  python generate_license.py --show-hwid                   # Show this machine's Hardware ID

Duration options:
  3m / 3bulan   = 3 bulan (90 hari)
  6m / 6bulan   = 6 bulan (180 hari)
  1y / 1tahun   = 1 tahun (365 hari)
"""

import argparse
import sys
import os

# Add parent directory to path if needed
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from license_manager import (
    generate_rsa_keys,
    get_hardware_id,
    create_license,
    validate_license,
    get_keys_dir,
    DURATION_MAP
)


def main():
    parser = argparse.ArgumentParser(
        description='JagatAudio License Generator — Admin Tool',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog="""
Contoh penggunaan:
  1. Generate RSA keys (pertama kali):
     python generate_license.py --gen-keys

  2. Lihat Hardware ID komputer ini:
     python generate_license.py --show-hwid

  3. Buat lisensi 3 bulan:
     python generate_license.py --hardware-id "ABCD-1234-..." --duration 3m

  4. Buat lisensi 1 tahun dengan nama customer:
     python generate_license.py --hardware-id "ABCD-1234-..." --duration 1y --name "Studio Musik ABC"

  5. Validasi file lisensi:
     python generate_license.py --validate license_file.lic
        """
    )
    
    parser.add_argument('--gen-keys', action='store_true',
                       help='Generate RSA key pair untuk signing lisensi')
    parser.add_argument('--show-hwid', action='store_true',
                       help='Tampilkan Hardware ID komputer ini')
    parser.add_argument('--hardware-id', type=str,
                       help='Hardware ID target (dari komputer customer)')
    parser.add_argument('--duration', type=str, choices=list(DURATION_MAP.keys()),
                       help='Durasi lisensi: 3m, 6m, 1y, 3bulan, 6bulan, 1tahun')
    parser.add_argument('--name', type=str, default='',
                       help='Nama customer (opsional)')
    parser.add_argument('--validate', type=str, metavar='FILE',
                       help='Validasi file lisensi (.lic)')
    
    args = parser.parse_args()
    
    # No arguments provided
    if len(sys.argv) == 1:
        parser.print_help()
        return
    
    # Generate RSA keys
    if args.gen_keys:
        print("\n[KEY] Generating RSA Key Pair...")
        print("=" * 50)
        keys_dir = get_keys_dir()
        
        private_key_path = os.path.join(keys_dir, 'private_key.pem')
        if os.path.exists(private_key_path):
            confirm = input("\n[WARNING] Keys sudah ada! Overwrite? (y/N): ").strip().lower()
            if confirm != 'y':
                print("Dibatalkan.")
                return
        
        generate_rsa_keys(keys_dir)
        return
    
    # Show Hardware ID
    if args.show_hwid:
        print("\n[PC] Hardware ID Komputer Ini:")
        print("=" * 50)
        hwid = get_hardware_id()
        print(f"\n  {hwid}")
        print(f"\n  Salin Hardware ID di atas untuk membuat lisensi.")
        return
    
    # Validate license file
    if args.validate:
        print(f"\n[CHECK] Validasi Lisensi: {args.validate}")
        print("=" * 50)
        result = validate_license(args.validate)
        print(f"\n  Valid: {'[OK] Ya' if result['valid'] else '[FAIL] Tidak'}")
        print(f"  Pesan: {result['message']}")
        if result['info']:
            print(f"\n  Detail:")
            for k, v in result['info'].items():
                print(f"    {k}: {v}")
        return
    
    # Generate license
    if args.hardware_id and args.duration:
        print(f"\n[LICENSE] Membuat Lisensi JagatAudio...")
        print("=" * 50)
        
        # Check keys exist
        keys_dir = get_keys_dir()
        private_key_path = os.path.join(keys_dir, 'private_key.pem')
        if not os.path.exists(private_key_path):
            print("\n[ERROR] RSA keys belum ada! Jalankan dulu:")
            print("   python generate_license.py --gen-keys")
            return
        
        try:
            lic_path = create_license(
                hardware_id=args.hardware_id,
                duration=args.duration,
                customer_name=args.name
            )
            print(f"\n[DONE] Kirim file ini ke customer: {lic_path}")
        except Exception as e:
            print(f"\n[ERROR] Error: {e}")
        return
    
    # Missing arguments
    if args.hardware_id and not args.duration:
        print("[ERROR] --duration diperlukan. Contoh: --duration 3m")
    elif args.duration and not args.hardware_id:
        print("[ERROR] --hardware-id diperlukan.")
    else:
        parser.print_help()


if __name__ == "__main__":
    main()
