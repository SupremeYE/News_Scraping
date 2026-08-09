"""서버가 도는 동안 PC 가 절전으로 빠지지 않게 붙잡아 두는 모듈 (Windows 전용).

왜 필요한가:
    이 노트북(갤럭시북3)은 S3 절전이 없고 **Modern Standby(S0)** 만 지원한다.
    이런 기기는 전원 설정에서 "절전 모드로 전환 = 안 함" 으로 해놔도
    **화면이 꺼지는 순간 Modern Standby 로 들어간다.** 그러면 CPU/Wi-Fi 가
    저전력(DRIPS)으로 내려가면서 uvicorn 이 스로틀되고 외부(아이폰 → Tailscale)
    에서 들어오는 연결이 끊긴다. 밤새 잠금해 둔 다음 날 아침 접속이 안 되던 원인.

무엇을 하는가:
    SetThreadExecutionState(ES_SYSTEM_REQUIRED) 로 "시스템 절전 금지" 요청을 건다.
    ES_DISPLAY_REQUIRED 는 **일부러 넣지 않는다** — 화면은 그대로 꺼지게 두고
    (전력의 대부분은 화면이다) 시스템만 깨어 있게 하는 게 목적.
    CPU 부하는 없다(플래그 등록일 뿐, 폴링 루프가 아니다).

배터리 보호:
    AC 연결 중일 때만 요청을 유지하고, 코드가 빠져 배터리로 전환되면 요청을 풀어
    평소 절전 설정대로 잠들게 둔다(정전·코드 빠짐 시 방전 방지).
    그래서 60 초마다 전원 상태만 확인하는 가벼운 데몬 스레드를 하나 쓴다.

확인:
    적용됐는지는 관리자 콘솔에서 `powercfg /requests` → SYSTEM 항목에
    python.exe 가 보이면 정상.
"""
import ctypes
import os
import threading

ES_CONTINUOUS = 0x80000000        # 이 상태를 계속 유지(해제할 때까지)
ES_SYSTEM_REQUIRED = 0x00000001   # 시스템 유휴 절전 금지 (화면은 무관)

AC_ONLINE = 1                     # ACLineStatus: 0=배터리, 1=AC, 255=알 수 없음
_POLL_SECONDS = 60


class _SystemPowerStatus(ctypes.Structure):
    _fields_ = [
        ("ACLineStatus", ctypes.c_ubyte),
        ("BatteryFlag", ctypes.c_ubyte),
        ("BatteryLifePercent", ctypes.c_ubyte),
        ("SystemStatusFlag", ctypes.c_ubyte),
        ("BatteryLifeTime", ctypes.c_ulong),
        ("BatteryFullLifeTime", ctypes.c_ulong),
    ]


def _on_ac_power():
    """AC 어댑터 연결 여부. 판단이 안 되면 True(=절전 막기)로 본다."""
    status = _SystemPowerStatus()
    if not ctypes.windll.kernel32.GetSystemPowerStatus(ctypes.byref(status)):
        return True
    return status.ACLineStatus != 0  # 배터리(0)만 False, 알 수 없음(255)은 AC 취급


class KeepAwake:
    """AC 전원일 때만 시스템 절전을 막는 백그라운드 감시자.

    SetThreadExecutionState 의 상태는 **호출한 스레드에 묶이고 그 스레드가 끝나면
    풀린다.** 그래서 설정/해제를 모두 이 감시 스레드 안에서만 한다.
    """

    def __init__(self):
        self._stop = threading.Event()
        self._thread = None
        self.active = False  # 현재 절전 금지 요청을 걸어 둔 상태인지

    def start(self):
        if os.name != "nt":
            return False
        self._thread = threading.Thread(target=self._loop, daemon=True, name="keepawake")
        self._thread.start()
        return True

    def stop(self):
        self._stop.set()
        if self._thread:
            self._thread.join(timeout=5)

    def _apply(self, hold):
        """hold=True 면 절전 금지, False 면 평소 설정대로 되돌림."""
        if hold == self.active:
            return
        flags = ES_CONTINUOUS | ES_SYSTEM_REQUIRED if hold else ES_CONTINUOUS
        if ctypes.windll.kernel32.SetThreadExecutionState(flags) == 0:
            return  # 실패(0) 시 상태를 바꾸지 않고 다음 주기에 재시도
        self.active = hold

    def _loop(self):
        try:
            while True:
                self._apply(_on_ac_power())
                if self._stop.wait(_POLL_SECONDS):
                    break
        finally:
            self._apply(False)  # 스레드 종료 전 원복(프로세스가 죽어도 OS 가 정리한다)


def start():
    """절전 방지를 켜고 감시자를 돌려준다. 지원 안 되면 None."""
    keeper = KeepAwake()
    return keeper if keeper.start() else None
