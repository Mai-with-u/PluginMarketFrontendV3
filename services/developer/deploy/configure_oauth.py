"""Interactive secret entry: prompts without echoing or placing secrets in shell history."""

from getpass import getpass
from pathlib import Path
import os
import re
import subprocess


if os.geteuid() != 0:
    raise SystemExit("Run with sudo")
path = Path("/etc/maibot-developer/service.env")
lines = path.read_text().splitlines()
client_id = next(line.partition("=")[2] for line in lines if line.startswith("GITHUB_CLIENT_ID="))
if not client_id:
    client_id = input("GitHub Client ID: ").strip()
else:
    print("GitHub Client ID:", client_id)
client_secret = getpass("GitHub Client Secret (hidden): ").strip()
if not re.fullmatch(r"[A-Za-z0-9_]{10,100}", client_id) or not re.fullmatch(
    r"[A-Za-z0-9_]{20,200}", client_secret
):
    raise SystemExit("Invalid format; no configuration was changed")
updated = []
for line in lines:
    if line.startswith("GITHUB_CLIENT_ID="):
        line = "GITHUB_CLIENT_ID=" + client_id
    if line.startswith("GITHUB_CLIENT_SECRET="):
        line = "GITHUB_CLIENT_SECRET=" + client_secret
    updated.append(line)
with path.open("w") as file:
    file.write("\n".join(updated) + "\n")
path.chmod(0o600)
subprocess.run(["systemctl", "restart", "maibot-developer.service"], check=True)
print("OAuth configured. Only the developer service was restarted.")
