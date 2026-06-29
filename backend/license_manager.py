"""
JagatAudio License Manager
Handles hardware fingerprinting, license generation, validation, and installation.
Uses RSA digital signatures to prevent license tampering.
"""

import hashlib
import json
import os
import platform
import subprocess
import uuid
import base64
from datetime import datetime, timedelta
from pathlib import Path

# Try to import cryptography for RSA operations
try:
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import rsa, padding
    from cryptography.hazmat.backends import default_backend
    HAS_CRYPTO = True
except ImportError:
    HAS_CRYPTO = False

# License storage location
def get_license_dir():
    """Get the directory where license files are stored"""
    if getattr(os.sys, 'frozen', False):
        # Running as bundled exe (PyInstaller)
        app_data = os.path.join(os.environ.get('APPDATA', ''), 'JagatAudio')
    else:
        # Running in development
        app_data = os.path.join(os.path.dirname(os.path.abspath(__file__)), '.license_data')
    os.makedirs(app_data, exist_ok=True)
    return app_data

def get_keys_dir():
    """Get the directory where RSA keys are stored"""
    if getattr(os.sys, 'frozen', False):
        # Running as bundled exe - keys are bundled alongside in _internal
        import sys
        base_dir = sys._MEIPASS
    else:
        base_dir = os.path.dirname(os.path.abspath(__file__))
    keys_dir = os.path.join(base_dir, 'keys')
    return keys_dir


# ============================================
# HARDWARE FINGERPRINTING
# ============================================

def _get_cpu_id():
    """Get CPU identifier"""
    try:
        if platform.system() == 'Windows':
            result = subprocess.run(
                ['wmic', 'cpu', 'get', 'ProcessorId'],
                capture_output=True, text=True, timeout=10,
                creationflags=subprocess.CREATE_NO_WINDOW if platform.system() == 'Windows' else 0
            )
            lines = [line.strip() for line in result.stdout.strip().split('\n') if line.strip()]
            if len(lines) >= 2:
                return lines[1]
        elif platform.system() == 'Linux':
            with open('/proc/cpuinfo', 'r') as f:
                for line in f:
                    if 'Serial' in line or 'model name' in line:
                        return line.split(':')[1].strip()
        elif platform.system() == 'Darwin':
            result = subprocess.run(
                ['sysctl', '-n', 'machdep.cpu.brand_string'],
                capture_output=True, text=True, timeout=10
            )
            return result.stdout.strip()
    except Exception as e:
        print(f"[License] Warning: Could not get CPU ID: {e}")
    return "UNKNOWN_CPU"

def _get_disk_serial():
    """Get disk serial number"""
    try:
        if platform.system() == 'Windows':
            result = subprocess.run(
                ['wmic', 'diskdrive', 'get', 'SerialNumber'],
                capture_output=True, text=True, timeout=10,
                creationflags=subprocess.CREATE_NO_WINDOW
            )
            lines = [line.strip() for line in result.stdout.strip().split('\n') if line.strip()]
            if len(lines) >= 2:
                return lines[1]
        elif platform.system() == 'Linux':
            # Try to get serial from /sys
            for disk in ['sda', 'nvme0n1', 'vda']:
                serial_path = f'/sys/block/{disk}/device/serial'
                if os.path.exists(serial_path):
                    with open(serial_path, 'r') as f:
                        return f.read().strip()
    except Exception as e:
        print(f"[License] Warning: Could not get disk serial: {e}")
    return "UNKNOWN_DISK"

def _get_mac_address():
    """Get primary MAC address"""
    try:
        mac = uuid.getnode()
        mac_str = ':'.join(f'{(mac >> (8 * i)) & 0xff:02x}' for i in reversed(range(6)))
        return mac_str
    except Exception as e:
        print(f"[License] Warning: Could not get MAC address: {e}")
    return "UNKNOWN_MAC"

def get_hardware_id():
    """
    Generate a unique hardware fingerprint by combining:
    - CPU Processor ID
    - Disk Serial Number
    - MAC Address
    Returns a SHA-256 hash of the combined hardware info.
    """
    cpu_id = _get_cpu_id()
    disk_serial = _get_disk_serial()
    mac_addr = _get_mac_address()
    
    # Combine all hardware identifiers
    combined = f"JAGAT|{cpu_id}|{disk_serial}|{mac_addr}"
    
    # Hash to create a fixed-length, clean identifier
    hardware_hash = hashlib.sha256(combined.encode('utf-8')).hexdigest().upper()
    
    # Format as groups for readability: XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX
    formatted = '-'.join([hardware_hash[i:i+4] for i in range(0, 32, 4)])
    
    return formatted


# ============================================
# RSA KEY MANAGEMENT
# ============================================

def generate_rsa_keys(keys_dir=None):
    """Generate RSA key pair for license signing"""
    if not HAS_CRYPTO:
        raise RuntimeError("cryptography library is required. Install with: pip install cryptography")
    
    if keys_dir is None:
        keys_dir = get_keys_dir()
    os.makedirs(keys_dir, exist_ok=True)
    
    private_key_path = os.path.join(keys_dir, 'private_key.pem')
    public_key_path = os.path.join(keys_dir, 'public_key.pem')
    
    # Generate private key
    private_key = rsa.generate_private_key(
        public_exponent=65537,
        key_size=2048,
        backend=default_backend()
    )
    
    # Save private key
    with open(private_key_path, 'wb') as f:
        f.write(private_key.private_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PrivateFormat.PKCS8,
            encryption_algorithm=serialization.NoEncryption()
        ))
    
    # Save public key
    public_key = private_key.public_key()
    with open(public_key_path, 'wb') as f:
        f.write(public_key.public_bytes(
            encoding=serialization.Encoding.PEM,
            format=serialization.PublicFormat.SubjectPublicKeyInfo
        ))
    
    print(f"[License] RSA keys generated successfully!")
    print(f"  Private key: {private_key_path}")
    print(f"  Public key:  {public_key_path}")
    print(f"\n  [WARNING] PENTING: Simpan private_key.pem dengan aman! JANGAN distribusikan!")
    
    return private_key_path, public_key_path

def _load_private_key():
    """Load RSA private key (admin only)"""
    key_path = os.path.join(get_keys_dir(), 'private_key.pem')
    if not os.path.exists(key_path):
        raise FileNotFoundError(f"Private key not found at {key_path}. Run generate_license.py --gen-keys first.")
    
    with open(key_path, 'rb') as f:
        return serialization.load_pem_private_key(
            f.read(),
            password=None,
            backend=default_backend()
        )

def _load_public_key():
    """Load RSA public key (bundled with app)"""
    key_path = os.path.join(get_keys_dir(), 'public_key.pem')
    if not os.path.exists(key_path):
        raise FileNotFoundError(f"Public key not found at {key_path}. Keys must be generated first.")
    
    with open(key_path, 'rb') as f:
        return serialization.load_pem_public_key(
            f.read(),
            backend=default_backend()
        )


# ============================================
# LICENSE CREATION (Admin only)
# ============================================

DURATION_MAP = {
    '1menit': 1/(24*60),
    '1jam': 1/24,
    '1hari': 1,
    '3m': 90,      # 3 months (~90 days)
    '6m': 180,     # 6 months (~180 days)
    '1y': 365,     # 1 year
    '3bulan': 90,
    '6bulan': 180,
    '1tahun': 365,
}

def create_license(hardware_id: str, duration: str, customer_name: str = ""):
    """
    Create a signed license file.
    
    Args:
        hardware_id: The target machine's hardware ID
        duration: License duration ('3m', '6m', '1y')
        customer_name: Optional customer name for record keeping
    
    Returns:
        Path to the generated .lic file
    """
    if not HAS_CRYPTO:
        raise RuntimeError("cryptography library is required")
    
    days = DURATION_MAP.get(duration.lower())
    if days is None:
        raise ValueError(f"Invalid duration: {duration}. Use: {', '.join(DURATION_MAP.keys())}")
    
    issued_date = datetime.utcnow()
    expiry_date = issued_date + timedelta(days=days)
    
    # License payload
    license_data = {
        "hardware_id": hardware_id,
        "license_type": duration.lower(),
        "customer_name": customer_name,
        "issued_date": issued_date.isoformat(),
        "expiry_date": expiry_date.isoformat(),
        "product": "JagatAudio",
        "version": "1.0"
    }
    
    # Serialize payload
    payload_json = json.dumps(license_data, sort_keys=True, separators=(',', ':'))
    payload_bytes = payload_json.encode('utf-8')
    
    # Sign with private key
    private_key = _load_private_key()
    signature = private_key.sign(
        payload_bytes,
        padding.PSS(
            mgf=padding.MGF1(hashes.SHA256()),
            salt_length=padding.PSS.MAX_LENGTH
        ),
        hashes.SHA256()
    )
    
    # Create license file content
    license_file_data = {
        "payload": license_data,
        "signature": base64.b64encode(signature).decode('ascii')
    }
    
    # Save license file
    short_hwid = hardware_id.replace('-', '')[:12]
    if customer_name:
        safe_name = "".join([c if c.isalnum() else "_" for c in customer_name])
        lic_filename = f"{safe_name}_JagatAudio_{short_hwid}_{duration}.lic"
    else:
        lic_filename = f"JagatAudio_{short_hwid}_{duration}.lic"
    lic_path = os.path.join(os.getcwd(), lic_filename)
    
    with open(lic_path, 'w', encoding='utf-8') as f:
        json.dump(license_file_data, f, indent=2, ensure_ascii=False)
    
    print(f"\n[OK] License berhasil dibuat!")
    print(f"   File: {lic_path}")
    print(f"   Hardware ID: {hardware_id}")
    print(f"   Durasi: {duration} ({days} hari)")
    print(f"   Berlaku: {issued_date.strftime('%Y-%m-%d')} s/d {expiry_date.strftime('%Y-%m-%d')}")
    if customer_name:
        print(f"   Customer: {customer_name}")
    
    return lic_path


# ============================================
# LICENSE VALIDATION
# ============================================

def validate_license(license_path=None):
    """
    Validate a license file.
    
    Checks:
    1. File exists and is valid JSON
    2. Digital signature is valid (not tampered)
    3. Hardware ID matches current machine
    4. License has not expired
    
    Returns:
        dict with keys: valid (bool), message (str), info (dict or None)
    """
    if not HAS_CRYPTO:
        return {
            "valid": False,
            "message": "Cryptography library tidak ditemukan",
            "info": None
        }
    
    # Find license file
    if license_path is None:
        license_path = _find_installed_license()
    
    if license_path is None or not os.path.exists(license_path):
        return {
            "valid": False,
            "message": "File lisensi tidak ditemukan. Silakan aktivasi.",
            "info": None
        }
    
    try:
        # Read license file
        with open(license_path, 'r', encoding='utf-8') as f:
            license_file_data = json.load(f)
        
        payload = license_file_data.get("payload", {})
        signature_b64 = license_file_data.get("signature", "")
        
        if not payload or not signature_b64:
            return {
                "valid": False,
                "message": "File lisensi rusak atau tidak valid.",
                "info": None
            }
        
        # Verify signature
        public_key = _load_public_key()
        payload_json = json.dumps(payload, sort_keys=True, separators=(',', ':'))
        payload_bytes = payload_json.encode('utf-8')
        signature = base64.b64decode(signature_b64)
        
        try:
            public_key.verify(
                signature,
                payload_bytes,
                padding.PSS(
                    mgf=padding.MGF1(hashes.SHA256()),
                    salt_length=padding.PSS.MAX_LENGTH
                ),
                hashes.SHA256()
            )
        except Exception:
            return {
                "valid": False,
                "message": "Tanda tangan lisensi tidak valid. File mungkin telah dimodifikasi.",
                "info": None
            }
        
        # Check hardware ID
        current_hwid = get_hardware_id()
        license_hwid = payload.get("hardware_id", "")
        
        if current_hwid != license_hwid:
            return {
                "valid": False,
                "message": "Lisensi tidak cocok dengan hardware ini. Lisensi terdaftar untuk komputer lain.",
                "info": {
                    "license_type": payload.get("license_type"),
                    "hardware_mismatch": True
                }
            }
        
        # Check expiry
        expiry_date = datetime.fromisoformat(payload.get("expiry_date", "2000-01-01"))
        now = datetime.utcnow()
        
        if now > expiry_date:
            days_expired = (now - expiry_date).days
            return {
                "valid": False,
                "message": f"Lisensi telah kadaluarsa {days_expired} hari yang lalu ({expiry_date.strftime('%d %B %Y')}).",
                "info": {
                    "license_type": payload.get("license_type"),
                    "expiry_date": payload.get("expiry_date"),
                    "expired": True,
                    "days_expired": days_expired
                }
            }
        
        # All checks passed!
        days_remaining = (expiry_date - now).days
        issued_date = datetime.fromisoformat(payload.get("issued_date", ""))
        
        return {
            "valid": True,
            "message": f"Lisensi aktif. Sisa {days_remaining} hari.",
            "info": {
                "license_type": payload.get("license_type"),
                "customer_name": payload.get("customer_name", ""),
                "issued_date": payload.get("issued_date"),
                "expiry_date": payload.get("expiry_date"),
                "days_remaining": days_remaining,
                "hardware_id": license_hwid
            }
        }
        
    except json.JSONDecodeError:
        return {
            "valid": False,
            "message": "File lisensi rusak (bukan format yang valid).",
            "info": None
        }
    except FileNotFoundError as e:
        return {
            "valid": False,
            "message": f"Key file tidak ditemukan: {str(e)}",
            "info": None
        }
    except Exception as e:
        return {
            "valid": False,
            "message": f"Error validasi lisensi: {str(e)}",
            "info": None
        }


def _find_installed_license():
    """Find the installed license file"""
    license_dir = get_license_dir()
    
    # Look for .lic files
    for f in os.listdir(license_dir):
        if f.endswith('.lic'):
            return os.path.join(license_dir, f)
    
    return None


def install_license(source_path: str):
    """
    Install a license file from the given path.
    Copies it to the app's license storage directory.
    
    Returns:
        dict with keys: success (bool), message (str)
    """
    if not os.path.exists(source_path):
        return {"success": False, "message": "File lisensi tidak ditemukan."}
    
    try:
        # First validate the license file
        result = validate_license(source_path)
        
        # Even if hardware doesn't match now, we still install it
        # (validation will catch it when the app runs)
        
        # Read the file
        with open(source_path, 'r', encoding='utf-8') as f:
            content = f.read()
        
        # Validate it's proper JSON
        try:
            data = json.loads(content)
            if "payload" not in data or "signature" not in data:
                return {"success": False, "message": "File bukan lisensi JagatAudio yang valid."}
        except json.JSONDecodeError:
            return {"success": False, "message": "File bukan format lisensi yang valid."}
        
        # Remove existing license files
        license_dir = get_license_dir()
        for f in os.listdir(license_dir):
            if f.endswith('.lic'):
                os.remove(os.path.join(license_dir, f))
        
        # Copy new license
        dest_path = os.path.join(license_dir, os.path.basename(source_path))
        with open(dest_path, 'w', encoding='utf-8') as f:
            f.write(content)
        
        # Validate the installed license
        validation = validate_license(dest_path)
        
        if validation["valid"]:
            return {
                "success": True,
                "message": f"Lisensi berhasil diaktifkan! {validation['message']}",
                "info": validation["info"]
            }
        else:
            return {
                "success": False,
                "message": validation["message"],
                "info": validation.get("info")
            }
        
    except Exception as e:
        return {"success": False, "message": f"Error menginstall lisensi: {str(e)}"}


def get_license_info():
    """
    Get current license status and info.
    
    Returns:
        dict with license status information
    """
    result = validate_license()
    hardware_id = get_hardware_id()
    
    return {
        "licensed": result["valid"],
        "message": result["message"],
        "hardware_id": hardware_id,
        "info": result.get("info")
    }


# ============================================
# CLI for quick testing
# ============================================

if __name__ == "__main__":
    print("=" * 50)
    print("JagatAudio License Manager")
    print("=" * 50)
    print(f"\nHardware ID: {get_hardware_id()}")
    print(f"\nLicense Status:")
    info = get_license_info()
    print(f"  Licensed: {info['licensed']}")
    print(f"  Message: {info['message']}")
    if info['info']:
        for k, v in info['info'].items():
            print(f"  {k}: {v}")
