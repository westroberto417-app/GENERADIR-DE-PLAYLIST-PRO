export function buildDesktopBridgePyScript(): string {
  return `#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
SMART PLAYLIST AI STUDIO — DesktopBridge Windows x64 (24/7 Offline Daemon)
Ejecuta el programador APScheduler en segundo plano aunque el navegador esté cerrado,
sin conexión a internet y con recuperación automática tras apagones o reinicios de PC.
"""

from __future__ import annotations

import datetime as dt
import json
import os
import random
import re
import sys
import threading
import time
import unicodedata
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

try:
    from apscheduler.schedulers.background import BackgroundScheduler
    from apscheduler.triggers.cron import CronTrigger
except ImportError:
    print("[ERROR] Falta la libreria APScheduler. Ejecuta: py -m pip install apscheduler")
    sys.exit(1)

try:
    import mutagen  # noqa: F401
    HAS_MUTAGEN = True
except Exception:
    HAS_MUTAGEN = False

try:
    from fastapi import FastAPI, Request, Response
    from fastapi.responses import JSONResponse
    import uvicorn
    HAS_FASTAPI = True
except Exception:
    HAS_FASTAPI = False


HOST = "127.0.0.1"
PORT = int(os.environ.get("SMARTPLAY_BRIDGE_PORT", "8765"))
BASE_DIR = Path(__file__).resolve().parent
DATA_DIR = BASE_DIR / "smartplay_bridge_data"
STATE_FILE = DATA_DIR / "bridge_state.json"
USAGE_FILE = DATA_DIR / "usage_history.json"
RUNS_FILE = DATA_DIR / "last_runs.json"
LOG_FILE = DATA_DIR / "bridge_logs.txt"

DATA_DIR.mkdir(parents=True, exist_ok=True)

START_TIME = time.time()
STATE_LOCK = threading.RLock()
SCHEDULER = BackgroundScheduler(
    job_defaults={
        "coalesce": True,
        "max_instances": 1,
        "misfire_grace_time": 3600,
    }
)


def log_event(level: str, message: str) -> None:
    stamp = dt.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    line = f"[{stamp}] [{level.upper()}] {message}"
    print(line, flush=True)
    try:
        with STATE_LOCK:
            existing = ""
            if LOG_FILE.exists():
                existing = LOG_FILE.read_text(encoding="utf-8", errors="ignore")
            lines = existing.splitlines()[-400:]
            lines.append(line)
            write_text_atomic(LOG_FILE, "\\n".join(lines) + "\\n")
    except Exception:
        pass


def write_text_atomic(target: Path, content: str, newline: str = "\\n") -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    tmp = target.with_name(f".{target.name}.{os.getpid()}.tmp")
    with open(tmp, "w", encoding="utf-8", newline=newline) as fh:
        fh.write(content)
    os.replace(tmp, target)


def write_json_atomic(target: Path, payload: Any) -> None:
    write_text_atomic(target, json.dumps(payload, ensure_ascii=False, indent=2))


def read_json_safe(target: Path, default: Any) -> Any:
    if not target.exists():
        return default
    try:
        return json.loads(target.read_text(encoding="utf-8"))
    except Exception:
        return default


def normalize_text(value: Any) -> str:
    s = str(value or "").strip().lower()
    s = unicodedata.normalize("NFD", s)
    s = "".join(ch for ch in s if unicodedata.category(ch) != "Mn")
    return re.sub(r"\\s+", " ", s)


def normalize_win_path(raw: str) -> str:
    s = str(raw or "").strip()
    if (s.startswith('"') and s.endswith('"')) or (s.startswith("'") and s.endswith("'")):
        s = s[1:-1].strip()
    if not s:
        return ""
    if s.startswith("/") and not s.startswith("//"):
        collapsed = re.sub(r"/+", "/", s)
        return collapsed.rstrip("/") or "/"
    s = s.replace("/", "\\\\")
    if s.startswith("\\\\\\\\"):
        s = "\\\\\\\\" + re.sub(r"\\\\+", lambda _: "\\\\", s[2:])
    else:
        s = re.sub(r"\\\\+", lambda _: "\\\\", s)
    if re.match(r"^[a-zA-Z]:\\\\?$", s):
        return s[:2] + "\\\\"
    return s.rstrip("\\\\")


def join_win_path(base: str, rel: str) -> str:
    b = normalize_win_path(base)
    r = str(rel or "").lstrip("\\\\/")
    if not b:
        return r.replace("/", "\\\\")
    if b.startswith("/") and not b.startswith("\\\\\\\\"):
        r_posix = r.replace("\\\\", "/")
        return f"/{r_posix}" if b == "/" else f"{b.rstrip('/')}/{r_posix}"
    r_win = r.replace("/", "\\\\")
    if re.match(r"^[a-zA-Z]:\\\\$", b):
        return f"{b}{r_win}"
    b_clean = b.rstrip("\\\\")
    return f"{b_clean}\\\\{r_win}"


def intensity_to_numeric(intensity: Optional[str]) -> int:
    mapping = {
        "Muy suave": 18,
        "Suave": 36,
        "Media": 55,
        "Alta": 76,
        "Muy alta": 92,
    }
    return mapping.get(intensity or "", 50)


def get_energy_metric(track: Dict[str, Any]) -> float:
    score = track.get("energyScore")
    if isinstance(score, (int, float)):
        return float(score)
    return float(intensity_to_numeric(track.get("intensity")))


def sanitize_filename_base(raw: str) -> str:
    cleaned = re.sub(r'[<>:"/\\\\|?*]+', "_", str(raw or "playlist"))
    cleaned = re.sub(r"\\.(m3u8|m3u)$", "", cleaned, flags=re.IGNORECASE).strip()
    return cleaned or "playlist"


def format_name_pattern(pattern: str, task_name: str, ref: dt.datetime) -> str:
    out = pattern or "{DD-MM-YYYY}_{NAME}"
    out = re.sub(r"\\{DD-MM-YYYY\\}", ref.strftime("%d-%m-%Y"), out, flags=re.IGNORECASE)
    out = re.sub(r"\\{YYYY-MM-DD\\}", ref.strftime("%Y-%m-%d"), out, flags=re.IGNORECASE)
    out = re.sub(r"\\{HH-MM\\}", ref.strftime("%H-%M"), out, flags=re.IGNORECASE)
    safe_task = re.sub(r"\\s+", "_", task_name.strip())
    out = re.sub(r"\\{NAME\\}", safe_task, out, flags=re.IGNORECASE)
    return out


def resolve_output_filename(job: Dict[str, Any], ref: dt.datetime) -> str:
    out_cfg = job.get("output", {})
    fmt = "m3u" if out_cfg.get("format") == "m3u" else "m3u8"
    raw_custom = str(out_cfg.get("outputFileName") or "").strip()
    pattern = str(out_cfg.get("namePattern") or "{DD-MM-YYYY}_{NAME}")
    task_name = str(job.get("name") or "Playlist")
    if raw_custom:
        raw_base = (
            format_name_pattern(raw_custom, task_name, ref)
            if "{" in raw_custom
            else raw_custom
        )
    else:
        raw_base = format_name_pattern(pattern, task_name, ref)
    clean_base = sanitize_filename_base(raw_base)
    if out_cfg.get("overwriteExisting", True) is False:
        return f"{clean_base}_{ref.strftime('%H%M%S')}.{fmt}"
    return f"{clean_base}.{fmt}"


def resolve_output_folder(job: Dict[str, Any], settings: Dict[str, Any]) -> Optional[Path]:
    out_cfg = job.get("output", {})
    candidates = [
        out_cfg.get("outputWindowsPath"),
        settings.get("schedulerOutputWindowsPath"),
    ]
    for cand in candidates:
        norm = normalize_win_path(str(cand or ""))
        if norm:
            return Path(norm)
    root = normalize_win_path(str(settings.get("storageRootPath") or ""))
    if root:
        sub = str(settings.get("defaultExportSubfolder") or "Playlists").strip("\\\\/")
        p = Path(root) / sub if sub else Path(root)
        return p
    return BASE_DIR / "Playlists_Generadas"


def matches_criteria(track: Dict[str, Any], criteria: Dict[str, Any]) -> bool:
    if track.get("isSpotFolder"):
        return False
    if criteria.get("sourceScope") == "folder" and criteria.get("sourceFolderId"):
        if track.get("folderId") != criteria.get("sourceFolderId"):
            return False

    genre_norm = normalize_text(track.get("genre"))
    allowed_genres = criteria.get("allowedGenres") or []
    if allowed_genres:
        if not any(normalize_text(g) in genre_norm for g in allowed_genres):
            return False
    excluded_genres = criteria.get("excludedGenres") or []
    if excluded_genres:
        if any(normalize_text(g) in genre_norm for g in excluded_genres):
            return False

    decades = criteria.get("decades") or []
    if decades and track.get("decade") not in decades:
        return False

    years = criteria.get("years") or []
    if years and track.get("year") not in years:
        return False

    artist_norm = normalize_text(track.get("artist"))
    inc_artists = criteria.get("includedArtists") or []
    if inc_artists and not any(normalize_text(a) in artist_norm for a in inc_artists):
        return False
    exc_artists = criteria.get("excludedArtists") or []
    if exc_artists and any(normalize_text(a) in artist_norm for a in exc_artists):
        return False

    bpm = track.get("bpm")
    bpm_min = criteria.get("bpmMin")
    bpm_max = criteria.get("bpmMax")
    if bpm_min is not None and (bpm is None or bpm < bpm_min):
        return False
    if bpm_max is not None and (bpm is None or bpm > bpm_max):
        return False

    energy = get_energy_metric(track)
    if criteria.get("energyMin") is not None and energy < criteria["energyMin"]:
        return False
    if criteria.get("energyMax") is not None and energy > criteria["energyMax"]:
        return False

    energy_levels = criteria.get("energyLevels") or []
    if energy_levels and track.get("energyLevel") not in energy_levels:
        return False

    intensities = criteria.get("intensities") or []
    if intensities and track.get("intensity") not in intensities:
        return False

    moods = criteria.get("moods") or []
    if not moods and criteria.get("mood") and criteria.get("mood") != "Todos":
        moods = [criteria["mood"]]
    if moods:
        t_mood = normalize_text(track.get("mood"))
        if not any(normalize_text(m) == t_mood for m in moods):
            return False

    return True


def song_signature(track: Dict[str, Any]) -> str:
    title_norm = normalize_text(track.get("title"))
    artist_norm = normalize_text(track.get("artist"))
    if title_norm and artist_norm and artist_norm != "desconocido":
        return f"{artist_norm}::{title_norm}"
    return str(track.get("duplicateKey") or track.get("id") or "")


def generate_playlist_items(
    job: Dict[str, Any],
    tracks: List[Dict[str, Any]],
    usage_history: List[Dict[str, Any]],
    settings: Dict[str, Any],
) -> Tuple[List[Tuple[Dict[str, Any], bool]], List[str]]:
    criteria = job.get("criteria", {})
    warnings: List[str] = []

    music_only = [t for t in tracks if not t.get("isSpotFolder") and t.get("accessible", True)]
    candidates = [t for t in music_only if matches_criteria(t, criteria)]

    respect_anti = bool(criteria.get("respectAntiRepeat", True))
    anti_hours = int(criteria.get("antiRepeatHours", settings.get("antiRepeatHours", 24)) or 0)
    fallback_oldest = bool(criteria.get("fallbackToOldestOnExhaust", True))

    last_used_map: Dict[str, int] = {}
    cooldown_fallback: List[Dict[str, Any]] = []
    if respect_anti and anti_hours > 0:
        cutoff_ms = int((time.time() - anti_hours * 3600) * 1000)
        recent_ids = set()
        for u in usage_history:
            u_at = int(u.get("usedAt") or 0)
            if u_at > cutoff_ms:
                tid = str(u.get("trackId") or "")
                recent_ids.add(tid)
                if u_at > last_used_map.get(tid, 0):
                    last_used_map[tid] = u_at
        fresh = [t for t in candidates if t.get("id") not in recent_ids]
        if fallback_oldest:
            cooldown_fallback = sorted(
                [t for t in candidates if t.get("id") in recent_ids],
                key=lambda t: last_used_map.get(str(t.get("id")), 0),
            )
        candidates = fresh

    fresh_shuffled = list(candidates)
    random.shuffle(fresh_shuffled)
    combined_pool = fresh_shuffled + cooldown_fallback
    if not combined_pool:
        return [], ["Ninguna cancion cumple los filtros para esta programacion."]

    target_type = criteria.get("targetType") or "duration"
    target_count = int(criteria.get("targetCount") or 18)
    target_sec = int(criteria.get("targetDurationMin") or 60) * 60
    enforce_no_repeat_tracks = criteria.get("noRepeatTracks", True) is not False
    enforce_no_repeat_artists = bool(criteria.get("noRepeatArtists", False))
    artist_sep = int(criteria.get("artistSeparation", settings.get("artistSeparation", 2)) or 0)
    mode = str(criteria.get("mode") or "Combinado")
    segments = (criteria.get("progressiveCurve") or {}).get("segments") or [28, 52, 76, 92]

    selected_music: List[Dict[str, Any]] = []
    used_ids = set()
    used_sigs = set()
    used_artists = set()
    current_sec = 0.0
    used_cooldown = False

    def target_reached() -> bool:
        if target_type == "count":
            return len(selected_music) >= target_count
        if target_type == "duration":
            return current_sec >= target_sec
        return len(selected_music) >= target_count and current_sec >= target_sec

    def can_use_track(tr: Dict[str, Any], allow_reuse: bool = False) -> bool:
        tid = str(tr.get("id") or "")
        if enforce_no_repeat_tracks:
            if tid in used_ids:
                return False
            sig = song_signature(tr)
            if sig in used_sigs:
                return False
            dkey = tr.get("duplicateKey")
            if dkey and f"dup:{dkey}" in used_sigs:
                return False
            return True
        if not allow_reuse and tid in used_ids:
            return False
        if allow_reuse and len(combined_pool) > 1 and selected_music:
            if selected_music[-1].get("id") == tid:
                return False
        return True

    def can_use_artist(artist: Any) -> bool:
        norm = normalize_text(artist)
        if not norm or norm == "desconocido":
            return True
        if enforce_no_repeat_artists:
            return norm not in used_artists
        if artist_sep <= 0:
            return True
        return not any(normalize_text(p.get("artist")) == norm for p in selected_music[-artist_sep:])

    max_iter = max(len(combined_pool) * 4, target_count + 50, 200)
    iterations = 0
    while not target_reached() and iterations < max_iter:
        iterations += 1
        if enforce_no_repeat_tracks and len(used_ids) >= len(combined_pool):
            break

        active_pool = combined_pool if used_cooldown else fresh_shuffled
        available = [t for t in active_pool if can_use_track(t, False) and can_use_artist(t.get("artist"))]

        if not available and not used_cooldown and cooldown_fallback:
            used_cooldown = True
            available = [
                t for t in cooldown_fallback if can_use_track(t, False) and can_use_artist(t.get("artist"))
            ]

        if not available and not enforce_no_repeat_tracks:
            reused = list(combined_pool)
            random.shuffle(reused)
            available = [t for t in reused if can_use_track(t, True) and can_use_artist(t.get("artist"))]

        if not available:
            if not enforce_no_repeat_artists:
                rem = [t for t in combined_pool if can_use_track(t, False)]
                if not rem and not enforce_no_repeat_tracks:
                    rem = [t for t in combined_pool if can_use_track(t, True)]
                    random.shuffle(rem)
                if rem:
                    available = rem
                else:
                    break
            else:
                break

        progress = (
            len(selected_music) / max(1, target_count)
            if target_type == "count"
            else min(0.99, current_sec / max(1, target_sec))
        )

        chosen = available[0]
        if mode == "Progresivo":
            seg_idx = 0 if progress < 0.2 else 1 if progress < 0.5 else 2 if progress < 0.85 else 3
            target_e = float(segments[seg_idx])
            chosen = min(available, key=lambda t: abs(get_energy_metric(t) - target_e))
        elif mode == "Por BPM":
            prev_bpm = selected_music[-1].get("bpm") if selected_music else None
            if prev_bpm:
                chosen = min(available, key=lambda t: abs((t.get("bpm") or 999) - prev_bpm))
            else:
                chosen = min(available, key=lambda t: t.get("bpm") or 999)
        elif mode == "Por intensidad":
            chosen = min(available, key=get_energy_metric)
        elif mode == "Por género":
            last_g = selected_music[-1].get("genre") if selected_music else None
            chosen = next((t for t in available if last_g and t.get("genre") == last_g), available[0])
        elif mode == "Por década":
            chosen = min(available, key=lambda t: t.get("year") or 9999)
        elif mode in ("Por ambiente", "Combinado"):
            last_m = selected_music[-1].get("mood") if selected_music else None
            chosen = next((t for t in available if last_m and t.get("mood") == last_m), available[0])

        tid = str(chosen.get("id") or "")
        used_ids.add(tid)
        if enforce_no_repeat_tracks:
            used_sigs.add(song_signature(chosen))
            if chosen.get("duplicateKey"):
                used_sigs.add(f"dup:{chosen['duplicateKey']}")
        a_norm = normalize_text(chosen.get("artist"))
        if a_norm and a_norm != "desconocido":
            used_artists.add(a_norm)
        selected_music.append(chosen)
        dur = float(chosen.get("duration") or 0)
        current_sec += dur if dur > 0 else 180.0

    # Spots interleaving
    spots_cfg = criteria.get("spots") or {}
    spot_pool: List[Dict[str, Any]] = []
    if spots_cfg.get("enabled") and spots_cfg.get("spotFolderId"):
        spot_pool = [
            t
            for t in tracks
            if t.get("folderId") == spots_cfg["spotFolderId"] and t.get("accessible", True)
        ]

    final_items: List[Tuple[Dict[str, Any], bool]] = []
    spot_idx = 0
    last_spot_id = ""

    def pick_spot() -> Optional[Dict[str, Any]]:
        nonlocal spot_idx, last_spot_id
        if not spot_pool:
            return None
        if spots_cfg.get("rotationMode") == "sequential":
            sp = spot_pool[spot_idx % len(spot_pool)]
            spot_idx += 1
            return sp
        if len(spot_pool) == 1:
            return spot_pool[0]
        Choices = [s for s in spot_pool if s.get("id") != last_spot_id]
        picked = random.choice(Choices)
        last_spot_id = str(picked.get("id") or "")
        return picked

    if spots_cfg.get("enabled") and spot_pool and spots_cfg.get("insertIntroAtStart"):
        intro = pick_spot()
        if intro:
            final_items.append((intro, True))

    every_n = max(1, int(spots_cfg.get("everyNSongs") or 3))
    for idx, tr in enumerate(selected_music):
        final_items.append((tr, False))
        if (
            spots_cfg.get("enabled")
            and spot_pool
            and (idx + 1) % every_n == 0
            and idx < len(selected_music) - 1
        ):
            sp = pick_spot()
            if sp:
                final_items.append((sp, True))

    return final_items, warnings


def build_m3u_content(
    items: List[Tuple[Dict[str, Any], bool]],
    fmt: str,
    path_mode: str,
    folders_map: Dict[str, Dict[str, Any]],
    settings: Dict[str, Any],
) -> str:
    lines = ["#EXTM3U"]
    if fmt == "m3u8":
        lines.append("#EXTENC:UTF-8")

    fallback_prefix = str(settings.get("globalFallbackPrefix") or "D:\\\\SMART PLAYLIST AI\\\\Biblioteca")
    for tr, _is_spot in items:
        sec = max(0, int(round(float(tr.get("duration") or 180))))
        artist = str(tr.get("artist") or "Desconocido").strip()
        title = str(tr.get("title") or tr.get("fileName") or "Sin titulo").strip()
        lines.append(f"#EXTINF:{sec},{artist} - {title}")

        rel = str(tr.get("relativePath") or tr.get("fileName") or "")
        if path_mode == "relative":
            lines.append(rel.replace("/", "\\\\").lstrip("\\\\"))
        elif path_mode == "multi-drive":
            folder = folders_map.get(str(tr.get("folderId") or ""), {})
            base = str(folder.get("windowsBasePath") or fallback_prefix)
            lines.append(join_win_path(base, rel))
        else:
            lines.append(join_win_path(fallback_prefix, rel))

    return "\\r\\n".join(lines) + "\\r\\n"


def execute_job(job_id: str, reason: str = "scheduled", ref_dt: Optional[dt.datetime] = None) -> Dict[str, Any]:
    now_dt = ref_dt or dt.datetime.now()
    with STATE_LOCK:
        state = read_json_safe(STATE_FILE, {})
        bridge_cfg = state.get("bridgeConfig", {})
        tracks = state.get("tracks", [])
        settings = bridge_cfg.get("settings", {})
        folder_mappings = bridge_cfg.get("folderMappings", [])
        jobs = bridge_cfg.get("jobs", [])
        usage_history = read_json_safe(USAGE_FILE, [])
        runs_map = read_json_safe(RUNS_FILE, {})

    job = next((j for j in jobs if j.get("id") == job_id), None)
    if not job:
        return {"ok": False, "message": f"Tarea {job_id} no encontrada"}

    items, warnings = generate_playlist_items(job, tracks, usage_history, settings)
    if not items:
        msg = warnings[0] if warnings else "No se encontraron canciones elegibles."
        log_event("warning", f"{job.get('name')}: {msg}")
        return {"ok": False, "message": msg}

    folders_map = {str(f.get("folderId")): f for f in folder_mappings}
    out_cfg = job.get("output", {})
    fmt = "m3u" if out_cfg.get("format") == "m3u" else "m3u8"
    path_mode = str(out_cfg.get("pathMode") or settings.get("defaultPathMode") or "multi-drive")

    content = build_m3u_content(items, fmt, path_mode, folders_map, settings)
    out_dir = resolve_output_folder(job, settings)
    filename = resolve_output_filename(job, now_dt)
    target_path = out_dir / filename

    write_text_atomic(target_path, content, newline="")

    now_ms = int(time.time() * 1000)
    new_usage = [
        {
            "trackId": tr.get("id"),
            "usedAt": now_ms,
            "playlistName": f"{job.get('name')} (DesktopBridge)",
        }
        for tr, is_spot in items
        if not is_spot
    ]

    with STATE_LOCK:
        current_usage = read_json_safe(USAGE_FILE, [])
        merged_usage = (current_usage + new_usage)[-12000:]
        write_json_atomic(USAGE_FILE, merged_usage)
        runs_map = read_json_safe(RUNS_FILE, {})
        runs_map[job_id] = {
            "jobName": job.get("name"),
            "lastRunAt": now_dt.isoformat(),
            "lastRunMs": now_ms,
            "file": str(target_path),
            "reason": reason,
            "itemsCount": len(items),
        }
        write_json_atomic(RUNS_FILE, runs_map)

    log_event(
        "success",
        f"[{reason}] {job.get('name')} -> {target_path} ({len(items)} pistas)",
    )
    return {
        "ok": True,
        "file": str(target_path),
        "itemsCount": len(items),
        "message": f"Playlist generada en {target_path}",
    }


def parse_dow(dow_expr: str) -> str:
    expr = str(dow_expr or "*").strip()
    return expr if expr else "*"


def register_scheduler_jobs() -> int:
    for existing in SCHEDULER.get_jobs():
        SCHEDULER.remove_job(existing.id)

    state = read_json_safe(STATE_FILE, {})
    jobs = (state.get("bridgeConfig") or {}).get("jobs") or []
    registered = 0

    for job in jobs:
        if not job.get("enabled"):
            continue
        job_id = str(job.get("id") or "")
        if not job_id:
            continue
        cron_cfg = job.get("cron") or {}
        dow = parse_dow(str(cron_cfg.get("day_of_week") or "*"))
        times = job.get("times") or []
        if not times:
            h = int(cron_cfg.get("hour") or 0)
            m = int(cron_cfg.get("minute") or 0)
            times = [f"{h:02d}:{m:02d}"]

        for t_str in times:
            parts = str(t_str).split(":")
            if len(parts) < 2:
                continue
            hh, mm = int(parts[0]), int(parts[1])
            trigger = CronTrigger(day_of_week=dow, hour=hh, minute=mm, second=0)
            SCHEDULER.add_job(
                execute_job,
                trigger=trigger,
                args=[job_id, "cron"],
                id=f"{job_id}::{hh:02d}:{mm:02d}",
                replace_existing=True,
                misfire_grace_time=3600,
                coalesce=True,
            )
            registered += 1

    return registered


def run_missed_jobs_catchup() -> int:
    """Si la PC estuvo apagada durante una tanda programada (hasta 6h), la recupera al encender."""
    state = read_json_safe(STATE_FILE, {})
    jobs = (state.get("bridgeConfig") or {}).get("jobs") or []
    runs_map = read_json_safe(RUNS_FILE, {})
    now = dt.datetime.now()
    recovered = 0
    dow_names = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]

    for job in jobs:
        if not job.get("enabled"):
            continue
        job_id = str(job.get("id") or "")
        cron_cfg = job.get("cron") or {}
        dow_raw = parse_dow(str(cron_cfg.get("day_of_week") or "*"))
        allowed_dows = set(dow_names) if dow_raw == "*" else set(x.strip().lower() for x in dow_raw.split(","))
        times = job.get("times") or []
        last_ms = int((runs_map.get(job_id) or {}).get("lastRunMs") or 0)

        latest_due: Optional[dt.datetime] = None
        for day_offset in (0, 1):
            day_dt = now - dt.timedelta(days=day_offset)
            if dow_names[day_dt.weekday()] not in allowed_dows:
                continue
            for t_str in times:
                try:
                    hh, mm = [int(x) for x in str(t_str).split(":")[:2]]
                except Exception:
                    continue
                slot = day_dt.replace(hour=hh, minute=mm, second=0, microsecond=0)
                age_sec = (now - slot).total_seconds()
                if 0 <= age_sec <= 6 * 3600:
                    if latest_due is None or slot > latest_due:
                        latest_due = slot

        if latest_due is not None and int(latest_due.timestamp() * 1000) > last_ms:
            res = execute_job(job_id, reason="recuperacion_inicio", ref_dt=latest_due)
            if res.get("ok"):
                recovered += 1

    return recovered


def bootstrap_offline_files_if_empty() -> None:
    if STATE_FILE.exists():
        return
    # Optional offline fallback if user dropped an exported backup/config file beside desktop_bridge.py
    for candidate in sorted(BASE_DIR.glob("apscheduler_windows_x64_config*.json")):
        cfg = read_json_safe(candidate, None)
        if isinstance(cfg, dict) and "jobs" in cfg:
            write_json_atomic(STATE_FILE, {"bridgeConfig": cfg, "tracks": [], "syncedAt": time.time()})
            log_event("info", f"Configuracion APScheduler cargada desde {candidate.name}")
            break


def build_health_payload() -> Dict[str, Any]:
    state = read_json_safe(STATE_FILE, {})
    runs_map = read_json_safe(RUNS_FILE, {})
    jobs = (state.get("bridgeConfig") or {}).get("jobs") or []
    tracks = state.get("tracks") or []
    return {
        "ok": True,
        "version": "2.0.0-win64",
        "capabilities": ["APScheduler", "OfflineRecovery", "RadioBossM3U8"]
        + (["Mutagen"] if HAS_MUTAGEN else []),
        "uptimeSec": int(time.time() - START_TIME),
        "jobsCount": len([j for j in jobs if j.get("enabled")]),
        "totalJobsCount": len(jobs),
        "syncedTracksCount": len(tracks),
        "syncedAt": state.get("syncedAt"),
        "scheduledTriggersCount": len(SCHEDULER.get_jobs()),
        "recentRuns": list(runs_map.values())[-8:],
    }


def apply_sync_payload(payload: Dict[str, Any]) -> Dict[str, Any]:
    bridge_cfg = payload.get("bridgeConfig")
    if not isinstance(bridge_cfg, dict):
        return {"ok": False, "message": "Payload sin bridgeConfig"}

    tracks = payload.get("tracks") or []
    usage_history = payload.get("usageHistory") or []

    with STATE_LOCK:
        write_json_atomic(
            STATE_FILE,
            {
                "bridgeConfig": bridge_cfg,
                "tracks": tracks,
                "syncedAt": int(time.time() * 1000),
            },
        )
        if usage_history:
            existing_usage = read_json_safe(USAGE_FILE, [])
            seen = {(u.get("trackId"), u.get("usedAt")) for u in existing_usage}
            merged = list(existing_usage)
            for u in usage_history:
                key = (u.get("trackId"), u.get("usedAt"))
                if key not in seen:
                    seen.add(key)
                    merged.append(u)
            write_json_atomic(USAGE_FILE, merged[-12000:])

        triggers = register_scheduler_jobs()

    log_event(
        "info",
        f"Sincronizado desde app: {len(tracks)} pistas, {triggers} disparos APScheduler activos.",
    )
    return {
        "ok": True,
        "syncedTracksCount": len(tracks),
        "scheduledTriggersCount": triggers,
    }


def cors_headers(origin: Optional[str]) -> Dict[str, str]:
    allow_origin = origin if origin else "*"
    return {
        "Access-Control-Allow-Origin": allow_origin,
        "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
        "Access-Control-Allow-Headers": "Content-Type, Authorization",
        "Access-Control-Allow-Private-Network": "true",
        "Vary": "Origin",
    }


def start_http_server() -> None:
    if HAS_FASTAPI:
        app = FastAPI(title="SMART PLAYLIST DesktopBridge Windows")

        @app.middleware("http")
        async def add_cors_pna(request: Request, call_next):
            origin = request.headers.get("origin")
            if request.method == "OPTIONS":
                return Response(status_code=204, headers=cors_headers(origin))
            response = await call_next(request)
            for k, v in cors_headers(origin).items():
                response.headers[k] = v
            return response

        @app.get("/health")
        async def health():
            return JSONResponse(build_health_payload())

        @app.post("/sync")
        async def sync(request: Request):
            data = await request.json()
            res = apply_sync_payload(data)
            return JSONResponse(res, status_code=200 if res.get("ok") else 400)

        @app.post("/run-now/{job_id}")
        async def run_now(job_id: str):
            res = execute_job(job_id, reason="manual_bridge")
            return JSONResponse(res, status_code=200 if res.get("ok") else 400)

        uvicorn.run(app, host=HOST, port=PORT, log_level="warning")
        return

    # Built-in fallback HTTP server if fastapi/uvicorn are not installed
    class BridgeHandler(BaseHTTPRequestHandler):
        def _send_json(self, code: int, body: Any) -> None:
            raw = json.dumps(body, ensure_ascii=False).encode("utf-8")
            self.send_response(code)
            for k, v in cors_headers(self.headers.get("Origin")).items():
                self.send_header(k, v)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(raw)))
            self.end_headers()
            self.wfile.write(raw)

        def do_OPTIONS(self):
            self.send_response(204)
            for k, v in cors_headers(self.headers.get("Origin")).items():
                self.send_header(k, v)
            self.end_headers()

        def do_GET(self):
            if self.path.split("?")[0] == "/health":
                self._send_json(200, build_health_payload())
            else:
                self._send_json(404, {"ok": False, "message": "Ruta no encontrada"})

        def do_POST(self):
            length = int(self.headers.get("Content-Length") or "0")
            raw = self.rfile.read(length) if length > 0 else b"{}"
            try:
                body = json.loads(raw.decode("utf-8"))
            except Exception:
                body = {}
            path = self.path.split("?")[0]
            if path == "/sync":
                res = apply_sync_payload(body)
                self._send_json(200 if res.get("ok") else 400, res)
            elif path.startswith("/run-now/"):
                job_id = path[len("/run-now/"):]
                res = execute_job(job_id, reason="manual_bridge")
                self._send_json(200 if res.get("ok") else 400, res)
            else:
                self._send_json(404, {"ok": False, "message": "Ruta no encontrada"})

        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            return

    server = ThreadingHTTPServer((HOST, PORT), BridgeHandler)
    server.serve_forever()


def main() -> None:
    bootstrap_offline_files_if_empty()
    SCHEDULER.start()
    count = register_scheduler_jobs()
    recovered = run_missed_jobs_catchup()
    log_event(
        "info",
        f"DesktopBridge Windows activo en http://{HOST}:{PORT} | Disparos: {count} | Recuperados al inicio: {recovered}",
    )
    try:
        start_http_server()
    except KeyboardInterrupt:
        log_event("info", "DesktopBridge detenido por el usuario.")
    finally:
        SCHEDULER.shutdown(wait=False)


if __name__ == "__main__":
    main()
`;
}

export function buildStartBridgeBat(): string {
  return [
    '@echo off',
    'chcp 65001 >nul',
    'title SMART PLAYLIST AI STUDIO - DesktopBridge Windows 24/7',
    'cd /d "%~dp0"',
    'echo ============================================================',
    'echo  SMART PLAYLIST AI STUDIO - PUENTE WINDOWS 24/7 (OFFLINE)',
    'echo ============================================================',
    'echo.',
    'set "PY_CMD="',
    'where py >nul 2>nul && set "PY_CMD=py"',
    'if "%PY_CMD%"=="" (where python >nul 2>nul && set "PY_CMD=python")',
    'if "%PY_CMD%"=="" (',
    '  echo [ERROR] No se encontro Python en Windows.',
    '  pause',
    '  exit /b 1',
    ')',
    'if not exist "desktop_bridge.py" (',
    '  echo [ERROR] Coloca desktop_bridge.py en esta misma carpeta: %~dp0',
    '  pause',
    '  exit /b 1',
    ')',
    '%PY_CMD% -c "import apscheduler" >nul 2>nul',
    'if errorlevel 1 (',
    '  echo Instalando dependencias necesarias...',
    '  %PY_CMD% -m pip install apscheduler fastapi uvicorn mutagen',
    ')',
    'echo Iniciando servicio local en http://127.0.0.1:8765 ...',
    'echo NO CIERRES esta ventana mientras quieras ejecucion automatica 24/7.',
    'echo.',
    '%PY_CMD% "desktop_bridge.py"',
    'pause',
    '',
  ].join('\r\n');
}

export function buildStartupInstallerBat(): string {
  return [
    '@echo off',
    'chcp 65001 >nul',
    'cd /d "%~dp0"',
    'set "STARTUP_DIR=%APPDATA%\\Microsoft\\Windows\\Start Menu\\Programs\\Startup"',
    'set "VBS_FILE=%STARTUP_DIR%\\SmartPlaylistDesktopBridge.vbs"',
    'echo Creando arranque automatico tras reinicio o corte de luz...',
    '(',
    '  echo Set WshShell = CreateObject^("WScript.Shell"^)',
    '  echo WshShell.CurrentDirectory = "%~dp0"',
    '  echo WshShell.Run """%~dp0Iniciar_DesktopBridge.bat""", 7, False',
    ') > "%VBS_FILE%"',
    'if exist "%VBS_FILE%" (',
    '  echo.',
    '  echo [LISTO] DesktopBridge arrancara automaticamente minimizado al encender Windows.',
    '  echo Carpeta de inicio: %STARTUP_DIR%',
    ') else (',
    '  echo [ERROR] No se pudo crear el acceso en Inicio de Windows.',
    ')',
    'pause',
    '',
  ].join('\r\n');
}
