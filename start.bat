@echo off
echo Membuka Server Backend (FastAPI)...
start "JagatAudio - Backend" cmd /k "cd backend && .\venv\Scripts\activate && python main.py"

echo Membuka Server Frontend (Vite)...
start "JagatAudio - Frontend" cmd /k "cd frontend && npm run dev"

echo Selesai! Kedua server telah dibuka di jendela terpisah.
