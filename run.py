#!/usr/bin/env python3
"""뉴스 대시보드 원클릭 실행기.

의존성 설치 → 프론트 빌드 → 백엔드(FastAPI) 실행 → 브라우저 열기까지 한 번에.
FastAPI 가 빌드된 프론트(frontend/dist)까지 같은 포트(8000)에서 서빙하므로
브라우저 하나만 열면 웹앱이 뜬다.

사용법:
    python run.py           # 또는 Windows: start.bat 더블클릭

요구사항: Python 3.10+, Node.js 18+ (프론트 빌드용).
네이버 API 키는 선택(없어도 RSS·보안뉴스 채널은 동작).
"""
import os
import shutil
import subprocess
import sys
import time
import urllib.request
import webbrowser

# Windows 기본 콘솔(cp949)에서 한글·기호 출력 시 UnicodeEncodeError 방지.
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(encoding="utf-8")
    except Exception:
        pass

ROOT = os.path.dirname(os.path.abspath(__file__))
BACKEND = os.path.join(ROOT, "backend")
FRONTEND = os.path.join(ROOT, "frontend")
PORT = int(os.environ.get("PORT", "8000"))
URL = f"http://localhost:{PORT}"


def info(msg):
    print(f"\n\033[36m▶ {msg}\033[0m")


def die(msg):
    print(f"\n\033[31m✖ {msg}\033[0m")
    sys.exit(1)


def run(cmd, cwd=None):
    print(f"  $ {' '.join(cmd)}")
    subprocess.run(cmd, cwd=cwd, check=True)


def run_npm(args, cwd):
    npm = shutil.which("npm")
    if not npm:
        die("npm(Node.js)을 찾을 수 없습니다. https://nodejs.org 에서 설치 후 다시 실행하세요.")
    print(f"  $ npm {' '.join(args)}")
    if os.name == "nt":
        # Windows 의 npm 은 .cmd 라 shell 을 통해 실행한다.
        subprocess.run(f'"{npm}" {" ".join(args)}', cwd=cwd, check=True, shell=True)
    else:
        subprocess.run([npm, *args], cwd=cwd, check=True)


def ensure_env():
    env_path = os.path.join(BACKEND, ".env")
    example = os.path.join(BACKEND, ".env.example")
    if not os.path.exists(env_path) and os.path.exists(example):
        shutil.copyfile(example, env_path)
        print(
            "  · backend/.env 를 생성했습니다. 네이버 뉴스까지 쓰려면 "
            "NAVER_CLIENT_ID/SECRET 를 채우세요(https://developers.naver.com).\n"
            "    지금 이대로도 RSS·보안뉴스 채널은 정상 동작합니다."
        )


def main():
    # 1) 파이썬 의존성
    info("파이썬 의존성 설치 (backend/requirements.txt)")
    run([sys.executable, "-m", "pip", "install", "-q", "-r",
         os.path.join(BACKEND, "requirements.txt")])

    # 2) .env 준비
    info("환경설정 확인")
    ensure_env()

    # 3) 프론트 빌드 (dist 는 gitignore 라 항상 빌드)
    info("프론트엔드 빌드")
    if not os.path.isdir(os.path.join(FRONTEND, "node_modules")):
        run_npm(["install"], cwd=FRONTEND)
    run_npm(["run", "build"], cwd=FRONTEND)
    if not os.path.isdir(os.path.join(FRONTEND, "dist")):
        die("프론트 빌드 산출물(frontend/dist)이 없습니다. 위 npm 로그를 확인하세요.")

    # 4) 백엔드 실행 (cwd=backend 필수: .env / news.db 가 상대경로)
    info(f"서버 시작 → {URL}")
    child_env = {**os.environ, "PYTHONUTF8": "1", "PYTHONIOENCODING": "utf-8"}
    proc = subprocess.Popen(
        [sys.executable, "-m", "uvicorn", "main:app", "--port", str(PORT)],
        cwd=BACKEND,
        env=child_env,
    )

    # 5) 서버가 응답하면 브라우저 열기
    for _ in range(60):
        if proc.poll() is not None:
            die("서버가 예기치 않게 종료됐습니다. 위 로그를 확인하세요.")
        try:
            urllib.request.urlopen(f"{URL}/api/keywords", timeout=2)
            break
        except Exception:
            time.sleep(1)
    print(f"\n\033[32m✔ 실행 중: {URL}  (종료: Ctrl+C)\033[0m\n")
    try:
        webbrowser.open(URL)
    except Exception:
        pass

    # 서버 프로세스가 끝날 때까지 대기
    try:
        proc.wait()
    except KeyboardInterrupt:
        print("\n종료 중…")
        proc.terminate()


if __name__ == "__main__":
    try:
        main()
    except subprocess.CalledProcessError as e:
        die(f"명령 실패 (exit {e.returncode}). 위 로그를 확인하세요.")
