"""Ares Pose Studio：从 VNCCS Utils 复制改名的独立姿态工作室节点。

导入本包即注册 HTTP 路由（姿态库、捕获同步、动画缓存、SAM 3D 导入）；
节点类经 wrapper.AresPoseStudio 由插件 comfy_entrypoint 注册。
"""

_registered = False


def ensure_routes_registered():
    global _registered
    if _registered:
        return
    from .routes import register_routes

    _registered = register_routes()


ensure_routes_registered()
