@echo off
title Build License Generator
echo ============================================
echo   Membangun LicenseGenerator.exe
echo ============================================
echo.

set ROOT_DIR=%~dp0
set BACKEND_DIR=%ROOT_DIR%backend
set BUILD_DIR=%ROOT_DIR%build
set OUTPUT_DIR=%ROOT_DIR%LicenseAdmin

echo Activating virtual environment...
call "%BACKEND_DIR%\venv\Scripts\activate.bat"

echo.
echo Menjalankan PyInstaller...
:: Build standalone executable (-F = onefile, -w = noconsole)
pyinstaller --noconfirm --onefile --windowed --name "LicenseGenerator" --distpath "%OUTPUT_DIR%" --workpath "%BUILD_DIR%\pyinstaller_work_gui" --specpath "%BUILD_DIR%" --add-data "%BACKEND_DIR%\keys\private_key.pem;keys" "%BACKEND_DIR%\license_gui.py"

if %ERRORLEVEL% neq 0 (
    echo.
    echo ERROR: PyInstaller gagal!
    pause
    exit /b 1
)

echo.
echo ============================================
echo   SELESAI!
echo   Aplikasi berhasil dibuat di folder:
echo   %OUTPUT_DIR%\LicenseGenerator.exe
echo ============================================
pause
