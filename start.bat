@echo off
REM 뉴스 대시보드 원클릭 실행 (Windows). 더블클릭하거나 명령창에서 start.bat 실행.
cd /d "%~dp0"

REM 인자(%*)는 run.py 로 그대로 넘긴다: --quick, --no-browser
REM py 런처가 있으면 우선 사용, 없으면 python 사용
where py >nul 2>nul
if %errorlevel%==0 (
    py run.py %*
) else (
    python run.py %*
)

echo.
pause
