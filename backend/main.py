from fastapi import FastAPI, UploadFile, File, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse
import os
import shutil
import subprocess
import uuid

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

@app.post("/upload")
async def upload_file(file: UploadFile = File(...)):
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
async def separate_audio(file_id: str, background_tasks: BackgroundTasks):
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
async def get_stems(file_id: str):
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
async def export_mix(file_id: str, params: MixParams):
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
async def generate_tab_master(file_id: str, background_tasks: BackgroundTasks):
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
