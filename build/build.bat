@echo off
title JagatAudio Build Script
echo ============================================
echo   JagatAudio Build Script
echo ============================================
echo.

:: Set directories
set ROOT_DIR=%~dp0..
set BACKEND_DIR=%ROOT_DIR%\backend
set FRONTEND_DIR=%ROOT_DIR%\frontend
set BUILD_DIR=%~dp0
set OUTPUT_DIR=%BUILD_DIR%\pyinstaller_output
set INSTALLER_OUTPUT=%BUILD_DIR%\installer_output

:: Step 0: Check prerequisites
echo [Step 0] Memeriksa prasyarat...
echo.

where python >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Python tidak ditemukan. Install Python terlebih dahulu.
    pause
    exit /b 1
)

where node >nul 2>nul
if %ERRORLEVEL% neq 0 (
    echo ERROR: Node.js tidak ditemukan. Install Node.js terlebih dahulu.
    pause
    exit /b 1
)

:: Step 1: Generate RSA keys if not exists
echo [Step 1] Memeriksa RSA keys...
if not exist "%BACKEND_DIR%\keys\private_key.pem" (
    echo   Generating RSA keys...
    pushd "%BACKEND_DIR%"
    python generate_license.py --gen-keys
    popd
) else (
    echo   RSA keys sudah ada. OK.
)
echo.

:: Step 2: Build frontend
echo [Step 2] Building frontend (npm run build)...
pushd "%FRONTEND_DIR%"
call npm install
call npm run build
if %ERRORLEVEL% neq 0 (
    echo ERROR: Frontend build gagal!
    popd
    pause
    exit /b 1
)
popd
echo   Frontend build selesai.
echo.

:: Step 3: Install Python dependencies
echo [Step 3] Installing Python dependencies...
pushd "%BACKEND_DIR%"
pip install -r requirements.txt
pip install pyinstaller
popd
echo.

:: Step 4: Run PyInstaller
echo [Step 4] Bundling dengan PyInstaller...
pushd "%BUILD_DIR%"

:: Clean previous build
if exist "%OUTPUT_DIR%" rmdir /s /q "%OUTPUT_DIR%"

echo Activating virtual environment...
call "%BACKEND_DIR%\venv\Scripts\activate.bat"

pyinstaller --noconfirm --distpath "%OUTPUT_DIR%" --workpath "%BUILD_DIR%\pyinstaller_work" jagataudio.spec

if %ERRORLEVEL% neq 0 (
    echo ERROR: PyInstaller build gagal!
    popd
    pause
    exit /b 1
)
popd
echo   PyInstaller build selesai.
echo.

:: Step 5: Check if Inno Setup is available
echo [Step 5] Membuat Windows Installer...
where iscc >nul 2>nul
if %ERRORLEVEL% neq 0 (
    :: Try common install paths
    if exist "C:\Program Files (x86)\Inno Setup 6\ISCC.exe" (
        set ISCC="C:\Program Files (x86)\Inno Setup 6\ISCC.exe"
    ) else if exist "C:\Program Files\Inno Setup 6\ISCC.exe" (
        set ISCC="C:\Program Files\Inno Setup 6\ISCC.exe"
    ) else (
        echo   WARNING: Inno Setup tidak ditemukan.
        echo   Download dari: https://jrsoftware.org/isdl.php
        echo   PyInstaller output tersedia di: %OUTPUT_DIR%\JagatAudio\
        echo.
        echo   Anda bisa menjalankan JagatAudio.exe langsung dari folder tersebut.
        goto :done
    )
) else (
    set ISCC=iscc
)

:: Create installer output dir
if not exist "%INSTALLER_OUTPUT%" mkdir "%INSTALLER_OUTPUT%"

:: Create a simple LICENSE.txt if not exists
if not exist "%BUILD_DIR%\LICENSE.txt" (
    echo JagatAudio License Agreement > "%BUILD_DIR%\LICENSE.txt"
    echo. >> "%BUILD_DIR%\LICENSE.txt"
    echo Software ini dilindungi oleh hak cipta. >> "%BUILD_DIR%\LICENSE.txt"
    echo Penggunaan tanpa lisensi yang valid adalah pelanggaran hukum. >> "%BUILD_DIR%\LICENSE.txt"
    echo. >> "%BUILD_DIR%\LICENSE.txt"
    echo Dengan menginstall software ini, Anda menyetujui ketentuan penggunaan. >> "%BUILD_DIR%\LICENSE.txt"
)

%ISCC% "%BUILD_DIR%\installer.iss"

if %ERRORLEVEL% neq 0 (
    echo   WARNING: Inno Setup compile gagal.
    echo   Tapi PyInstaller output sudah tersedia di: %OUTPUT_DIR%\JagatAudio\
) else (
    echo   Installer berhasil dibuat!
    echo   Output: %INSTALLER_OUTPUT%\
)

:done
echo.
echo ============================================
echo   Build Selesai!
echo ============================================
echo.
echo Output:
echo   PyInstaller: %OUTPUT_DIR%\JagatAudio\
if exist "%INSTALLER_OUTPUT%\*.exe" (
    echo   Installer:   %INSTALLER_OUTPUT%\
)
echo.
echo Catatan:
echo   - Pastikan FFmpeg sudah terinstall di PC target
echo   - Private key (keys/private_key.pem) JANGAN didistribusikan
echo   - Gunakan generate_license.py untuk membuat lisensi customer
echo.
pause
