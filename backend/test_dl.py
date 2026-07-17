import sys
import os
import subprocess

url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw'
is_video = True
job_id = 'test_job'
UPLOAD_DIR = 'uploads'
os.makedirs(UPLOAD_DIR, exist_ok=True)

fmt = 'bestvideo[ext=mp4][height<=720]+bestaudio[ext=m4a]/best[ext=mp4][height<=720]/bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'
ext = 'mp4'

out_template = os.path.join(UPLOAD_DIR, f"{job_id}.%(ext)s")

cmd = [
    sys.executable, '-m', 'yt_dlp',
    '--format', fmt,
    '--output', out_template,
    '--newline',
    '--no-warnings',
    '--extractor-args', 'youtube:player_client=ios,android',
    '--js-runtimes', 'node,deno',
    '--concurrent-fragments', '5',
    '--print', 'after_move:filepath',
    '--print', 'before_dl:%(title)s',
    url
]

print(f"Running command: {' '.join(cmd)}")

proc = subprocess.Popen(
    cmd,
    stdout=subprocess.PIPE,
    stderr=subprocess.STDOUT,
    text=True,
    encoding='utf-8',
    errors='replace'
)

for line in proc.stdout:
    print(line.strip())

proc.wait()
print(f"Return code: {proc.returncode}")
