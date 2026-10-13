from comfy_api.latest import io, ComfyExtension

import json
import os

from .node.ares_text_enhance_node import AresTextEnhance
from .node.ares_qwen_prompt_enhance import AresQwenWorkbench
from .node.ares_qwen_seed_variance import AresQwenSeedVariance
from .node.ares_inpaint_stitch import AresInpaintStitch
from .node.ares_qwen21_styles import (
    lib_pairs,
    load_style_meta,
    load_user_styles,
    remove_user_style,
    resolve_lib,
    resolve_sample,
    save_user_style,
    thumbnail_url,
    user_style_payload,
)
from .pose_studio.wrapper import AresPoseStudio

WEB_DIRECTORY = "./web"

print("✨ Ares Qwen-Image-2.1 文本增强 / 提示词增强 节点已启动")


def _style_favorites_path() -> str:
    """收藏存 ComfyUI 根目录，绝不放 styles/ —— 那里的 JSON 变动会触发执行缓存失效。"""
    try:
        import folder_paths
        base_path = getattr(folder_paths, "base_path", None) or os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    except Exception:
        base_path = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    return os.path.join(base_path, "ares_style_favorites.json")


def _load_style_favorites() -> list:
    try:
        with open(_style_favorites_path(), "r", encoding="utf-8") as f:
            data = json.load(f)
        items = data.get("items") if isinstance(data, dict) else data
        if not isinstance(items, list):
            return []
        return [x for x in items if isinstance(x, dict) and x.get("lib") and x.get("name")]
    except FileNotFoundError:
        return []
    except Exception:
        return []


def _save_style_favorites(items: list) -> None:
    clean = []
    for x in items[:2000]:   # 上限防工作流外的异常请求把文件撑爆
        if not (isinstance(x, dict) and str(x.get("lib") or "").strip() and str(x.get("name") or "").strip()):
            continue
        clean.append({"lib": str(x["lib"]), "name": str(x["name"]), "t": int(x.get("t") or 0)})
    tmp = _style_favorites_path() + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump({"version": 1, "items": clean}, f, ensure_ascii=False)
    os.replace(tmp, _style_favorites_path())


def _register_routes() -> None:
    """风格列表与样图接口（前端风格网格用）。可重复调用。"""
    if getattr(_register_routes, "_done", False):
        return
    try:
        from aiohttp import web
        from server import PromptServer

        routes = PromptServer.instance.routes
    except Exception:
        return
    try:
        @routes.get("/ares_qwen/style_libs")
        async def ares_qwen_style_libs(request):
            """库名对照表：原始文件名 ↔ 中文显示名（前端迁移旧工作流的值）。"""
            try:
                resp = web.json_response({"ok": True, "items": lib_pairs()})
            except Exception as e:
                resp = web.json_response({"ok": False, "error": str(e), "items": []}, status=500)
            resp.headers["Cache-Control"] = "no-store"
            return resp

        @routes.get("/ares_qwen/styles")
        async def ares_qwen_styles(request):
            try:
                name = str(request.rel_url.query.get("name") or "")
                name = resolve_lib(name)
                items = []
                if name and name != "none":
                    for m in load_style_meta(name):
                        items.append({
                            "name": m["name"],
                            "name_cn": m["name_cn"],
                            "prompt": m["prompt"],
                            "negative_prompt": m["negative_prompt"],
                            "thumbnail": thumbnail_url(m["thumbnail"]),
                            "group": m.get("group", ""),
                        })
                return web.json_response({"ok": True, "items": items})
            except Exception as e:
                return web.json_response({"ok": False, "error": str(e), "items": []}, status=500)

        @routes.get("/ares_qwen/styles/image")
        async def ares_qwen_styles_image(request):
            try:
                fname = str(request.rel_url.query.get("file") or "")
                path = resolve_sample(fname)
                if not path:
                    return web.Response(status=404, text="not found")
                return web.FileResponse(path)
            except Exception as e:
                return web.json_response({"ok": False, "error": str(e)}, status=500)

        @routes.get("/ares_qwen/user_style_list")
        async def ares_qwen_user_style_list(request):
            try:
                items = [user_style_payload(d) for d in load_user_styles()]
                resp = web.json_response({"ok": True, "items": items})
            except Exception as e:
                resp = web.json_response({"ok": False, "error": str(e), "items": []}, status=500)
            resp.headers["Cache-Control"] = "no-store"
            return resp

        @routes.get("/ares_qwen/user_styles")
        @routes.post("/ares_qwen/user_styles")
        async def ares_qwen_user_styles(request):
            try:
                import base64

                if request.method.upper() == "GET":
                    items = [user_style_payload(d) for d in load_user_styles()]
                    resp = web.json_response({"ok": True, "items": items})
                    resp.headers["Cache-Control"] = "no-store"
                    return resp
                try:
                    data = await request.json()
                except Exception:
                    data = {}
                if not isinstance(data, dict):
                    data = {}
                action = str(data.get("action") or "save").strip().lower()
                if action == "delete":
                    remove_user_style(str(data.get("name") or ""))
                    resp = web.json_response({"ok": True})
                    resp.headers["Cache-Control"] = "no-store"
                    return resp
                raw = str(data.get("image_b64") or "")
                image_bytes = None
                if raw.strip():
                    if "," in raw[:80]:
                        raw = raw.split(",", 1)[1]
                    try:
                        image_bytes = base64.b64decode(raw, validate=False)
                    except Exception:
                        return web.json_response({"ok": False, "error": "预览图无效"}, status=400)
                    if not image_bytes:
                        image_bytes = None
                item = save_user_style(
                    name=str(data.get("name") or ""),
                    prompt=str(data.get("prompt") or ""),
                    old_name=str(data.get("old_name") or ""),
                    image_bytes=image_bytes,
                )
                resp = web.json_response({"ok": True, "item": user_style_payload(item)})
                resp.headers["Cache-Control"] = "no-store"
                return resp
            except ValueError as e:
                return web.json_response({"ok": False, "error": str(e)}, status=400)
            except Exception as e:
                return web.json_response({"ok": False, "error": str(e)}, status=500)

        _register_routes._done = True
    except Exception as e:
        print(f"⚠ Ares Qwen 风格路由注册失败: {e}")

    try:
        @routes.get("/ares_qwen/style_favorites")
        async def ares_qwen_style_favorites_get(request):
            resp = web.json_response({"ok": True, "items": _load_style_favorites()})
            resp.headers["Cache-Control"] = "no-store"
            return resp

        @routes.post("/ares_qwen/style_favorites")
        async def ares_qwen_style_favorites_post(request):
            try:
                data = await request.json()
            except Exception:
                data = {}
            items = data.get("items") if isinstance(data, dict) else None
            if not isinstance(items, list):
                return web.json_response({"ok": False, "error": "items 必须是列表"}, status=400)
            _save_style_favorites(items)
            resp = web.json_response({"ok": True, "items": _load_style_favorites()})
            resp.headers["Cache-Control"] = "no-store"
            return resp
    except Exception:
        pass


def _register_no_cache_middleware() -> None:
    """本插件 web 文件加 no-cache 头。Edge/Chrome 的启发式缓存曾把旧入口 js
    缓存数小时（文件 mtime 越旧窗口越长），导致前端更新后普通刷新拿不到新代码
    （2026-10-02 实测）。只作用于本插件路径，可重复调用。"""
    if getattr(_register_no_cache_middleware, "_done", False):
        return
    try:
        from server import PromptServer

        app = PromptServer.instance.app
    except Exception:
        return
    if any(getattr(m, "_ares_no_cache", False) for m in app.middlewares):
        return

    from aiohttp import web

    @web.middleware
    async def ares_no_cache_middleware(request, handler):
        response = await handler(request)
        if request.path.startswith("/extensions/Ares-Qwen2.1-text/"):
            response.headers["Cache-Control"] = "no-cache, no-store, must-revalidate"
        return response

    ares_no_cache_middleware._ares_no_cache = True
    app.middlewares.append(ares_no_cache_middleware)
    _register_no_cache_middleware._done = True


_register_routes()
_register_no_cache_middleware()


class AresTextEnhanceExtension(ComfyExtension):
    async def get_node_list(self) -> list[type[io.ComfyNode]]:
        _register_routes()
        from .pose_studio import ensure_routes_registered

        ensure_routes_registered()
        return [AresTextEnhance, AresQwenWorkbench, AresQwenSeedVariance, AresInpaintStitch, AresPoseStudio]


async def comfy_entrypoint() -> AresTextEnhanceExtension:
    return AresTextEnhanceExtension()


# 不要在这里定义 NODE_CLASS_MAPPINGS：
# 本模块一旦有它，ComfyUI 就只走旧式注册路径，节点会被旧式适配器重新包装，
# 输入张量的传递方式随之改变，视觉塔会拿到不匹配的尺寸。
# 两个节点统一走 comfy_entrypoint（新式）注册。
