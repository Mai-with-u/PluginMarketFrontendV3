"""Run as root after unpacking this release into /opt/maibot-developer.

Does not modify the old service, its Python environment, or its database.
Does not activate public routing. Existing secrets are never overwritten.
"""

from base64 import urlsafe_b64encode
from pathlib import Path
import grp
import os
import pwd
import secrets
import shutil
import subprocess


def run(*args: str) -> None:
    subprocess.run(args, check=True)


if os.geteuid() != 0:
    raise SystemExit("Run as root")
root = Path("/opt/maibot-developer")
if Path(__file__).resolve().parents[1] != root:
    raise SystemExit("Unpack the release into /opt/maibot-developer first")
try:
    account = pwd.getpwnam("maibot-developer")
except KeyError:
    run(
        "useradd",
        "--system",
        "--home",
        "/nonexistent",
        "--shell",
        "/usr/sbin/nologin",
        "maibot-developer",
    )
    account = pwd.getpwnam("maibot-developer")
group_id = grp.getgrnam("maibot-developer").gr_gid
config = Path("/etc/maibot-developer")
config.mkdir(mode=0o700, exist_ok=True)
for path, owner in [
    (Path("/var/lib/maibot-developer"), account.pw_uid),
    (Path("/var/lib/maibot-developer-source"), 0),
]:
    path.mkdir(mode=0o750, exist_ok=True)
    os.chown(path, owner, group_id)
    path.chmod(0o750)
env = config / "service.env"
if not env.exists():
    content = (root / "deploy/service.env.example").read_text()
    content = content.replace(
        "ENCRYPTION_KEY=",
        "ENCRYPTION_KEY=" + urlsafe_b64encode(secrets.token_bytes(32)).decode(),
    )
    content = content.replace(
        "INGRESS_KEY=", "INGRESS_KEY=" + secrets.token_urlsafe(48)
    )
    env.write_text(content)
env.chmod(0o600)
key = config / "export.key"
if not key.exists():
    key.write_bytes(secrets.token_bytes(32))
key.chmod(0o600)
venv = root / ".venv"
if not venv.exists():
    run("/opt/py310/bin/python", "-m", "venv", str(venv))
run(
    str(venv / "bin/python"),
    "-m",
    "pip",
    "install",
    "--require-hashes",
    "-r",
    str(root / "requirements.txt"),
)
for unit in (root / "deploy").glob("*.service"):
    shutil.copyfile(unit, Path("/etc/systemd/system") / unit.name)
for unit in (root / "deploy").glob("*.timer"):
    shutil.copyfile(unit, Path("/etc/systemd/system") / unit.name)
run("systemctl", "daemon-reload")
run("systemctl", "start", "maibot-developer-export.service")
run(
    "systemctl",
    "enable",
    "--now",
    "maibot-developer.service",
    "maibot-developer-export.timer",
    "maibot-developer-notifications.timer",
)
print(
    "Independent service installed on 127.0.0.1:10061. Public routing remains unchanged."
)
