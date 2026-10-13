"""Capture and pose-animation caches for the Ares Pose Studio node.

Extracted from the original VNCCS Utils runtime: browser captures are handed
over through HTTP routes and picked up here by the node during execution.
"""

import json
import os
import re
import time

_SAFE_ID_RE = re.compile(r"[^A-Za-z0-9_-]+")
_CAPTURE_CACHE_MAX_IMAGES = 600
_CAPTURE_CACHE_MAX_TOTAL_CHARS = 64 * 1024 * 1024
_CAPTURE_CACHE_MAX = 10
_POSE_ANIMATION_CACHE_MAX = 24
_POSE_ANIMATION_CACHE_MAX_TOTAL_CHARS = 48 * 1024 * 1024
_POSE_ANIMATION_CACHE_MAX_KEYS = 300_000
_POSE_ANIMATION_DISK_CACHE_MAX_FILES = 256
_POSE_ANIMATION_DISK_CACHE_MAX_BYTES = 512 * 1024 * 1024
_DISK_CACHE_TTL_SECONDS = 180 * 24 * 60 * 60


def ares_runtime_temp_root():
    try:
        import folder_paths

        root = folder_paths.get_temp_directory()
    except Exception:
        root = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".runtime_cache")
    os.makedirs(root, exist_ok=True)
    return root


def _ares_pose_animation_cache_dir():
    return os.path.join(ares_runtime_temp_root(), "ares_pose_animation_cache")


def ares_content_length_ok(request, max_bytes):
    try:
        raw_length = request.headers.get("Content-Length")
        if raw_length is None:
            return not getattr(request, "can_read_body", False)
        length = int(raw_length)
    except Exception:
        return False
    return length <= int(max_bytes or 0)


def ares_safe_id(value, fallback="item"):
    cleaned = _SAFE_ID_RE.sub("_", str(value or "")).strip("_")
    return cleaned[:128] or fallback


def ares_prune_cache_dir(directory, max_files, max_total_bytes, protected_path=None):
    """Bound temporary disk caches without removing the file just written."""
    now = time.time()
    protected_path = os.path.abspath(protected_path) if protected_path else None
    files = []
    try:
        entries = list(os.scandir(directory))
    except OSError:
        return
    for entry in entries:
        try:
            if not entry.is_file(follow_symlinks=False):
                continue
            stat = entry.stat(follow_symlinks=False)
            path = os.path.abspath(entry.path)
            age = max(0.0, now - stat.st_mtime)
            if entry.name.endswith(".tmp"):
                if age > 60 * 60:
                    os.unlink(entry.path)
                continue
            if not entry.name.endswith(".json"):
                continue
            if path != protected_path and age > _DISK_CACHE_TTL_SECONDS:
                os.unlink(entry.path)
                continue
            files.append([stat.st_mtime, stat.st_size, entry.path, path])
        except OSError:
            continue

    files.sort(key=lambda item: item[0])
    total_bytes = sum(item[1] for item in files)
    blocked_paths = set()
    while len(files) > max_files or total_bytes > max_total_bytes:
        removable_index = next((
            index
            for index, item in enumerate(files)
            if item[3] != protected_path and item[3] not in blocked_paths
        ), None)
        if removable_index is None:
            break
        _, size, path, absolute_path = files[removable_index]
        try:
            os.unlink(path)
            files.pop(removable_index)
            total_bytes -= size
        except OSError:
            blocked_paths.add(absolute_path)


def ares_validate_capture_payload(data):
    captured_images = data.get("captured_images", [])
    if not isinstance(captured_images, list):
        raise ValueError("captured_images must be a list")
    if len(captured_images) > _CAPTURE_CACHE_MAX_IMAGES:
        raise ValueError(f"captured_images limit is {_CAPTURE_CACHE_MAX_IMAGES}")
    total_chars = 0
    for image in captured_images:
        if not isinstance(image, str):
            raise ValueError("captured_images entries must be strings")
        total_chars += len(image)
        if total_chars > _CAPTURE_CACHE_MAX_TOTAL_CHARS:
            raise ValueError("captured_images payload is too large")
    return captured_images


def ares_validate_pose_animation_payload(data):
    animation = data.get("animation")
    if not isinstance(animation, dict):
        raise ValueError("animation must be an object")
    total_keys = 0
    animations = [animation]
    character_animations = animation.get("characterAnimations", [])
    if character_animations is not None:
        if not isinstance(character_animations, list) or len(character_animations) > 3:
            raise ValueError("animation.characterAnimations must contain at most three entries")
        for entry in character_animations:
            nested = entry.get("animation") if isinstance(entry, dict) else None
            if not isinstance(nested, dict):
                raise ValueError("character animation must be an object")
            animations.append(nested)
    for clip in animations:
        tracks = clip.get("tracks", {})
        if not isinstance(tracks, dict):
            raise ValueError("animation.tracks must be an object")
        for track in tracks.values():
            if not isinstance(track, dict):
                continue
            keys = track.get("keys", [])
            if not isinstance(keys, list):
                raise ValueError("animation track keys must be a list")
            total_keys += len(keys)
            if total_keys > _POSE_ANIMATION_CACHE_MAX_KEYS:
                raise ValueError(f"animation key limit is {_POSE_ANIMATION_CACHE_MAX_KEYS}")
    raw = json.dumps(animation, ensure_ascii=False, separators=(",", ":"))
    if len(raw) > _POSE_ANIMATION_CACHE_MAX_TOTAL_CHARS:
        raise ValueError("animation payload is too large")
    try:
        revision = max(0, int(data.get("revision", 0) or 0))
    except (TypeError, ValueError):
        revision = 0
    return animation, revision


# === Capture Cache ===
ARES_CAPTURE_CACHE = {}


def ares_get_capture_cache(capture_id):
    capture_id = ares_safe_id(capture_id, "capture")
    entry = ARES_CAPTURE_CACHE.pop(capture_id, None)
    if entry is not None:
        ARES_CAPTURE_CACHE[capture_id] = entry
    return entry


def register_capture_cache_routes():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return

    @PromptServer.instance.routes.post("/ares_pose/pose_captures_upload")
    async def ares_pose_captures_upload(request):
        try:
            if not ares_content_length_ok(request, _CAPTURE_CACHE_MAX_TOTAL_CHARS + 1024 * 1024):
                return web.json_response({"error": "captured_images payload is too large"}, status=413)
            data = await request.json()
            capture_id = data.get("capture_id")
            if not capture_id:
                return web.json_response({"error": "missing capture_id"}, status=400)
            capture_id = ares_safe_id(capture_id, "capture")
            try:
                captured_images = ares_validate_capture_payload(data)
            except ValueError as exc:
                return web.json_response({"error": str(exc)}, status=413)

            ARES_CAPTURE_CACHE.pop(capture_id, None)
            ARES_CAPTURE_CACHE[capture_id] = {
                "captured_images": captured_images,
            }

            # LRU eviction: keep only last _CAPTURE_CACHE_MAX entries
            while len(ARES_CAPTURE_CACHE) > _CAPTURE_CACHE_MAX:
                oldest = next(iter(ARES_CAPTURE_CACHE))
                del ARES_CAPTURE_CACHE[oldest]

            return web.json_response({"status": "ok", "capture_id": capture_id})
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.get("/ares_pose/pose_captures/{capture_id}")
    async def ares_pose_captures_get(request):
        capture_id = ares_safe_id(request.match_info["capture_id"], "capture")
        entry = ares_get_capture_cache(capture_id)
        if not entry:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response(entry)


# === Pose Animation Cache ===
ARES_POSE_ANIMATION_CACHE = {}


def _ares_pose_animation_cache_path(animation_id):
    safe_id = ares_safe_id(animation_id, "pose_animation")
    return os.path.join(_ares_pose_animation_cache_dir(), f"{safe_id}.json")


def _ares_write_pose_animation_cache_file(animation_id, entry):
    cache_dir = _ares_pose_animation_cache_dir()
    os.makedirs(cache_dir, exist_ok=True)
    path = _ares_pose_animation_cache_path(animation_id)
    temp_path = f"{path}.tmp"
    with open(temp_path, "w", encoding="utf-8") as handle:
        json.dump(entry, handle, ensure_ascii=False, separators=(",", ":"))
    os.replace(temp_path, path)
    ares_prune_cache_dir(
        cache_dir,
        _POSE_ANIMATION_DISK_CACHE_MAX_FILES,
        _POSE_ANIMATION_DISK_CACHE_MAX_BYTES,
        protected_path=path,
    )


def _ares_read_pose_animation_cache_file(animation_id):
    path = _ares_pose_animation_cache_path(animation_id)
    if not os.path.exists(path):
        return None
    with open(path, "r", encoding="utf-8") as handle:
        entry = json.load(handle)
    try:
        os.utime(path, None)
    except OSError:
        pass
    return entry if isinstance(entry, dict) else None


def ares_get_pose_animation_cache(animation_id):
    animation_id = ares_safe_id(animation_id, "pose_animation")
    entry = ARES_POSE_ANIMATION_CACHE.get(animation_id)
    if entry is None:
        entry = _ares_read_pose_animation_cache_file(animation_id)
    if not isinstance(entry, dict):
        return None
    if animation_id in ARES_POSE_ANIMATION_CACHE:
        del ARES_POSE_ANIMATION_CACHE[animation_id]
    ARES_POSE_ANIMATION_CACHE[animation_id] = entry
    while len(ARES_POSE_ANIMATION_CACHE) > _POSE_ANIMATION_CACHE_MAX:
        oldest = next(iter(ARES_POSE_ANIMATION_CACHE))
        del ARES_POSE_ANIMATION_CACHE[oldest]
    return entry


def register_pose_animation_cache_routes():
    try:
        from server import PromptServer
        from aiohttp import web
    except Exception:
        return

    @PromptServer.instance.routes.post("/ares_pose/pose_animation_upload")
    async def ares_pose_animation_upload(request):
        try:
            if not ares_content_length_ok(request, _POSE_ANIMATION_CACHE_MAX_TOTAL_CHARS + 1024 * 1024):
                return web.json_response({"error": "animation payload is too large"}, status=413)
            data = await request.json()
            animation_id = data.get("animation_id")
            if not animation_id:
                return web.json_response({"error": "missing animation_id"}, status=400)
            animation_id = ares_safe_id(animation_id, "pose_animation")
            try:
                animation, revision = ares_validate_pose_animation_payload(data)
            except ValueError as exc:
                return web.json_response({"error": str(exc)}, status=413)

            previous = ares_get_pose_animation_cache(animation_id)
            previous_revision = int(previous.get("revision", -1)) if isinstance(previous, dict) else -1
            if previous_revision > revision:
                return web.json_response({
                    "status": "stale_ignored",
                    "animation_id": animation_id,
                    "revision": previous_revision,
                })

            entry = {
                "animation": animation,
                "revision": revision,
            }
            if animation_id in ARES_POSE_ANIMATION_CACHE:
                del ARES_POSE_ANIMATION_CACHE[animation_id]
            ARES_POSE_ANIMATION_CACHE[animation_id] = entry
            _ares_write_pose_animation_cache_file(animation_id, entry)
            while len(ARES_POSE_ANIMATION_CACHE) > _POSE_ANIMATION_CACHE_MAX:
                oldest = next(iter(ARES_POSE_ANIMATION_CACHE))
                del ARES_POSE_ANIMATION_CACHE[oldest]

            return web.json_response({
                "status": "ok",
                "animation_id": animation_id,
                "revision": revision,
            })
        except Exception as e:
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.get("/ares_pose/pose_animation/{animation_id}")
    async def ares_pose_animation_get(request):
        animation_id = ares_safe_id(request.match_info["animation_id"], "pose_animation")
        entry = ares_get_pose_animation_cache(animation_id)
        if not entry:
            return web.json_response({"error": "not found"}, status=404)
        return web.json_response(entry, headers={"Cache-Control": "no-store"})
