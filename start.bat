@echo off
echo Membersihkan proses server lama jika ada...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":8000" ^| findstr "LISTENING"') do taskkill /f /pid %%a 2>nul
for /f "tokens=5" %%a in ('netstat -aon ^| findstr ":7001" ^| findstr "LISTENING"') do taskkill /f /pid %%a 2>nul

echo.
echo Membuka Server Backend (FastAPI)...
start "JagatAudio - Backend" cmd /k "cd backend && .\venv\Scripts\activate && python main.py"

echo Membuka Server Frontend (Vite)...
start "JagatAudio - Frontend" cmd /k "cd frontend && npm run dev"

echo Selesai! Kedua server telah dibuka di jendela terpisah.
