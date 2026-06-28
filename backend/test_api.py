import requests
import time

base_url = "http://127.0.0.1:8001"
session = requests.Session()

import uuid
username = f"user_{uuid.uuid4().hex[:8]}"
email = f"{username}@test.com"

res = session.post(f"{base_url}/register", json={"username": username, "email": email, "password": "password"})
print("Register:", res.text)

login_res = session.post(f"{base_url}/login", data={"username": username, "password": "password"})
print("Login:", login_res.text)
token = login_res.json()["access_token"]
headers = {"Authorization": f"Bearer {token}"}

print("Triggering separate...")
res = session.post(f"{base_url}/separate/178a6f49", headers=headers)
print("Separate response:", res.text)

while True:
    status_res = session.get(f"{base_url}/status/178a6f49")
    data = status_res.json()
    print("Status:", data)
    if data["status"] in ["done", "error"]:
        break
    time.sleep(2)
