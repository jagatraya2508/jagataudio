from fastapi import FastAPI, UploadFile, File, BackgroundTasks, Depends, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
from fastapi.security import OAuth2PasswordRequestForm
import os
import shutil
import subprocess
import uuid
from auth import get_password_hash, verify_password, create_access_token, get_current_user
from database import get_db
from pydantic import BaseModel

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

UPLOAD_DIR = "uploads"
OUTPUT_DIR = "separated"

os.makedirs(UPLOAD_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

# Keep track of status
separation_status = {}

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
    db = get_db()
    cursor = db.cursor()
    cursor.execute("SELECT id, username, password_hash, is_admin FROM users WHERE username = ?", (form_data.username,))
    user = cursor.fetchone()
    db.close()
    
    if not user or not verify_password(form_data.password, user['password_hash']):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Incorrect username or password",
            headers={"WWW-Authenticate": "Bearer"},
        )
    
    access_token = create_access_token(data={"sub": user['username']})
    return {"access_token": access_token, "token_type": "bearer", "is_admin": bool(user['is_admin'])}

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
        
    return {"file_id": file_id, "filename": file.filename, "filepath": filepath}

def run_demucs(filepath: str, file_id: str):
    try:
        separation_status[file_id] = {"status": "processing", "progress": 0, "eta": "Menghitung..."}
        import sys
        import re
        import traceback
        command = [
            sys.executable, "-m", "demucs",
            "-n", "htdemucs_6s",
            "-o", OUTPUT_DIR,
            "--mp3",
            filepath
        ]
        
        process = subprocess.Popen(command, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, universal_newlines=True, encoding='utf-8', errors='replace')
        
        buf = ""
        logs = []
        while True:
            char = process.stdout.read(1)
            if not char:
                break
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
                
        process.wait()
        
        if process.returncode == 0:
            separation_status[file_id]["status"] = "done"
            separation_status[file_id]["progress"] = 100
            separation_status[file_id]["eta"] = "00:00"
        else:
            print(f"Demucs failed with returncode: {process.returncode}")
            print("Demucs execution logs:")
            for log_line in logs:
                print("  DEMUCS:", log_line)
            separation_status[file_id]["status"] = "error"
    except Exception as e:
        import traceback
        traceback.print_exc()
        print("Exception in run_demucs:", str(e))
        separation_status[file_id] = {"status": "error", "progress": 0, "eta": ""}

@app.post("/separate/{file_id}")
async def separate_audio(file_id: str, background_tasks: BackgroundTasks, current_user: dict = Depends(get_current_user)):
    # Find file
    files = [f for f in os.listdir(UPLOAD_DIR) if f.startswith(file_id)]
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
    files = [f for f in os.listdir(UPLOAD_DIR) if f.startswith(file_id)]
    if not files:
        return JSONResponse(status_code=404, content={"message": "File not found"})
        
    filename = files[0]
    filename_no_ext = os.path.splitext(filename)[0]
    
    stem_dir = os.path.join(OUTPUT_DIR, "htdemucs_6s", filename_no_ext)
    
    if not os.path.exists(stem_dir):
        return JSONResponse(status_code=404, content={"message": "Stems not found or not ready"})
        
    stems = os.listdir(stem_dir)
    return {"stems": stems, "file_id": file_id}

@app.get("/audio/{file_id}/{stem_name}")
async def get_audio(file_id: str, stem_name: str):
    # Note: Audio is served to frontend audio player, which might not easily send headers in <audio src>.
    # We leave this unprotected or protect via query token if needed.
    files = [f for f in os.listdir(UPLOAD_DIR) if f.startswith(file_id)]
    if not files:
        return JSONResponse(status_code=404, content={"message": "File not found"})
        
    filename = files[0]
    filename_no_ext = os.path.splitext(filename)[0]
    
    filepath = os.path.join(OUTPUT_DIR, "htdemucs_6s", filename_no_ext, stem_name)
    
    if not os.path.exists(filepath):
        return JSONResponse(status_code=404, content={"message": "Stem not found"})
        
    return FileResponse(filepath)

from pydantic import BaseModel
from typing import Dict

class MixParams(BaseModel):
    volumes: Dict[str, float]
    mutes: Dict[str, bool]
    pitch: float
    tempo: float

@app.post("/export/{file_id}")
async def export_mix(file_id: str, params: MixParams, current_user: dict = Depends(get_current_user)):
    files = [f for f in os.listdir(UPLOAD_DIR) if f.startswith(file_id)]
    if not files:
        return JSONResponse(status_code=404, content={"message": "File not found"})
        
    filename = files[0]
    filename_no_ext = os.path.splitext(filename)[0]
    
    stem_dir = os.path.join(OUTPUT_DIR, "htdemucs_6s", filename_no_ext)
    
    if not os.path.exists(stem_dir):
        return JSONResponse(status_code=404, content={"message": "Stems not found"})
        
    export_dir = "exports"
    os.makedirs(export_dir, exist_ok=True)
    out_filename = f"{filename_no_ext}_mix.mp3"
    out_filepath = os.path.join(export_dir, out_filename)
    
    command = ["ffmpeg", "-y"]
    inputs = []
    filters = []
    input_idx = 0
    
    instruments = ["vocals", "drums", "bass", "guitar", "piano", "other"]
    
    for inst in instruments:
        if not params.mutes.get(inst, False):
            stem_file = os.path.join(stem_dir, f"{inst}.mp3")
            if os.path.exists(stem_file):
                command.extend(["-i", stem_file])
                vol = params.volumes.get(inst, 0)
                filters.append(f"[{input_idx}:a]volume={vol}dB[a{input_idx}]")
                input_idx += 1
                
    if input_idx == 0:
        return JSONResponse(status_code=400, content={"message": "All tracks are muted"})
        
    mix_inputs = "".join([f"[a{i}]" for i in range(input_idx)])
    filters.append(f"{mix_inputs}amix=inputs={input_idx}:normalize=0[mix]")
    
    pitch = params.pitch
    tempo = params.tempo
    
    if pitch != 0 or tempo != 1.0:
        filters.append(f"[mix]rubberband=pitch={pitch}:tempo={tempo}[out]")
        map_out = "[out]"
    else:
        map_out = "[mix]"
        
    filter_complex = "; ".join(filters)
    command.extend(["-filter_complex", filter_complex, "-map", map_out, "-c:a", "libmp3lame", "-b:a", "320k", out_filepath])
    
    try:
        subprocess.run(command, check=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        return {"status": "success", "download_url": f"/download_export/{out_filename}"}
    except subprocess.CalledProcessError as e:
        print("FFmpeg error:", e.stderr.decode('utf-8', errors='replace'))
        return JSONResponse(status_code=500, content={"message": "Error exporting mix"})

@app.get("/download_export/{filename}")
async def download_export(filename: str):
    filepath = os.path.join("exports", filename)
    if not os.path.exists(filepath):
        return JSONResponse(status_code=404, content={"message": "File not found"})
    return FileResponse(filepath, media_type="audio/mpeg", filename=filename)

from tab_generator import generate_tab_from_audio

tab_status = {}

def run_tab_generator(filepath: str, file_id: str):
    tab_status[file_id] = {"status": "processing", "progress": 10}
    try:
        tab_dir = "tabs"
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
    files = [f for f in os.listdir(UPLOAD_DIR) if f.startswith(file_id)]
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
    filepath = os.path.join("tabs", filename)
    if not os.path.exists(filepath):
        return JSONResponse(status_code=404, content={"message": "File not found"})
    return FileResponse(filepath, media_type="text/plain", filename=filename)

if __name__ == "__main__":
    import uvicorn
    uvicorn.run("main:app", host="0.0.0.0", port=8000, reload=True)
