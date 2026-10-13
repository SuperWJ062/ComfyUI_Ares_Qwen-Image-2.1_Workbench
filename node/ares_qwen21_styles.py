"""Ares Qwen 工作台：风格库读取（本包 styles/）。

风格 JSON 结构：
    [{"name": "...", "prompt": "... {prompt} ...", "negative_prompt": "...",
      "name_cn": "...", "thumbnail": "samples/xxx.webp"}]
"""
from __future__ import annotations

import json
import logging
import os
import re
import threading
from functools import lru_cache

log = logging.getLogger(__name__)

_PKG_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
_STYLES_DIR = os.path.join(_PKG_DIR, "styles")
_SAMPLES_DIR = os.path.join(_STYLES_DIR, "samples")


_USER_FILE = "user_custom.json"
_USER_SAMPLE_SUB = "custom"
_USER_MARK = "user:"
_user_lock = threading.Lock()
_user_cache = {"sig": None, "items": None}


def styles_dir() -> str:
    return _STYLES_DIR if os.path.isdir(_STYLES_DIR) else ""


def samples_dirs() -> list[str]:
    return [_SAMPLES_DIR] if os.path.isdir(_SAMPLES_DIR) else []


@lru_cache(maxsize=1)
def list_style_files() -> tuple:
    d = styles_dir()
    if not d:
        return ("none",)
    names = [
        fn[:-5]
        for fn in sorted(os.listdir(d))
        if fn.endswith(".json") and not fn.endswith(".example") and fn != "user_custom.json"
    ]
    return ("none",) + tuple(names) if names else ("none",)


@lru_cache(maxsize=64)
def load_style_meta(stem: str) -> tuple:
    if not stem or stem == "none":
        return tuple()
    d = styles_dir()
    path = os.path.join(d, stem + ".json")
    if not os.path.isfile(path):
        return tuple()
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
    except Exception as e:
        log.warning("[AresQwen风格] 读风格失败 %s: %s", path, e)
        return tuple()
    if not isinstance(data, list):
        return tuple()
    out = []
    for item in data:
        if not isinstance(item, dict) or not item.get("name"):
            continue
        thumb = item.get("thumbnail") or ""
        if isinstance(thumb, list):
            thumb = thumb[0] if thumb else ""
        out.append({
            "name": str(item.get("name") or ""),
            "name_cn": str(item.get("name_cn") or item.get("name") or ""),
            "prompt": str(item.get("prompt") or ""),
            "negative_prompt": str(item.get("negative_prompt") or ""),
            "thumbnail": str(thumb or ""),
            "group": str(item.get("group") or ""),
        })
    return tuple(out)


@lru_cache(maxsize=64)
def load_style_file(stem: str) -> tuple:
    return tuple(
        (m["name"], m["prompt"], m["negative_prompt"]) for m in load_style_meta(stem)
    )


def style_name_choices(stem: str) -> list:
    return ["none"] + [x[0] for x in load_style_file(stem) if x[0]]


def all_styles_sig() -> tuple:
    """styles/ 下全部风格 JSON 的签名，供节点 fingerprint_inputs 做执行缓存失效。"""
    out = []
    d = styles_dir()
    if not d:
        return out
    for fn in sorted(os.listdir(d)):
        if not fn.endswith(".json"):
            continue
        try:
            st = os.stat(os.path.join(d, fn))
            out.append((fn, st.st_mtime_ns, st.st_size))
        except OSError:
            pass
    return tuple(out)


_CJK = re.compile(r"[\u4e00-\u9fff]")


def lib_display_name(stem: str) -> str:
    """库文件名的中文显示名。

    krea2_Photo-BW High Contrast-1_摄影-黑白高对比  →  摄影-黑白高对比 1
    3d_render_3D渲染_styles                         →  3D渲染
    """
    s = str(stem or "")
    if not s or s == "none":
        return s or "none"
    parts = [p for p in s.split("_") if p]
    cn = ""
    for p in reversed(parts):
        if _CJK.search(p):
            cn = p
            break
    if not cn:
        return s
    # 序号藏在英文段尾部（-1 / -2），中文段本身不动
    idx = ""
    for p in parts:
        if _CJK.search(p):
            continue
        m = re.search(r"-(\d+)$", p)
        if m:
            idx = m.group(1)
            break
    return f"{cn} {idx}" if idx else cn


def lib_choices() -> list:
    """下拉选项：自定义（默认库）、其余各库的中文显示名。
    不提供 none——不套风格用「自定义」库里的「无」；旧工作流的 none 值内部仍兼容。"""
    out = []
    rest = []
    for stem in list_style_files():
        if stem == "none":
            continue
        name = lib_display_name(stem)
        if name == "自定义":
            out.append(name)
        else:
            rest.append(name)
    return out + rest


def resolve_lib(value: str) -> str:
    """把下拉里的中文名（或旧工作流里的原始文件名）还原成库 stem。"""
    v = str(value or "").strip()
    if not v or v == "none":
        return "none"
    if v.startswith("krea2_"):  # 旧工作流里带 krea2_ 前缀的库文件名/显示名
        v = v[6:]
    files = list_style_files()
    if v in files:
        return v
    for stem in files:
        if stem != "none" and lib_display_name(stem) == v:
            return stem
    return v


def lib_pairs() -> list:
    """[{value: 原始文件名, label: 中文显示名}]，给前端做旧值迁移。"""
    out = []
    for stem in list_style_files():
        if stem == "none":
            continue
        out.append({"value": stem, "label": lib_display_name(stem)})
    return out


def marked_user_name(style_name: str):
    """自定义风格选择值（user:xxx）。None 表示不是自定义标记。"""
    text = str(style_name or "")
    if text.startswith(_USER_MARK):
        return text[len(_USER_MARK):]
    return None


def _clean_tpl(p) -> str:
    """剥离模板里的 {pe} 改写种子标记（标记由调用方读取）。"""
    return str(p or "").replace("{pe}", "")


def find_style(style_file: str, style_name: str):
    """返回 (prompt 模板原文含 {pe} 标记, negative)。找不到返回 None。"""
    name = str(style_name or "").strip()
    if not name or name == "none":
        return None
    marked = marked_user_name(name)
    if marked is not None:
        name = marked
        if not name or name == "none":
            return None
    else:
        if style_file and style_file != "none":
            for n, p, ng in load_style_file(str(style_file)):
                if n == name:
                    return p, ng
        for stem in list_style_files():
            if stem == "none":
                continue
            for n, p, ng in load_style_file(stem):
                if n == name:
                    return p, ng
    user = find_user_style(name)
    if user:
        return str(user.get("prompt") or ""), str(user.get("negative_prompt") or "")
    return None


def style_core_text(style_file: str, style_name: str) -> str:
    """编辑模式用：返回风格核心描述（外观型模板）。
    - 带 Subject:{prompt} 尾缀的描述型 → 剥离尾缀与 Style: 前缀后的核心；
    - 完全不含 {prompt} 的外观型（用户手写）→ 原文剥离前缀；
    - 指令式（{prompt} 在模板内部，如四视图/改动作）→ 空串（走原替换路径）。"""
    found = find_style(style_file, style_name)
    if found is None:
        return ""
    tmpl = _clean_tpl(found[0])
    if re.search(r"Subject\s*[:：]\s*\{prompt\}\s*$", tmpl, re.I):
        m = re.search(r"^(?P<body>.*?)[\s.]*Subject\s*[:：]\s*\{prompt\}\s*$", tmpl, re.I | re.S)
        core = re.sub(r"^Style\s*[:：]\s*", "", m.group("body").strip(), flags=re.I)
        return core.strip(" ,.-")
    if "{prompt}" not in tmpl:
        core = re.sub(r"^Style\s*[:：]\s*", "", tmpl.strip(), flags=re.I)
        return core.strip(" ,.-")
    return ""


def apply_style(user_prompt: str, style_file: str, style_name: str) -> tuple[str, str]:
    """把风格模板套到用户提示词上：有 {prompt} 就替换，否则逗号拼接。"""
    user_prompt = (user_prompt or "").strip()
    found = find_style(style_file, style_name)
    if found is None:
        return user_prompt, ""
    tmpl, neg = _clean_tpl(found[0]), found[1]
    if "{prompt}" in tmpl:
        pos = tmpl.replace("{prompt}", user_prompt)
    elif user_prompt:
        pos = f"{tmpl}, {user_prompt}" if tmpl else user_prompt
    else:
        pos = tmpl
    return pos.strip(), (neg or "").strip()


def resolve_sample(filename: str) -> str:
    """按文件名在 samples/styles 目录里找样图，找不到返回空串。"""
    name = str(filename or "").replace("\\", "/").strip().lstrip("/")
    if not name or ".." in name.split("/"):
        return ""
    if name.startswith("samples/"):
        name = name[len("samples/"):]
    base = os.path.basename(name)
    for d in samples_dirs():
        for cand in (name, base):
            p = os.path.join(d, cand)
            if os.path.isfile(p):
                return p
    return ""


def thumbnail_url(thumb: str) -> str:
    """把 json 里的 thumbnail 字段换成可访问的本地 URL（保留 custom/ 之类子路径）。"""
    from urllib.parse import quote

    raw = str(thumb or "").replace("\\", "/").strip()
    if raw.startswith("http"):
        return raw
    if raw.startswith("samples/"):
        raw = raw[len("samples/"):]
    if not raw:
        return ""
    return f"/ares_qwen/styles/image?file={quote(raw)}"


# —————————————— 自定义风格（本包 styles/user_custom.json + samples/custom/）——————————————


def _user_styles_path() -> str:
    return os.path.join(_STYLES_DIR, _USER_FILE)


def _user_sig():
    path = _user_styles_path()
    try:
        st = os.stat(path)
        return (getattr(st, "st_mtime_ns", st.st_mtime), st.st_size)
    except Exception:
        return None


def _normalize_user_item(item):
    if not isinstance(item, dict):
        return None
    name = str(item.get("name") or "").strip()
    if not name or name.lower() == "none":
        return None
    return {
        "name": name,
        "name_cn": name,
        "prompt": str(item.get("prompt") or ""),
        "negative_prompt": str(item.get("negative_prompt") or ""),
        "thumbnail": str(item.get("thumbnail") or "").replace("\\", "/"),
        "custom": True,
    }


def _load_user_styles_unlocked() -> list:
    sig = _user_sig()
    cached = _user_cache.get("items")
    if cached is not None and _user_cache.get("sig") == sig:
        return [dict(x) for x in cached]
    path = _user_styles_path()
    items = []
    if sig is not None and os.path.isfile(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
        except Exception as e:
            log.warning("[AresQwen风格] 读自定义风格失败: %s", e)
            data = []
        if isinstance(data, list):
            for raw in data:
                one = _normalize_user_item(raw)
                if one:
                    items.append(one)
    _user_cache["sig"] = sig
    _user_cache["items"] = items
    return [dict(x) for x in items]


def load_user_styles() -> list:
    with _user_lock:
        return _load_user_styles_unlocked()


def find_user_style(name: str):
    name = str(name or "")
    if not name:
        return None
    for item in load_user_styles():
        if item.get("name") == name:
            return item
    return None


def _write_user_styles_unlocked(items: list) -> None:
    path = _user_styles_path()
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".tmp"
    payload = []
    for raw in items:
        one = _normalize_user_item(raw)
        if one:
            payload.append(one)
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(payload, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)
    _user_cache["sig"] = None
    _user_cache["items"] = None


def _user_preview_path(rel: str) -> str:
    rel = str(rel or "").replace("\\", "/").lstrip("/")
    if not rel.startswith(_USER_SAMPLE_SUB + "/") or ".." in rel.split("/"):
        return ""
    root = os.path.abspath(os.path.join(_SAMPLES_DIR, _USER_SAMPLE_SUB))
    path = os.path.abspath(os.path.join(_SAMPLES_DIR, rel))
    if path != root and not path.startswith(root + os.sep):
        return ""
    return path


def _delete_preview(rel: str) -> None:
    path = _user_preview_path(rel)
    if not path:
        return
    try:
        if os.path.isfile(path):
            os.remove(path)
    except Exception as e:
        log.warning("[AresQwen风格] 删除预览图失败 %s: %s", rel, e)


def _save_preview(data: bytes) -> str:
    if not data or len(data) > 12 * 1024 * 1024:
        raise ValueError("预览图无效")
    try:
        import io
        import uuid

        from PIL import Image

        im = Image.open(io.BytesIO(data))
        im.load()
        if im.mode == "RGBA":
            bg = Image.new("RGB", im.size, (17, 17, 17))
            bg.paste(im, mask=im.split()[-1])
            im = bg
        else:
            im = im.convert("RGB")
        im.thumbnail((512, 512))
        folder = os.path.join(_SAMPLES_DIR, _USER_SAMPLE_SUB)
        os.makedirs(folder, exist_ok=True)
        fn = uuid.uuid4().hex + ".webp"
        im.save(os.path.join(folder, fn), "WEBP", quality=85)
        return f"{_USER_SAMPLE_SUB}/{fn}"
    except ValueError:
        raise
    except Exception as e:
        raise ValueError("预览图无法识别") from e


def save_user_style(name: str, prompt: str, old_name: str = "", image_bytes=None) -> dict:
    """新增或更新自定义风格。image_bytes 为空则保留原预览图。"""
    name = str(name or "").strip()
    old_name = str(old_name or "").strip()
    prompt = str(prompt or "")
    if not name or name.lower() == "none":
        raise ValueError("请填写名字")
    if "\0" in name:
        raise ValueError("名字无效")
    if not str(prompt or "").strip():
        raise ValueError("请填写风格提示词")

    new_thumb = _save_preview(image_bytes) if image_bytes else ""
    item = None
    old = None
    try:
        with _user_lock:
            items = _load_user_styles_unlocked()
            if old_name:
                for it in items:
                    if it.get("name") == old_name:
                        old = it
                        break
                if old is None:
                    raise ValueError("找不到该风格")
            for it in items:
                if it.get("name") == name and name != old_name:
                    raise ValueError("这个名字已经存在")
            thumb = new_thumb or ((old.get("thumbnail") if old else "") or "")
            item = {
                "name": name,
                "name_cn": name,
                "prompt": prompt,
                "negative_prompt": "",
                "thumbnail": thumb,
                "custom": True,
            }
            new_items = []
            replaced = False
            key = old_name or name
            for it in items:
                if not replaced and it.get("name") == key:
                    new_items.append(item)
                    replaced = True
                else:
                    new_items.append(dict(it))
            if not replaced:
                if old_name:
                    raise ValueError("找不到该风格")
                new_items.append(item)
            _write_user_styles_unlocked(new_items)
    except Exception:
        if new_thumb:
            _delete_preview(new_thumb)
        raise
    if new_thumb and old and old.get("thumbnail") and old.get("thumbnail") != new_thumb:
        _delete_preview(old.get("thumbnail") or "")
    return dict(item)


def remove_user_style(name: str) -> None:
    name = str(name or "").strip()
    if not name:
        raise ValueError("请填写名字")
    removed = None
    with _user_lock:
        items = _load_user_styles_unlocked()
        kept = []
        for it in items:
            if removed is None and it.get("name") == name:
                removed = it
            else:
                kept.append(it)
        if removed is None:
            raise ValueError("找不到该风格")
        _write_user_styles_unlocked(kept)
    _delete_preview((removed or {}).get("thumbnail") or "")


def user_style_payload(item: dict) -> dict:
    """给前端的自定义风格条目（含样图 URL）。"""
    return {
        "name": str(item.get("name") or ""),
        "prompt": str(item.get("prompt") or ""),
        "thumbnail": thumbnail_url(item.get("thumbnail") or ""),
        "custom": True,
    }
