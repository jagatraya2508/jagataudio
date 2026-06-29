import sqlite3
import os
import sys

if getattr(sys, 'frozen', False):
    app_data = os.path.join(os.environ.get('APPDATA', ''), 'JagatAudio')
else:
    app_data = os.path.dirname(os.path.abspath(__file__))

os.makedirs(app_data, exist_ok=True)
DB_PATH = os.path.join(app_data, "jagataudio.db")

def init_db():
    conn = sqlite3.connect(DB_PATH)
    cursor = conn.cursor()
    cursor.execute('''
        CREATE TABLE IF NOT EXISTS users (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            username TEXT UNIQUE NOT NULL,
            email TEXT UNIQUE,
            password_hash TEXT NOT NULL,
            is_admin INTEGER DEFAULT 0
        )
    ''')
    # Migration: add columns if table already exists without them
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN is_admin INTEGER DEFAULT 0")
    except sqlite3.OperationalError:
        pass  # Column already exists
    try:
        cursor.execute("ALTER TABLE users ADD COLUMN email TEXT UNIQUE")
    except sqlite3.OperationalError:
        pass  # Column already exists
    conn.commit()
    conn.close()

def get_db():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn

# Initialize on import
init_db()
