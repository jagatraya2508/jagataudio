# -*- mode: python ; coding: utf-8 -*-
"""
JagatAudio PyInstaller Spec File

This spec file bundles:
- Backend Python (FastAPI + uvicorn)
- Frontend static build (from npm run build)
- Public key for license verification
- FFmpeg (if bundled)

Usage:
  pyinstaller build/jagataudio.spec
"""

import os
import sys

block_cipher = None

# Paths
BACKEND_DIR = os.path.join(SPECPATH, '..', 'backend')
FRONTEND_DIST = os.path.join(SPECPATH, '..', 'frontend', 'dist')
KEYS_DIR = os.path.join(BACKEND_DIR, 'keys')

from PyInstaller.utils.hooks import collect_data_files, collect_submodules

# Collect all data and submodules for heavy ML libraries
datas = []
datas += collect_data_files('basic_pitch')
datas += collect_data_files('demucs')
datas += collect_data_files('torch')

hidden_imports = [
    'uvicorn', 'uvicorn.logging', 'uvicorn.loops', 'uvicorn.loops.auto',
    'uvicorn.protocols', 'uvicorn.protocols.http', 'uvicorn.protocols.http.auto',
    'uvicorn.protocols.websockets', 'uvicorn.protocols.websockets.auto',
    'uvicorn.lifespan', 'uvicorn.lifespan.on',
    'fastapi', 'starlette', 'starlette.middleware', 'starlette.middleware.base',
    'starlette.routing', 'starlette.responses', 'pydantic',
    'passlib', 'passlib.handlers', 'passlib.handlers.bcrypt', 'bcrypt', 'jwt',
    'cryptography', 'multipart', 'python_multipart', 'sqlite3',
    'auth', 'database', 'tab_generator', 'license_manager',
    # ML Libraries
    'basic_pitch', 'basic_pitch.inference', 'basic_pitch.models',
    'mido', 'demucs', 'demucs.api', 'demucs.apply', 'demucs.pretrained', 'demucs.htdemucs',
    'torch', 'torchaudio', 'torchvision', 'soundfile',
    # YouTube DL dependencies
    'yt_dlp', 'yt_dlp.extractor', 'yt_dlp.extractor.youtube', 'yt_dlp.postprocessor', 'yt_dlp.postprocessor.ffmpeg',
    'mutagen', 'brotli', 'certifi', 'websockets', 'urllib3'
]
hidden_imports += collect_submodules('yt_dlp')
hidden_imports += collect_submodules('basic_pitch')
hidden_imports += collect_submodules('demucs')
hidden_imports += collect_submodules('torchaudio')

# Frontend static build
if os.path.exists(FRONTEND_DIST):
    datas.append((FRONTEND_DIST, 'frontend_dist'))

# Public key for license verification (DO NOT include private key!)
public_key = os.path.join(KEYS_DIR, 'public_key.pem')
if os.path.exists(public_key):
    datas.append((public_key, 'keys'))

# Add bundled FFmpeg and FFprobe
FFMPEG_PATH = r"C:\Users\wisnu\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1.1-full_build\bin\ffmpeg.exe"
if os.path.exists(FFMPEG_PATH):
    datas.append((FFMPEG_PATH, '.'))

FFPROBE_PATH = r"C:\Users\wisnu\AppData\Local\Microsoft\WinGet\Packages\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\ffmpeg-8.1.1-full_build\bin\ffprobe.exe"
if os.path.exists(FFPROBE_PATH):
    datas.append((FFPROBE_PATH, '.'))

a = Analysis(
    [os.path.join(BACKEND_DIR, 'main.py')],
    pathex=[BACKEND_DIR],
    binaries=[],
    datas=datas,
    hiddenimports=hidden_imports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=[],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name='JagatAudio',
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=False,  # No console window
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,
    codesign_identity=None,
    entitlements_file=None,
    icon=os.path.join(SPECPATH, 'icon.ico') if os.path.exists(os.path.join(SPECPATH, 'icon.ico')) else None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.zipfiles,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name='JagatAudio',
)
