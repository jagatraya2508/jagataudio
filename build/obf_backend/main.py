import os
import sys

# === SPLASH SCREEN FAST PATH ===
if len(sys.argv) == 2 and sys.argv[1] == "--splash":
    import tkinter as tk
    root = tk.Tk()
    root.overrideredirect(True)
    root.attributes("-topmost", True)
    window_width = 450
    window_height = 200
    screen_width = root.winfo_screenwidth()
    screen_height = root.winfo_screenheight()
    x = (screen_width // 2) - (window_width // 2)
    y = (screen_height // 2) - (window_height // 2)
    root.geometry(f"{window_width}x{window_height}+{x}+{y}")
    root.configure(bg="#1e1e2e", highlightbackground="#cba6f7", highlightthickness=2)
    tk.Label(root, text="Jagat Audio", font=("Arial", 28, "bold"), bg="#1e1e2e", fg="#cba6f7").pack(pady=(45, 10))
    tk.Label(root, text="Sedang menyiapkan aplikasi, mohon tunggu...", font=("Arial", 11), bg="#1e1e2e", fg="#cdd6f4").pack()
    root.after(15000, root.destroy) # Max timeout fallback
    root.mainloop()
    sys.exit(0)

# Spawn splash screen early before heavy imports
splash_proc = None
if getattr(sys, 'frozen', False):
    if not (len(sys.argv) >= 2 and sys.argv[1] in ["-m", "--splash"]):
        import subprocess
        try:
            splash_proc = subprocess.Popen([sys.executable, "--splash"], creationflags=0x08000000)
        except:
            pass

from fastapi import FastAPI, UploadFile, File, Form, BackgroundTasks, Depends, HTTPException, status, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, HTMLResponse
from fastapi.staticfiles import StaticFiles
from fastapi.security import OAuth2PasswordRequestForm
from starlette.middleware.base import BaseHTTPMiddleware
import multiprocessing
import uuid
import subprocess
import re
from urllib.parse import quote

if sys.platform.startswith('win'):
    multiprocessing.freeze_support()

if len(sys.argv) >= 3 and sys.argv[1] == "-m" and sys.argv[2] == "demucs":
    import demucs.separate
    status_file = None
    if "--status-file" in sys.argv:
        idx = sys.argv.index("--status-file")
        status_file = sys.argv[idx + 1]
        del sys.argv[idx:idx+2]
    
    if status_file:
        f = open(status_file, "w", encoding="utf-8")
        sys.stderr = f
        sys.stdout = f

    sys.argv = [sys.argv[0]] + sys.argv[3:]
    sys.exit(demucs.separate.main())

# Ensure bundled ffmpeg can be found by adding exe dir / _internal to PATH
if getattr(sys, 'frozen', False):
    meipass = getattr(sys, '_MEIPASS', None)
    exe_dir = os.path.dirname(sys.executable)
    for candidate in (meipass, exe_dir, os.path.join(exe_dir, '_internal')):
        if candidate and os.path.isdir(candidate) and candidate not in os.environ.get("PATH", ""):
            os.environ["PATH"] = candidate + os.pathsep + os.environ.get("PATH", "")

import shutil
import mimetypes
import logging
import tempfile
import json
from datetime import datetime, timezone
from typing import Dict, List, Optional
from auth import get_password_hash, verify_password, create_access_token, get_current_user
from database import get_db
from pydantic import BaseModel
from license_manager import get_hardware_id, validate_license, install_license, get_license_info
from version import APP_VERSION


def _resolve_ffmpeg_dir() -> Optional[str]:
    """Locate folder containing ffmpeg.exe (bundled portable / system PATH)."""
    candidates = []
    if getattr(sys, 'frozen', False):
        exe_dir = os.path.dirname(sys.executable)
        meipass = getattr(sys, '_MEIPASS', None)
        candidates.extend([meipass, exe_dir, os.path.join(exe_dir, '_internal')])
    else:
        here = os.path.dirname(os.path.abspath(__file__))
        candidates.extend([here, os.path.join(here, '..', 'build', 'pyinstaller_output', 'JagatAudio', '_internal')])

    for d in candidates:
        if not d:
            continue
        d = os.path.abspath(d)
        if os.path.isfile(os.path.join(d, 'ffmpeg.exe')) or os.path.isfile(os.path.join(d, 'ffmpeg')):
            return d

    which = shutil.which('ffmpeg')
    if which:
        return os.path.dirname(os.path.abspath(which))
    return None


def _ffmpeg_bin() -> str:
    """Absolute path to ffmpeg binary, or bare 'ffmpeg' as last resort."""
    d = _resolve_ffmpeg_dir()
    if d:
        for name in ('ffmpeg.exe', 'ffmpeg'):
            p = os.path.join(d, name)
            if os.path.isfile(p):
                return p
    return 'ffmpeg'


def _ydl_ffmpeg_opts() -> dict:
    """yt-dlp options so postprocessing finds bundled ffmpeg/ffprobe."""
    d = _resolve_ffmpeg_dir()
    return {'ffmpeg_location': d} if d else {}


app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# ============================================
# LICENSE MIDDLEWARE
# ============================================

# Endpoints that don't require license validation
LICENSE_FREE_PATHS = {
    "/license/status",
    "/license/hardware-id",
    "/license/activate",
    "/login",
    "/register",
    "/docs",
    "/openapi.json",
}

class LicenseMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        path = request.url.path
        
        # Allow license-related endpoints and static files
        if any(path.startswith(p) for p in LICENSE_FREE_PATHS):
            return await call_next(request)
        
        # Allow static files (frontend)
        if path.startswith("/assets/") or path == "/" or path.endswith((".js", ".css", ".html", ".ico", ".png", ".svg")):
            return await call_next(request)
        
        # Check license
        license_result = validate_license()
        if not license_result["valid"]:
            return JSONResponse(
                status_code=403,
                content={
                    "detail": "LICENSE_REQUIRED",
                    "message": license_result["message"],
                    "license_info": license_result.get("info")
                }
            )
        
        return await call_next(request)

app.add_middleware(LicenseMiddleware)

import sys
import os

if getattr(sys, 'frozen', False):
    app_data = os.path.join(os.environ.get('APPDATA', ''), 'JagatAudio')
else:
    app_data = os.path.dirname(os.path.abspath(__file__))

UPLOAD_DIR = os.path.join(app_data, "uploads")
OUTPUT_DIR = os.path.join(app_data, "separated")
LYRICS_CACHE_DIR = os.path.join(app_data, "lyrics_cache")

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)
os.makedirs(LYRICS_CACHE_DIR, exist_ok=True)

# Keep track of status
separation_status = {}

PROJECT_META_SUFFIX = "_project.json"
STEM_NAMES = ["vocals.mp3", "drums.mp3", "bass.mp3", "guitar.mp3", "piano.mp3", "other.mp3"]


def _project_meta_path(file_id: str) -> str:
    return os.path.join(UPLOAD_DIR, f"{file_id}{PROJECT_META_SUFFIX}")


def _read_project_meta(file_id: str) -> Optional[dict]:
    path = _project_meta_path(file_id)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as f:
        return json.load(f)


def _write_project_meta(file_id: str, data: dict) -> None:
    path = _project_meta_path(file_id)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)


def _stems_dir_for_id(file_id: str) -> str:
    return os.path.join(OUTPUT_DIR, "htdemucs_6s", file_id)


def _stems_ready(file_id: str) -> bool:
    stem_dir = _stems_dir_for_id(file_id)
    if not os.path.isdir(stem_dir):
        return False
    return all(os.path.exists(os.path.join(stem_dir, name)) for name in STEM_NAMES)


def _ensure_project_meta(file_id: str, original_name: Optional[str] = None) -> dict:
    meta = _read_project_meta(file_id) or {}
    meta.setdefault("file_id", file_id)
    if original_name:
        meta["original_name"] = original_name
        meta.setdefault("display_name", os.path.splitext(original_name)[0])
        meta.setdefault("created_at", datetime.now(timezone.utc).isoformat())
    if _stems_ready(file_id):
        meta["status"] = "ready"
        if not meta.get("separated_at"):
            meta["separated_at"] = datetime.fromtimestamp(
                os.path.getmtime(_stems_dir_for_id(file_id)), tz=timezone.utc
            ).isoformat()
    _write_project_meta(file_id, meta)
    return meta


def _list_all_projects() -> list:
    projects = []
    seen = set()

    for fname in os.listdir(UPLOAD_DIR):
        if not fname.endswith(PROJECT_META_SUFFIX):
            continue
        file_id = fname[: -len(PROJECT_META_SUFFIX)]
        if not _stems_ready(file_id):
            continue
        meta = _read_project_meta(file_id) or {"file_id": file_id}
        meta["file_id"] = file_id
        meta["status"] = "ready"
        projects.append(meta)
        seen.add(file_id)

    htdemucs_root = os.path.join(OUTPUT_DIR, "htdemucs_6s")
    if os.path.isdir(htdemucs_root):
        for file_id in os.listdir(htdemucs_root):
            if file_id in seen or not _stems_ready(file_id):
                continue
            upload_files = [
                f for f in os.listdir(UPLOAD_DIR)
                if f.startswith(file_id)
                and not f.endswith(".txt")
                and not f.endswith(PROJECT_META_SUFFIX)
            ]
            original_name = upload_files[0] if upload_files else f"{file_id}.mp3"
            meta = _ensure_project_meta(file_id, original_name)
            meta.setdefault("display_name", file_id)
            projects.append(meta)

    projects.sort(
        key=lambda p: p.get("separated_at") or p.get("created_at") or "",
        reverse=True,
    )
    return projects


def _safe_export_basename(name: str) -> str:
    cleaned = (name or "").strip()
    if cleaned.lower().endswith(".mp3"):
        cleaned = cleaned[:-4]
    cleaned = re.sub(r'[<>:"/\\|?*]', "_", cleaned)
    cleaned = re.sub(r"\s+", " ", cleaned).strip()
    return (cleaned[:100] if cleaned else "export")


def _export_display_name(file_id: str, filename_no_ext: str) -> str:
    meta = _read_project_meta(file_id) or {}
    base = meta.get("display_name") or meta.get("original_name")
    if base:
        base = os.path.splitext(base)[0]
    else:
        base = filename_no_ext
    return _safe_export_basename(base)

# ============================================
# LICENSE ENDPOINTS
# ============================================

@app.get("/license/status")
def license_status():
    """Get current license status and info"""
    info = get_license_info()
    info["app_version"] = APP_VERSION
    return info

@app.get("/license/hardware-id")
def license_hardware_id():
    """Get this machine's hardware ID"""
    return {"hardware_id": get_hardware_id()}

@app.post("/license/activate")
async def license_activate(file: UploadFile = File(...)):
    """Upload and activate a license file (.lic)"""
    if not file.filename.endswith('.lic'):
        raise HTTPException(status_code=400, detail="File harus berformat .lic")
    
    # Save uploaded file temporarily
    temp_dir = tempfile.mkdtemp()
    temp_path = os.path.join(temp_dir, file.filename)
    
    try:
        with open(temp_path, 'wb') as f:
            content = await file.read()
            f.write(content)
        
        # Install the license
        result = install_license(temp_path)
        
        if result["success"]:
            return {
                "status": "success",
                "message": result["message"],
                "info": result.get("info")
            }
        else:
            return JSONResponse(
                status_code=400,
                content={
                    "status": "error",
                    "message": result["message"],
                    "info": result.get("info")
                }
            )
    finally:
        # Clean up temp file
        try:
            os.remove(temp_path)
            os.rmdir(temp_dir)
        except:
            pass


class UserCreate(BaseModel):
    username: str
    email: str
    password: str

@app.post("/register")
def register(user: UserCreate):
    import re
    email_regex = r'^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$'
    if not re.match(email_regex, user.email):
        raise HTTPException(status_code=400, detail="Format email tidak valid")
    
    db = get_db()
    cursor = db.cursor()
    cursor.execute("SELECT id FROM users WHERE username = ?", (user.username,))
    if cursor.fetchone():
        db.close()
        raise HTTPException(status_code=400, detail="Username sudah digunakan")
    
    cursor.execute("SELECT id FROM users WHERE email = ?", (user.email,))
    if cursor.fetchone():
        db.close()
        raise HTTPException(status_code=400, detail="Email sudah terdaftar")
        
    hashed_pwd = get_password_hash(user.password)
    cursor.execute("INSERT INTO users (username, email, password_hash) VALUES (?, ?, ?)", (user.username, user.email, hashed_pwd))
    db.commit()
    db.close()
    return {"message": "User registered successfully"}

@app.post("/login")
def login(form_data: OAuth2PasswordRequestForm = Depends()):
    username = form_data.username.strip()
    password = form_data.password
    if not username or not password:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Username dan password wajib diisi",
            headers={"WWW-Authenticate": "Bearer"},
        )

    db = get_db()
    cursor = db.cursor()
    cursor.execute(
        "SELECT id, username, password_hash, is_admin FROM users WHERE lower(username) = lower(?)",
        (username,),
    )
    user = cursor.fetchone()
    db.close()
    
    if not user or not verify_password(password, user['password_hash']):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Username atau password salah",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    access_token = create_access_token(data={"sub": user['username']})
    return {
        "access_token": access_token,
        "token_type": "bearer",
        "is_admin": bool(user['is_admin']),
        "username": user['username'],
    }

@app.get("/me")
def read_users_me(current_user: dict = Depends(get_current_user)):
    return {"username": current_user["username"], "is_admin": bool(current_user.get("is_admin", 0))}

# ============================================
# ADMIN: User Management Routes
# ============================================

def require_admin(current_user: dict = Depends(get_current_user)):
    if not current_user.get("is_admin"):
        raise HTTPException(status_code=403, detail="Admin access required")
    return current_user

@app.get("/admin/users")
def list_users(admin: dict = Depends(require_admin)):
    db = get_db()
    cursor = db.cursor()
    cursor.execute("SELECT id, username, is_admin FROM users ORDER BY id")
    users = [dict(row) for row in cursor.fetchall()]
    db.close()
    return users

class AdminUserCreate(BaseModel):
    username: str
    password: str
    is_admin: bool = False

@app.post("/admin/users")
def admin_add_user(user: AdminUserCreate, admin: dict = Depends(require_admin)):
    db = get_db()
    cursor = db.cursor()
    cursor.execute("SELECT id FROM users WHERE username = ?", (user.username,))
    if cursor.fetchone():
        db.close()
        raise HTTPException(status_code=400, detail="Username sudah digunakan")
    hashed_pwd = get_password_hash(user.password)
    cursor.execute("INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, ?)",
                   (user.username, hashed_pwd, int(user.is_admin)))
    db.commit()
    new_id = cursor.lastrowid
    db.close()
    return {"id": new_id, "username": user.username, "is_admin": user.is_admin}

class AdminUserUpdate(BaseModel):
    username: str | None = None
    password: str | None = None
    is_admin: bool | None = None

@app.put("/admin/users/{user_id}")
def admin_edit_user(user_id: int, data: AdminUserUpdate, admin: dict = Depends(require_admin)):
    db = get_db()
    cursor = db.cursor()
    cursor.execute("SELECT id FROM users WHERE id = ?", (user_id,))
    if not cursor.fetchone():
        db.close()
        raise HTTPException(status_code=404, detail="User not found")
    
    if data.username is not None:
        cursor.execute("SELECT id FROM users WHERE username = ? AND id != ?", (data.username, user_id))
        if cursor.fetchone():
            db.close()
            raise HTTPException(status_code=400, detail="Username sudah digunakan")
        cursor.execute("UPDATE users SET username = ? WHERE id = ?", (data.username, user_id))
    
    if data.password is not None:
        hashed_pwd = get_password_hash(data.password)
        cursor.execute("UPDATE users SET password_hash = ? WHERE id = ?", (hashed_pwd, user_id))
    
    if data.is_admin is not None:
        cursor.execute("UPDATE users SET is_admin = ? WHERE id = ?", (int(data.is_admin), user_id))
    
    db.commit()
    cursor.execute("SELECT id, username, is_admin FROM users WHERE id = ?", (user_id,))
    updated = dict(cursor.fetchone())
    db.close()
    return updated

@app.delete("/admin/users/{user_id}")
def admin_delete_user(user_id: int, admin: dict = Depends(require_admin)):
    db = get_db()
    cursor = db.cursor()
    cursor.execute("SELECT id, username FROM users WHERE id = ?", (user_id,))
    user = cursor.fetchone()
    if not user:
        db.close()
        raise HTTPException(status_code=404, detail="User not found")
    if user['username'] == admin['username']:
        db.close()
        raise HTTPException(status_code=400, detail="Tidak bisa menghapus akun sendiri")
    cursor.execute("DELETE FROM users WHERE id = ?", (user_id,))
    db.commit()
    db.close()
    return {"message": "User deleted"}

@app.post("/upload")
async def upload_file(file: UploadFile = File(...), current_user: dict = Depends(get_current_user)):
    file_id = str(uuid.uuid4())
    ext = file.filename.split('.')[-1]
    filename = f"{file_id}.{ext}"
    filepath = os.path.join(UPLOAD_DIR, filename)
    
    with open(filepath, "wb") as buffer:
        shutil.copyfileobj(file.file, buffer)

    _ensure_project_meta(file_id, file.filename)
        
    return {
        "file_id": file_id,
        "filename": file.filename,
        "display_name": os.path.splitext(file.filename)[0],
        "filepath": filepath,
    }

def run_demucs(filepath: str, file_id: str):
    try:
        separation_status[file_id] = {"status": "processing", "progress": 0, "eta": "Menghitung..."}
        import sys
        import re
        import traceback
        import time
        import os
        import subprocess
        
        status_file_path = os.path.join(os.path.abspath(UPLOAD_DIR), f"{file_id}_demucs_status.txt")
        error_log_path = os.path.join(os.path.abspath(UPLOAD_DIR), f"{file_id}_error_log.txt")
        
        # Ensure status file exists
        with open(status_file_path, "w", encoding="utf-8") as f:
            pass
            
        command = [sys.executable]
        if not getattr(sys, 'frozen', False):
            command.append(os.path.abspath(__file__))
            
        command.extend([
            "-m", "demucs",
            "--status-file", status_file_path,
            "-n", "htdemucs_6s",
            "-o", os.path.abspath(OUTPUT_DIR),
            "--mp3",
            "--mp3-preset", "2",
            "-j", "2",
            os.path.abspath(filepath)
        ])
        kwargs = {}
        if sys.platform == "win32":
            kwargs["creationflags"] = 0x08000000
            
        process = subprocess.Popen(command, **kwargs)
        
        buf = ""
        logs = []
        with open(status_file_path, "r", encoding="utf-8", errors="replace") as f:
            while process.poll() is None:
                char = f.read(1)
                if not char:
                    time.sleep(0.1)
                    continue
                if char == '\r' or char == '\n':
                    if buf.strip():
                        logs.append(buf.strip())
                    if "%|" in buf:
                        # Parse percentage
                        pct_match = re.search(r'(\d{1,3})%\|', buf)
                        if pct_match:
                            separation_status[file_id]["progress"] = int(pct_match.group(1))
                        
                        # Parse ETA
                        eta_match = re.search(r'<([^,\]]+)', buf)
                        if eta_match:
                            separation_status[file_id]["eta"] = eta_match.group(1)
                    buf = ""
                else:
                    buf += char
            
            # Process remaining output after process exits
            while True:
                char = f.read(1)
                if not char:
                    break
                if char == '\r' or char == '\n':
                    if buf.strip():
                        logs.append(buf.strip())
                    if "%|" in buf:
                        pct_match = re.search(r'(\d{1,3})%\|', buf)
                        if pct_match:
                            separation_status[file_id]["progress"] = int(pct_match.group(1))
                    buf = ""
                else:
                    buf += char
                    
        try:
            os.remove(status_file_path)
        except:
            pass
        
        if process.returncode == 0:
            separation_status[file_id]["status"] = "done"
            separation_status[file_id]["progress"] = 100
            separation_status[file_id]["eta"] = "00:00"
            meta = _read_project_meta(file_id) or {"file_id": file_id}
            meta["status"] = "ready"
            meta["separated_at"] = datetime.now(timezone.utc).isoformat()
            _write_project_meta(file_id, meta)
        else:
            with open(error_log_path, "w", encoding="utf-8") as f:
                f.write(f"Demucs failed with returncode: {process.returncode}\n")
                f.write("Logs:\n")
                f.write("\n".join(logs))
            print(f"Demucs failed with returncode: {process.returncode}")
            print("Demucs execution logs:")
            for log_line in logs:
                print("  DEMUCS:", log_line)
            separation_status[file_id]["status"] = "error"
    except Exception as e:
        import traceback
        try:
            error_log_path = os.path.join(os.path.abspath(UPLOAD_DIR), f"{file_id}_error_log.txt")
            with open(error_log_path, "w", encoding="utf-8") as f:
                f.write(f"Exception: {str(e)}\n")
                f.write(traceback.format_exc())
        except:
            pass
        traceback.print_exc()
        print("Exception in run_demucs:", str(e))
        separation_status[file_id] = {"status": "error", "progress": 0, "eta": ""}

@app.post("/separate/{file_id}")
async def separate_audio(file_id: str, background_tasks: BackgroundTasks, current_user: dict = Depends(get_current_user)):
    # Find file
    files = [f for f in os.listdir(UPLOAD_DIR) if f.startswith(file_id) and not f.endswith('.txt')]
    if not files:
        return JSONResponse(status_code=404, content={"message": "File not found"})
        
    filepath = os.path.join(UPLOAD_DIR, files[0])
    
    background_tasks.add_task(run_demucs, filepath, file_id)
    return {"status": "started", "file_id": file_id}

@app.get("/status/{file_id}")
async def get_status(file_id: str):
    info = separation_status.get(file_id, {"status": "unknown", "progress": 0, "eta": ""})
    if isinstance(info, str):
        return {"status": info, "progress": 0, "eta": ""}
    return info

@app.get("/stems/{file_id}")
async def get_stems(file_id: str, current_user: dict = Depends(get_current_user)):
    # Demucs outputs to OUTPUT_DIR/htdemucs_6s/{filename_without_ext}/
    # We need to find the dir
    files = [f for f in os.listdir(UPLOAD_DIR) if f.startswith(file_id) and not f.endswith('.txt')]
    if not files:
        return JSONResponse(status_code=404, content={"message": "File not found"})
        
    filename = files[0]
    filename_no_ext = os.path.splitext(filename)[0]
    
    stem_dir = os.path.join(OUTPUT_DIR, "htdemucs_6s", filename_no_ext)
    
    if not os.path.exists(stem_dir):
        return JSONResponse(status_code=404, content={"message": "Stems not found or not ready"})
        
    stems = os.listdir(stem_dir)
    return {"stems": stems, "file_id": file_id}


class ProjectSettings(BaseModel):
    volumes: Dict[str, float] = {}
    mutes: Dict[str, bool] = {}
    pans: Dict[str, float] = {}
    pitch: float = 0.0
    tempo: float = 1.0
    eq_low: float = 0.0
    eq_mid: float = 0.0
    eq_high: float = 0.0
    eq_bands: List[float] = []  # 10-band graphic EQ gains (dB)
    compressor_enabled: bool = False
    master_volume: float = 0.0
    limiter_enabled: bool = True
    normalize_enabled: bool = True
    denoise_enabled: bool = False
    reverb_enabled: bool = False
    delay_enabled: bool = False
    stem_lyrics_offset_ms: float = 0.0
    stem_lyrics_speed_pct: float = 100.0


class ProjectRename(BaseModel):
    display_name: str


@app.get("/projects")
async def list_projects(current_user: dict = Depends(get_current_user)):
    return {"projects": _list_all_projects()}


@app.get("/projects/{file_id}")
async def get_project(file_id: str, current_user: dict = Depends(get_current_user)):
    if not _stems_ready(file_id):
        raise HTTPException(status_code=404, detail="Proyek tidak ditemukan")
    meta = _read_project_meta(file_id) or {"file_id": file_id, "display_name": file_id}
    meta["file_id"] = file_id
    meta["status"] = "ready"
    return meta


@app.patch("/projects/{file_id}/name")
async def rename_project(
    file_id: str,
    body: ProjectRename,
    current_user: dict = Depends(get_current_user),
):
    display_name = body.display_name.strip()
    if not display_name:
        raise HTTPException(status_code=400, detail="Nama proyek tidak boleh kosong")

    meta = _read_project_meta(file_id)
    if not meta:
        upload_files = [
            f for f in os.listdir(UPLOAD_DIR)
            if f.startswith(file_id)
            and not f.endswith(".txt")
            and not f.endswith(PROJECT_META_SUFFIX)
        ]
        if not upload_files and not _stems_ready(file_id):
            raise HTTPException(status_code=404, detail="Proyek tidak ditemukan")
        meta = {"file_id": file_id}

    meta["file_id"] = file_id
    meta["display_name"] = display_name[:120]
    _write_project_meta(file_id, meta)
    return {"status": "saved", "display_name": meta["display_name"]}


@app.put("/projects/{file_id}/settings")
async def save_project_settings(
    file_id: str,
    settings: ProjectSettings,
    current_user: dict = Depends(get_current_user),
):
    if not _stems_ready(file_id):
        raise HTTPException(status_code=404, detail="Proyek tidak ditemukan")
    meta = _read_project_meta(file_id) or {"file_id": file_id}
    meta["settings"] = settings.model_dump()
    _write_project_meta(file_id, meta)
    return {"status": "saved"}


@app.delete("/projects/{file_id}")
async def delete_project(file_id: str, current_user: dict = Depends(get_current_user)):
    if not _stems_ready(file_id) and not _read_project_meta(file_id):
        raise HTTPException(status_code=404, detail="Proyek tidak ditemukan")

    stem_dir = _stems_dir_for_id(file_id)
    if os.path.isdir(stem_dir):
        shutil.rmtree(stem_dir, ignore_errors=True)

    for fname in os.listdir(UPLOAD_DIR):
        if fname.startswith(file_id):
            try:
                os.remove(os.path.join(UPLOAD_DIR, fname))
            except OSError:
                pass

    return {"status": "deleted"}


@app.get("/audio/{file_id}/{stem_name}")
async def get_audio(file_id: str, stem_name: str):
    # Note: Audio is served to frontend audio player, which might not easily send headers in <audio src>.
    # We leave this unprotected or protect via query token if needed.
    files = [f for f in os.listdir(UPLOAD_DIR) if f.startswith(file_id) and not f.endswith('.txt')]
    if not files:
        return JSONResponse(status_code=404, content={"message": "File not found"})
        
    filename = files[0]
    filename_no_ext = os.path.splitext(filename)[0]
    
    filepath = os.path.join(OUTPUT_DIR, "htdemucs_6s", filename_no_ext, stem_name)
    
    if not os.path.exists(filepath):
        return JSONResponse(status_code=404, content={"message": "Stem not found"})
        
    return FileResponse(filepath)

@app.get("/media/{file_id}")
async def get_media(file_id: str):
    # Retrieve the original uploaded file (audio/video)
    files = [f for f in os.listdir(UPLOAD_DIR) 
             if f.startswith(file_id) 
             and not f.endswith('.txt') 
             and not f.endswith(PROJECT_META_SUFFIX)]
    if not files:
        return JSONResponse(status_code=404, content={"message": "Media not found"})
        
    filepath = os.path.join(UPLOAD_DIR, files[0])
    if not os.path.exists(filepath):
        return JSONResponse(status_code=404, content={"message": "Media not found"})
        
    return FileResponse(filepath)

class MixParams(BaseModel):
    volumes: Dict[str, float]
    mutes: Dict[str, bool]
    pans: Dict[str, float] = {}
    pitch: float
    tempo: float
    eq_low: float = 0.0    # -12 to 12 dB
    eq_mid: float = 0.0    # -12 to 12 dB
    eq_high: float = 0.0   # -12 to 12 dB
    eq_bands: List[float] = []  # 10-band graphic EQ gains (dB), centers 31..16k Hz
    compressor_enabled: bool = False
    master_volume: float = 0.0  # dB
    limiter_enabled: bool = True
    normalize_enabled: bool = True
    denoise_enabled: bool = False
    reverb_enabled: bool = False
    delay_enabled: bool = False
    trim_start: float = 0.0
    trim_end: Optional[float] = None
    export_video: bool = False

@app.post("/export/{file_id}")
async def export_mix(file_id: str, params: MixParams, current_user: dict = Depends(get_current_user)):
    files = [f for f in os.listdir(UPLOAD_DIR) if f.startswith(file_id) and not f.endswith('.txt')]
    if not files:
        return JSONResponse(status_code=404, content={"message": "File not found"})
        
    filename = files[0]
    filename_no_ext = os.path.splitext(filename)[0]
    
    stem_dir = os.path.join(OUTPUT_DIR, "htdemucs_6s", filename_no_ext)
    
    if not os.path.exists(stem_dir):
        return JSONResponse(status_code=404, content={"message": "Stems not found"})
        
    export_dir = os.path.join(app_data, "exports")
    os.makedirs(export_dir, exist_ok=True)
    export_base = _export_display_name(file_id, filename_no_ext)
    
    is_video_export = params.export_video and filename.lower().endswith(('.mp4', '.mov', '.avi', '.mkv', '.webm'))
    
    if is_video_export:
        out_filename = f"{export_base} edit.mp4"
    else:
        out_filename = f"{export_base} edit.mp3"
        
    out_filepath = os.path.join(export_dir, out_filename)
    
    command = [_ffmpeg_bin(), "-y"]
    inputs = []
    filters = []
    input_idx = 0
    
    # Apply trim: add -ss and -t to each input for precise cutting
    trim_start = params.trim_start
    trim_end = params.trim_end
    trim_input_args = []
    if trim_start > 0:
        trim_input_args.extend(["-ss", str(trim_start)])
    if trim_end is not None and trim_end > trim_start:
        trim_duration = trim_end - trim_start
        trim_input_args.extend(["-t", str(trim_duration)])
    
    instruments = ["vocals", "drums", "bass", "guitar", "piano", "other"]
    
    for inst in instruments:
        if not params.mutes.get(inst, False):
            stem_file = os.path.join(stem_dir, f"{inst}.mp3")
            if os.path.exists(stem_file):
                # Apply trim args before each input file
                command.extend(trim_input_args)
                command.extend(["-i", stem_file])
                vol = params.volumes.get(inst, 0)
                pan_val = params.pans.get(inst, 0.0)  # -100 to 100
                # Build per-stem filter: volume -> pan
                stem_filter = f"[{input_idx}:a]volume={vol}dB"
                if pan_val != 0:
                    # Convert -100..100 to stereopan: L gain and R gain
                    # pan=0 -> center (L=R=1), pan=-100 -> full left (L=1,R=0)
                    pan_norm = max(-100, min(100, pan_val)) / 100.0  # -1 to 1
                    l_gain = min(1.0, 1.0 - pan_norm)
                    r_gain = min(1.0, 1.0 + pan_norm)
                    stem_filter += f",pan=stereo|c0={l_gain:.3f}*c0+{l_gain:.3f}*c1|c1={r_gain:.3f}*c0+{r_gain:.3f}*c1"
                stem_filter += f"[a{input_idx}]"
                filters.append(stem_filter)
                input_idx += 1
                
    if input_idx == 0:
        return JSONResponse(status_code=400, content={"message": "All tracks are muted"})
        
    mix_inputs = "".join([f"[a{i}]" for i in range(input_idx)])
    # Demucs stems are typically quieter than the source; boost after sum then limit/normalize
    filters.append(
        f"{mix_inputs}amix=inputs={input_idx}:normalize=0:dropout_transition=0:duration=longest[mixraw]"
    )
    filters.append("[mixraw]volume=4dB[mix]")
    
    # Build the post-mix processing chain
    current_label = "mix"
    label_counter = 0
    
    # Apply pitch and tempo if changed
    pitch_semitones = params.pitch
    tempo = params.tempo
    
    if pitch_semitones != 0 or tempo != 1.0:
        pitch_factor = 2 ** (pitch_semitones / 12.0)
        next_label = f"pt{label_counter}"
        filters.append(f"[{current_label}]rubberband=pitch={pitch_factor}:tempo={tempo}[{next_label}]")
        current_label = next_label
        label_counter += 1
    
    # Apply EQ (Bass, Mid, Treble) if any value is non-zero
    eq_low = params.eq_low
    eq_mid = params.eq_mid
    eq_high = params.eq_high
    
    if eq_low != 0 or eq_mid != 0 or eq_high != 0:
        eq_parts = []
        if eq_low != 0:
            eq_parts.append(f"bass=g={eq_low}")
        if eq_mid != 0:
            eq_parts.append(f"equalizer=f=1000:width_type=q:width=1:g={eq_mid}")
        if eq_high != 0:
            eq_parts.append(f"treble=g={eq_high}")
        eq_chain = ",".join(eq_parts)
        next_label = f"eq{label_counter}"
        filters.append(f"[{current_label}]{eq_chain}[{next_label}]")
        current_label = next_label
        label_counter += 1

    # 10-band graphic EQ (1-octave peaking bands)
    eq_band_freqs = [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000]
    eq_bands = params.eq_bands or []
    geq_parts = []
    for i, freq in enumerate(eq_band_freqs):
        try:
            gain = float(eq_bands[i]) if i < len(eq_bands) else 0.0
        except (TypeError, ValueError):
            gain = 0.0
        if gain != 0:
            geq_parts.append(f"equalizer=f={freq}:width_type=o:width=1:g={gain}")
    if geq_parts:
        next_label = f"geq{label_counter}"
        filters.append(f"[{current_label}]{','.join(geq_parts)}[{next_label}]")
        current_label = next_label
        label_counter += 1
    
    # Denoise (FFT) — reduce hiss/noise for karaoke / mic-like stems
    if params.denoise_enabled:
        next_label = f"dn{label_counter}"
        filters.append(
            f"[{current_label}]highpass=f=80,afftdn=nr=12:nf=-50,lowpass=f=14000[{next_label}]"
        )
        current_label = next_label
        label_counter += 1

    # Apply Compressor if enabled
    if params.compressor_enabled:
        next_label = f"comp{label_counter}"
        filters.append(f"[{current_label}]acompressor=threshold=-24dB:ratio=4:attack=3:release=250[{next_label}]")
        current_label = next_label
        label_counter += 1

    # Light karaoke room reverb
    if params.reverb_enabled:
        next_label = f"rv{label_counter}"
        filters.append(
            f"[{current_label}]aecho=0.8:0.88:60:0.3[{next_label}]"
        )
        current_label = next_label
        label_counter += 1

    # Light delay (slap-back style for karaoke)
    if params.delay_enabled:
        next_label = f"dl{label_counter}"
        filters.append(
            f"[{current_label}]aecho=0.8:0.9:180|220:0.25|0.18[{next_label}]"
        )
        current_label = next_label
        label_counter += 1

    # Master volume (matches studio Master Vol)
    if abs(params.master_volume) > 0.01:
        next_label = f"mvol{label_counter}"
        filters.append(f"[{current_label}]volume={params.master_volume}dB[{next_label}]")
        current_label = next_label
        label_counter += 1

    # Normalize loudness to streaming/karaoke target (~-14 LUFS)
    if params.normalize_enabled:
        next_label = f"norm{label_counter}"
        filters.append(
            f"[{current_label}]loudnorm=I=-14:TP=-1.5:LRA=11:linear=true:print_format=summary[{next_label}]"
        )
        current_label = next_label
        label_counter += 1

    # Peak limiter (safety / standalone when normalize off)
    if params.limiter_enabled:
        next_label = f"lim{label_counter}"
        filters.append(
            f"[{current_label}]alimiter=limit=0.95:attack=5:release=50:level=disabled[{next_label}]"
        )
        current_label = next_label
        label_counter += 1
    
    map_out = f"[{current_label}]"
        
    filter_complex = "; ".join(filters)
    
    if is_video_export:
        original_filepath = os.path.join(UPLOAD_DIR, filename)
        command.extend(trim_input_args)
        command.extend(["-i", original_filepath])
        video_input_idx = input_idx
        command.extend([
            "-filter_complex", filter_complex,
            "-map", f"{video_input_idx}:v:0",
            "-map", map_out,
            "-c:v", "copy",
            "-c:a", "aac", "-b:a", "256k",
            "-shortest",
            out_filepath
        ])
    else:
        command.extend([
            "-filter_complex", filter_complex, 
            "-map", map_out, 
            "-c:a", "libmp3lame", "-b:a", "320k", 
            out_filepath
        ])
    
    try:
        subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return {
            "status": "success",
            "download_url": f"/download_export/{quote(out_filename)}",
            "filename": out_filename,
        }
    except subprocess.CalledProcessError as e:
        print("FFmpeg error:", e.stderr.decode('utf-8', errors='replace'))
        return JSONResponse(status_code=500, content={"message": "Error exporting mix"})

@app.get("/download_export/{filename}")
async def download_export(filename: str):
    filepath = os.path.join(app_data, "exports", filename)
    if not os.path.exists(filepath):
        return JSONResponse(status_code=404, content={"message": "File not found"})
    media_type = "video/mp4" if filename.lower().endswith(".mp4") else "audio/mpeg"
    return FileResponse(filepath, media_type=media_type, filename=filename)


@app.post("/karaoke/recording")
async def save_karaoke_recording(
    file: UploadFile = File(...),
    display_name: str = Form(""),
    current_user: dict = Depends(get_current_user),
):
    """Accept browser karaoke recording (webm/opus) and convert to MP3 for download."""
    export_dir = os.path.join(app_data, "exports")
    os.makedirs(export_dir, exist_ok=True)

    base = _safe_export_basename(display_name or os.path.splitext(file.filename or "karaoke")[0])
    stamp = datetime.now(timezone.utc).strftime("%Y%m%d_%H%M%S")
    raw_name = f"{base}_{stamp}_rec.webm"
    out_name = f"{base} karaoke.mp3"
    raw_path = os.path.join(export_dir, raw_name)
    out_path = os.path.join(export_dir, out_name)

    try:
        content = await file.read()
        if not content:
            return JSONResponse(status_code=400, content={"message": "File rekaman kosong"})
        with open(raw_path, "wb") as f:
            f.write(content)

        cmd = [
            _ffmpeg_bin(), "-y",
            "-i", raw_path,
            "-vn",
            "-c:a", "libmp3lame",
            "-b:a", "320k",
            out_path,
        ]
        subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        try:
            os.remove(raw_path)
        except OSError:
            pass

        return {
            "status": "success",
            "download_url": f"/download_export/{quote(out_name)}",
            "filename": out_name,
        }
    except subprocess.CalledProcessError as e:
        print("Karaoke recording ffmpeg error:", e.stderr.decode("utf-8", errors="replace"))
        return JSONResponse(status_code=500, content={"message": "Gagal mengonversi rekaman ke MP3"})
    except Exception as e:
        print("Karaoke recording error:", e)
        return JSONResponse(status_code=500, content={"message": str(e)})

# Lazy-import tab_generator: basic_pitch can crash startup if no ML backend is detected.
tab_status = {}

def run_tab_generator(filepath: str, file_id: str):
    tab_status[file_id] = {"status": "processing", "progress": 10}
    try:
        # Prefer tensorflow present before basic_pitch picks a default model type
        try:
            import tensorflow  # noqa: F401
        except Exception:
            try:
                import onnxruntime  # noqa: F401
            except Exception:
                pass
        from tab_generator import generate_tab_from_audio

        tab_dir = os.path.join(app_data, "tabs")
        os.makedirs(tab_dir, exist_ok=True)
        out_filename = f"{file_id}_tab.txt"
        out_filepath = os.path.join(tab_dir, out_filename)
        
        tab_status[file_id] = {"status": "processing", "progress": 40} # Mulai deteksi
        generate_tab_from_audio(filepath, out_filepath)
        
        tab_status[file_id] = {"status": "done", "progress": 100, "download_url": f"/download_tab/{out_filename}"}
    except Exception as e:
        print("Tab generator error:", e)
        tab_status[file_id] = {"status": "error", "progress": 0}

@app.post("/generate_tab_master/{file_id}")
async def generate_tab_master(file_id: str, background_tasks: BackgroundTasks, current_user: dict = Depends(get_current_user)):
    files = [f for f in os.listdir(UPLOAD_DIR) if f.startswith(file_id) and not f.endswith('.txt')]
    if not files:
        return JSONResponse(status_code=404, content={"message": "File not found"})
        
    filename = files[0]
    filepath = os.path.join(UPLOAD_DIR, filename)
    
    background_tasks.add_task(run_tab_generator, filepath, file_id)
    return {"status": "started"}

@app.get("/status_tab/{file_id}")
async def get_status_tab(file_id: str):
    info = tab_status.get(file_id, {"status": "unknown", "progress": 0})
    return info

@app.get("/download_tab/{filename}")
async def download_tab(filename: str):
    filepath = os.path.join(app_data, "tabs", filename)
    if not os.path.exists(filepath):
        return JSONResponse(status_code=404, content={"message": "File not found"})
    return FileResponse(filepath, media_type="text/plain", filename=filename)

# ============================================
# LYRICS ROUTES
# ============================================
from lyrics_fetcher import get_or_fetch_lyrics, load_cached_lyrics, cache_base_name, search_lyrics_candidates, apply_lyrics_for_track

class LyricsFetchRequest(BaseModel):
    track_name: str
    duration: int | None = None
    refresh: bool = False

class LyricsSearchRequest(BaseModel):
    artist: str = ""
    title: str = ""
    query: str = ""
    duration: int | None = None

class LyricsSelectRequest(BaseModel):
    track_name: str
    lrclib_id: int

@app.post("/lyrics/fetch")
def lyrics_fetch(req: LyricsFetchRequest, current_user: dict = Depends(get_current_user)):
    track_name = req.track_name.strip()
    if not track_name:
        raise HTTPException(status_code=400, detail="Nama lagu tidak valid")
    result = get_or_fetch_lyrics(LYRICS_CACHE_DIR, track_name, req.duration, req.refresh)
    if not result.get("found"):
        return {
            "found": False,
            "message": "Lirik tidak ditemukan di internet",
            "search_artist": result.get("search_artist", ""),
            "search_title": result.get("search_title", ""),
        }
    return {
        "found": True,
        "saved": result.get("saved", False),
        "from_cache": result.get("from_cache", False),
        "format": result.get("format"),
        "content": result.get("content"),
        "source": result.get("source", "cache"),
        "filename": f"{cache_base_name(track_name)}.{result.get('format', 'lrc')}",
        "search_artist": result.get("search_artist", ""),
        "search_title": result.get("search_title", ""),
    }

@app.post("/lyrics/search")
def lyrics_search(req: LyricsSearchRequest, current_user: dict = Depends(get_current_user)):
    artist = req.artist.strip()
    title = req.title.strip()
    query = req.query.strip()
    if not query and not title and not artist:
        raise HTTPException(status_code=400, detail="Isi penyanyi, judul, atau kata kunci pencarian")
    results = search_lyrics_candidates(artist, title, req.duration, query or None)
    return {"results": results, "count": len(results)}

@app.post("/lyrics/select")
def lyrics_select(req: LyricsSelectRequest, current_user: dict = Depends(get_current_user)):
    track_name = req.track_name.strip()
    if not track_name:
        raise HTTPException(status_code=400, detail="Nama lagu tidak valid")
    result = apply_lyrics_for_track(LYRICS_CACHE_DIR, track_name, req.lrclib_id)
    if not result.get("found"):
        raise HTTPException(status_code=404, detail="Lirik tidak ditemukan")
    return {
        "found": True,
        "format": result.get("format"),
        "content": result.get("content"),
        "source": result.get("source", "lrclib"),
        "search_artist": result.get("search_artist", ""),
        "search_title": result.get("search_title", ""),
    }

@app.get("/lyrics/download")
def lyrics_download(track_name: str, current_user: dict = Depends(get_current_user)):
    cached = load_cached_lyrics(LYRICS_CACHE_DIR, track_name.strip())
    if not cached:
        return JSONResponse(status_code=404, content={"message": "Lirik belum tersimpan"})
    fmt = cached["format"]
    filename = f"{cache_base_name(track_name.strip())}.{fmt}"
    media = "application/lrc" if fmt == "lrc" else "text/plain"
    from fastapi.responses import Response
    return Response(
        content=cached["content"],
        media_type=media,
        headers={"Content-Disposition": f'attachment; filename="{filename}"'},
    )

# ============================================
# YOUTUBE IMPORT FOR STUDIO
# ============================================
import yt_dlp

yt_import_status = {}

class YtImportRequest(BaseModel):
    url: str
    is_video: bool = False

def _yt_find_downloaded_file(job_id: str, search_dir: str, info: dict = None):
    """Resolve the actual file yt-dlp wrote (ext often wrong after postprocess)."""
    if info:
        for rd in info.get('requested_downloads') or []:
            fp = rd.get('filepath')
            if fp and os.path.exists(fp):
                return fp
        prepared = None
        try:
            prepared = yt_dlp.YoutubeDL({'outtmpl': os.path.join(search_dir, f"{job_id}.%(ext)s")}).prepare_filename(info)
        except Exception:
            pass
        if prepared and os.path.exists(prepared):
            return prepared
        # After FFmpegExtractAudio, ext in info may still be mp4/webm
        base, _ = os.path.splitext(prepared or '')
        if base:
            for candidate_ext in ['mp3', 'm4a', 'webm', 'mp4', 'mkv', 'opus', 'wav']:
                candidate = f"{base}.{candidate_ext}"
                if os.path.exists(candidate):
                    return candidate

    for candidate_ext in ['mp3', 'm4a', 'webm', 'mp4', 'mkv', 'opus', 'wav']:
        candidate = os.path.join(search_dir, f"{job_id}.{candidate_ext}")
        if os.path.exists(candidate):
            return candidate
    return None


def _yt_extract_audio_if_needed(filepath: str, job_id: str):
    """If download landed as video container, extract audio to m4a for Demucs."""
    ext = os.path.splitext(filepath)[1].lower()
    if ext in ('.m4a', '.mp3', '.wav', '.opus', '.flac', '.ogg'):
        return filepath
    out_path = os.path.join(UPLOAD_DIR, f"{job_id}.m4a")
    cmd = [
        _ffmpeg_bin(), "-y", "-i", filepath,
        "-vn", "-c:a", "aac", "-b:a", "192k",
        out_path,
    ]
    subprocess.run(cmd, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    try:
        os.remove(filepath)
    except OSError:
        pass
    return out_path


def run_yt_import(url: str, job_id: str, is_video: bool):
    yt_import_status[job_id] = {"status": "downloading", "progress": 0}
    
    def hook(d):
        if d['status'] == 'downloading':
            try:
                pct_str = d.get('_percent_str', '0%').replace('\x1b[0;94m', '').replace('\x1b[0m', '').strip()
                if pct_str.endswith('%'):
                    pct = float(pct_str[:-1])
                    yt_import_status[job_id]["progress"] = pct
            except Exception:
                pass
        elif d['status'] == 'finished':
            yt_import_status[job_id]["progress"] = 95
            yt_import_status[job_id]["status"] = "processing"

    out_template = os.path.join(UPLOAD_DIR, f"{job_id}.%(ext)s")
    
    # android_vr still serves real audio URLs; web/android often hit SABR and fall back to slow progressive video
    ydl_opts = {
        'outtmpl': out_template,
        'progress_hooks': [hook],
        'quiet': True,
        'no_warnings': True,
        'extractor_args': {'youtube': {'player_client': ['android_vr', 'android', 'ios']}},
        'concurrent_fragment_downloads': 4,
        **_ydl_ffmpeg_opts(),
    }
    
    if is_video:
        ydl_opts['format'] = 'bestvideo[height<=720]+bestaudio/best[height<=720]/best'
        ydl_opts['merge_output_format'] = 'mp4'
    else:
        # Audio-only for Stem Separator — skip forced MP3 convert (was the slow step)
        ydl_opts['format'] = 'bestaudio[ext=m4a]/bestaudio/best'

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            info = ydl.extract_info(url, download=True)
            title = info.get('title', 'Unknown')
            
            if 'entries' in info and info['entries']:
                info = info['entries'][0]
                title = info.get('title', title)
            
            expected_file = _yt_find_downloaded_file(job_id, UPLOAD_DIR, info)
            if not expected_file:
                raise Exception("File tidak ditemukan setelah download")

            if not is_video:
                yt_import_status[job_id]["status"] = "processing"
                yt_import_status[job_id]["progress"] = 97
                expected_file = _yt_extract_audio_if_needed(expected_file, job_id)

            if not os.path.exists(expected_file):
                raise Exception("File tidak ditemukan setelah download")
            
            ext = os.path.splitext(expected_file)[1].lstrip('.')
            filename = f"{job_id}.{ext}"
            _ensure_project_meta(job_id, f"{title}.{ext}")
            
            yt_import_status[job_id]["title"] = title
            yt_import_status[job_id]["filename"] = filename
            yt_import_status[job_id]["status"] = "done"
            yt_import_status[job_id]["progress"] = 100
            print(f"[YT Import] Done: {title} -> {filename}")
            
    except Exception as e:
        error_msg = re.sub(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])', '', str(e))
        # Keep message short for UI
        if len(error_msg) > 220:
            error_msg = error_msg[:220] + '...'
        print(f"[YT Import Error] {error_msg}")
        yt_import_status[job_id]["status"] = "error"
        yt_import_status[job_id]["error"] = f"Gagal: {error_msg}"

@app.post("/import/youtube/prepare")
async def yt_import_prepare(req: YtImportRequest, background_tasks: BackgroundTasks, current_user: dict = Depends(get_current_user)):
    url = req.url.strip()
    if not url or not re.search(r'(youtube\.com|youtu\.be)', url, re.I):
        raise HTTPException(status_code=400, detail="URL YouTube tidak valid")
    if re.search(r'youtube\.com/watch\?v=?$', url, re.I) or url.rstrip('/').endswith('youtu.be'):
        raise HTTPException(status_code=400, detail="URL YouTube tidak lengkap (ID video kosong)")
    job_id = str(uuid.uuid4())
    yt_import_status[job_id] = {"status": "downloading", "progress": 0}
    background_tasks.add_task(run_yt_import, url, job_id, req.is_video)
    return {"job_id": job_id}

@app.get("/import/youtube/status/{job_id}")
async def yt_import_get_status(job_id: str):
    return yt_import_status.get(job_id, {"status": "unknown"})

# ============================================
# YOUTUBE TO MP3 ROUTES
# ============================================
import yt_dlp

YT2MP3_DIR = os.path.join(app_data, "yt2mp3_downloads")
os.makedirs(YT2MP3_DIR, exist_ok=True)

yt2mp3_status = {}

class Yt2Mp3Request(BaseModel):
    url: str

def run_yt2mp3_download(url: str, job_id: str):
    yt2mp3_status[job_id] = {"status": "downloading", "progress": 5, "title": "", "filename": ""}
    
    def hook(d):
        if d['status'] == 'downloading':
            try:
                # Remove ANSI escape sequences from percentage
                pct_str = d.get('_percent_str', '0%').replace('\x1b[0;94m', '').replace('\x1b[0m', '').strip()
                if pct_str.endswith('%'):
                    pct = float(pct_str[:-1])
                    new_prog = 10 + int(pct * 0.8)
                    # Hanya maju, tidak boleh mundur
                    if new_prog > yt2mp3_status[job_id]["progress"]:
                        yt2mp3_status[job_id]["progress"] = new_prog
            except:
                pass
        elif d['status'] == 'finished':
            yt2mp3_status[job_id]["progress"] = 90
            
    ydl_opts = {
        'format': 'bestaudio[ext=m4a]/bestaudio/best',
        'outtmpl': os.path.join(YT2MP3_DIR, f"{job_id}.%(ext)s"),
        'postprocessors': [{
            'key': 'FFmpegExtractAudio',
            'preferredcodec': 'mp3',
            'preferredquality': '192',
        }],
        'progress_hooks': [hook],
        'quiet': True,
        'no_warnings': True,
        'extractor_args': {'youtube': {'player_client': ['android_vr', 'android', 'ios']}},
        'concurrent_fragment_downloads': 4,
        **_ydl_ffmpeg_opts(),
    }
    
    if not _resolve_ffmpeg_dir():
        yt2mp3_status[job_id]["status"] = "error"
        yt2mp3_status[job_id]["error"] = (
            "FFmpeg tidak ditemukan. Pastikan folder portable utuh "
            "(ada ffmpeg.exe di dalam folder _internal), lalu buka ulang aplikasi."
        )
        return

    try:
        with yt_dlp.YoutubeDL(ydl_opts) as ydl:
            if url.startswith("smartsearch:"):
                query = url.replace("smartsearch:", "", 1)
                try:
                    # Coba SoundCloud dulu (sangat cepat, minim throttle)
                    info = ydl.extract_info(f"scsearch1:{query}", download=True)
                except Exception:
                    # Fallback ke YouTube jika tidak ditemukan di SoundCloud
                    info = ydl.extract_info(f"ytsearch1:{query}", download=True)
            else:
                info = ydl.extract_info(url, download=True)
            
            if 'entries' in info and len(info['entries']) > 0:
                title = info['entries'][0].get('title', 'Unknown')
            else:
                title = info.get('title', 'Unknown')
                
            yt2mp3_status[job_id]["title"] = title
            yt2mp3_status[job_id]["filename"] = f"{job_id}.mp3"
            yt2mp3_status[job_id]["status"] = "done"
            yt2mp3_status[job_id]["progress"] = 100
    except Exception as e:
        import re
        error_msg = re.sub(r'\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])', '', str(e))
        print(f"YT2MP3 Error: {error_msg}")
        yt2mp3_status[job_id]["status"] = "error"
        if 'ffmpeg' in error_msg.lower() or 'ffprobe' in error_msg.lower():
            yt2mp3_status[job_id]["error"] = (
                "Gagal mengunduh audio: FFmpeg tidak terdeteksi. "
                "Pastikan folder portable lengkap (ffmpeg.exe di _internal)."
            )
        else:
            yt2mp3_status[job_id]["error"] = f"Gagal mengunduh audio: {error_msg}"

from tab_scraper import search_tab_data

class TabSearchRequest(BaseModel):
    query: str

@app.post("/tabs/search_online")
async def search_tab_online(request: TabSearchRequest):
    if not request.query:
        raise HTTPException(status_code=400, detail="Query tidak boleh kosong")
        
    try:
        result = search_tab_data(request.query)
        if "error" in result:
            raise HTTPException(status_code=400, detail=result["error"])
        
        return result
    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

class SearchRequest(BaseModel):
    query: str

@app.post("/youtube-to-mp3/search")
async def yt2mp3_search(req: SearchRequest, current_user: dict = Depends(get_current_user)):
    query = req.query.strip()
    results = []
    
    ydl_opts = {
        'quiet': True,
        'extract_flat': True,
        'no_warnings': True,
    }
    
    if query.startswith("http"):
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                info = ydl.extract_info(query, download=False)
                results.append({
                    "title": info.get("title", "Unknown"),
                    "url": query,
                    "duration": info.get("duration"),
                    "source": "Direct Link"
                })
        except Exception:
            pass
    else:
        try:
            with yt_dlp.YoutubeDL(ydl_opts) as ydl:
                # Get from SoundCloud
                try:
                    sc_info = ydl.extract_info(f"scsearch3:{query}", download=False)
                    if 'entries' in sc_info:
                        for entry in sc_info['entries']:
                            results.append({
                                "title": entry.get("title", "Unknown"),
                                "url": entry.get("url"),
                                "duration": entry.get("duration"),
                                "source": "SoundCloud"
                            })
                except Exception:
                    pass
                
                # Get from YouTube
                try:
                    yt_info = ydl.extract_info(f"ytsearch3:{query}", download=False)
                    if 'entries' in yt_info:
                        for entry in yt_info['entries']:
                            results.append({
                                "title": entry.get("title", "Unknown"),
                                "url": entry.get("url"),
                                "duration": entry.get("duration"),
                                "source": "YouTube"
                            })
                except Exception:
                    pass
        except Exception:
            pass
            
    return {"results": results}

@app.post("/youtube-to-mp3/prepare")
async def yt2mp3_prepare(req: Yt2Mp3Request, background_tasks: BackgroundTasks, current_user: dict = Depends(get_current_user)):
    job_id = str(uuid.uuid4())
    url = req.url.strip()
    if not url.startswith("http"):
        url = f"smartsearch:{url}"
    background_tasks.add_task(run_yt2mp3_download, url, job_id)
    return {"job_id": job_id}

@app.get("/youtube-to-mp3/status/{job_id}")
async def yt2mp3_get_status(job_id: str):
    return yt2mp3_status.get(job_id, {"status": "unknown"})

@app.get("/youtube-to-mp3/download/{job_id}")
async def yt2mp3_download(job_id: str):
    info = yt2mp3_status.get(job_id)
    if not info or info["status"] != "done":
        return JSONResponse(status_code=404, content={"message": "Not ready"})
    
    filepath = os.path.join(YT2MP3_DIR, f"{job_id}.mp3")
    if not os.path.exists(filepath):
        return JSONResponse(status_code=404, content={"message": "File not found on disk"})
    
    safe_title = "".join(c for c in info.get("title", "audio") if c.isalnum() or c in (' ', '-', '_')).rstrip()
    download_name = f"{safe_title}.mp3"
    
    return FileResponse(filepath, media_type="audio/mpeg", filename=download_name)

# ============================================
# FRONTEND & SPA CATCH-ALL
# ============================================
import sys
IS_BUNDLED = getattr(sys, 'frozen', False) and hasattr(sys, '_MEIPASS')

if IS_BUNDLED:
    # Serve frontend static files from bundled dist directory
    import sys
    FRONTEND_DIR = os.path.join(sys._MEIPASS, 'frontend_dist')
else:
    FRONTEND_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'frontend', 'dist')

if os.path.exists(FRONTEND_DIR):
    # Serve static assets (JS, CSS, images)
    assets_dir = os.path.join(FRONTEND_DIR, 'assets')
    if os.path.exists(assets_dir):
        app.mount("/assets", StaticFiles(directory=assets_dir), name="assets")
    
    @app.get("/")
    async def serve_frontend():
        index_path = os.path.join(FRONTEND_DIR, 'index.html')
        if os.path.exists(index_path):
            return FileResponse(index_path)
        return JSONResponse(content={"message": "JagatAudio API is running"})
    
    @app.get("/{full_path:path}")
    async def serve_frontend_fallback(full_path: str):
        # Try to serve static file first
        file_path = os.path.join(FRONTEND_DIR, full_path)
        if os.path.exists(file_path) and os.path.isfile(file_path):
            return FileResponse(file_path)
        # Fallback to index.html for SPA routing
        index_path = os.path.join(FRONTEND_DIR, 'index.html')
        if os.path.exists(index_path):
            return FileResponse(index_path)
        return JSONResponse(status_code=404, content={"message": "Not found"})

APP_HOST = "127.0.0.1"
APP_PORT = 8000
APP_URL = f"http://{APP_HOST}:{APP_PORT}"


def _server_is_running() -> bool:
    import urllib.request
    try:
        with urllib.request.urlopen(f"{APP_URL}/license/status", timeout=2) as resp:
            return resp.status == 200
    except Exception:
        return False


def _port_is_listening(port: int) -> bool:
    import socket
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        return sock.connect_ex((APP_HOST, port)) == 0


def _win_creationflags():
    if sys.platform == "win32":
        return getattr(subprocess, "CREATE_NO_WINDOW", 0)
    return 0


def _kill_processes_on_port(port: int) -> None:
    if sys.platform != "win32":
        return
    try:
        result = subprocess.run(
            ["netstat", "-ano"],
            capture_output=True,
            text=True,
            timeout=10,
            creationflags=_win_creationflags(),
        )
        pids = set()
        for line in result.stdout.splitlines():
            if f":{port}" not in line or "LISTENING" not in line:
                continue
            parts = line.split()
            if parts and parts[-1].isdigit():
                pid = int(parts[-1])
                if pid != os.getpid():
                    pids.add(str(pid))
        for pid in pids:
            subprocess.run(
                ["taskkill", "/F", "/PID", pid],
                capture_output=True,
                creationflags=_win_creationflags(),
            )
    except Exception:
        pass


def _show_windows_message(title: str, message: str) -> None:
    if sys.platform != "win32":
        return
    try:
        import ctypes
        ctypes.windll.user32.MessageBoxW(0, message, title, 0x10)
    except Exception:
        pass


def _prepare_bundled_startup() -> str:
    """
    Returns:
      'focus'  - server already running, caller should open browser and exit
      'start'  - safe to start uvicorn
      'blocked' - port still busy after cleanup
    """
    import time

    if _server_is_running():
        return "focus"

    if _port_is_listening(APP_PORT):
        _kill_processes_on_port(APP_PORT)
        time.sleep(0.6)
        if _server_is_running():
            return "focus"

    if _port_is_listening(APP_PORT) and not _server_is_running():
        return "blocked"
    return "start"


if __name__ == "__main__":
    import uvicorn
    import sys
    import threading
    import webbrowser
    import time
    
    if IS_BUNDLED:
        # Prevent uvicorn 'isatty' error in noconsole mode
        if sys.stdout is None or sys.stderr is None:
            class DummyStream:
                encoding = 'utf-8'
                def write(self, data): pass
                def flush(self): pass
                def isatty(self): return False
                def fileno(self): return -1
            sys.stdout = DummyStream()
            sys.stderr = DummyStream()

        startup_mode = _prepare_bundled_startup()
        if startup_mode == "focus":
            if splash_proc:
                try:
                    splash_proc.terminate()
                except: pass
            webbrowser.open(APP_URL)
            sys.exit(0)
        if startup_mode == "blocked":
            if splash_proc:
                try:
                    splash_proc.terminate()
                except: pass
            _show_windows_message(
                "Jagat Audio",
                "Port 8000 masih dipakai aplikasi lain.\n"
                "Tutup aplikasi tersebut lalu coba buka Jagat Audio lagi.",
            )
            sys.exit(1)
            
        def open_browser():
            time.sleep(1.5) # Wait for uvicorn to start
            if splash_proc:
                try:
                    splash_proc.terminate()
                except: pass
            webbrowser.open(APP_URL)
            
        threading.Thread(target=open_browser, daemon=True).start()
        uvicorn.run(app, host=APP_HOST, port=APP_PORT, log_config=None)
    else:
        uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
