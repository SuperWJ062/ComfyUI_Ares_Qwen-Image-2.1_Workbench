"""HTTP routes for the Ares Pose Studio node.

Registers the pose library API, the browser capture sync API, the capture /
animation caches, and the SAM 3D Body image-to-pose import endpoints.
"""

import numpy as np

_SAM3D_MAX_UPLOAD_BYTES = 32 * 1024 * 1024
_SAM3D_MAX_PIXELS = 4096 * 4096


def register_routes():
    if getattr(register_routes, "_done", False):
        return True
    try:
        from server import PromptServer

        if PromptServer.instance is None:
            return False
        from aiohttp import web

        from .api import pose_library, pose_sync
        from .caches import (
            ares_content_length_ok,
            register_capture_cache_routes,
            register_pose_animation_cache_routes,
        )
    except Exception as e:
        print(f"[Ares Pose Studio] Failed to prepare routes: {e}")
        return False

    try:
        pose_library.register_routes(PromptServer.instance.app)
    except Exception as e:
        print(f"[Ares Pose Studio] Failed to register Pose Library API: {e}")

    try:
        pose_sync.register_routes(PromptServer.instance.app)
    except Exception as e:
        print(f"[Ares Pose Studio] Failed to register Pose Sync API: {e}")

    register_capture_cache_routes()
    register_pose_animation_cache_routes()
    register_routes._done = True
    return True

    @PromptServer.instance.routes.get("/ares_pose/sam3d/import_status/{task_id}")
    async def ares_sam3d_import_status(request):
        try:
            from .sam3d import progress

            return web.json_response(progress.get_task(request.match_info["task_id"]))
        except Exception as e:
            return web.json_response({
                "status": "unknown",
                "message": str(e),
                "progress": 0,
            })

    @PromptServer.instance.routes.post("/ares_pose/sam3d/process_image_to_pose_json")
    async def ares_sam3d_process_image_to_pose_json(request):
        task_id = ""
        try:
            import io
            import json
            import asyncio
            import torch
            from PIL import Image

            if not ares_content_length_ok(request, _SAM3D_MAX_UPLOAD_BYTES + 1024 * 1024):
                return web.json_response({"error": "image upload is too large"}, status=413)
            post = await request.post()
            image_field = post.get("image")
            if image_field is None or not hasattr(image_field, "file"):
                return web.json_response({"error": "missing image"}, status=400)
            task_id = str(post.get("task_id") or "")

            image_bytes = image_field.file.read()
            if len(image_bytes) > _SAM3D_MAX_UPLOAD_BYTES:
                return web.json_response({"error": "image upload is too large"}, status=413)
            pil_image = Image.open(io.BytesIO(image_bytes))
            if pil_image.width * pil_image.height > _SAM3D_MAX_PIXELS:
                return web.json_response({"error": "image dimensions are too large"}, status=413)
            pil_image = pil_image.convert("RGB")
            image_np = np.asarray(pil_image).astype(np.float32) / 255.0
            image_tensor = torch.from_numpy(image_np).unsqueeze(0)

            def run_sam3d_process():
                from .sam3d import process_image_to_pose_json, progress

                progress.start_task(task_id)
                with progress.task_context(task_id):
                    progress.update("Step 1/6: Image uploaded. Preparing SAM 3D Body import...", 2)
                    return process_image_to_pose_json(image_tensor)

            pose_json = await asyncio.to_thread(run_sam3d_process)

            try:
                pose_data = json.loads(pose_json)
            except Exception:
                pose_data = None

            return web.json_response({
                "status": "success",
                "pose_json": pose_json,
                "pose_data": pose_data,
            })
        except Exception as e:
            try:
                from .sam3d import progress
                with progress.task_context(task_id if "task_id" in locals() else ""):
                    progress.fail(str(e))
            except Exception:
                pass
            import traceback
            traceback.print_exc()
            return web.json_response({"error": str(e)}, status=500)

    @PromptServer.instance.routes.post("/ares_pose/sam3d/render_mesh_overlay")
    async def ares_sam3d_render_mesh_overlay(request):
        try:
            import asyncio

            if not ares_content_length_ok(request, 32 * 1024 * 1024):
                return web.json_response({"error": "mesh overlay payload is too large"}, status=413)
            data = await request.json()
            pose_data = data.get("pose_data")
            if not isinstance(pose_data, dict):
                return web.json_response({"error": "missing pose_data"}, status=400)
            body_preset = data.get("body_preset") if isinstance(data.get("body_preset"), dict) else {}
            pose_adjust = float(data.get("pose_adjust") or 0.0)

            def build_overlay():
                from .sam3d.pose_import import process_pose_json_to_overlay_mesh

                return process_pose_json_to_overlay_mesh(
                    pose_data,
                    body_preset=body_preset,
                    pose_adjust=pose_adjust,
                )

            mesh_data = await asyncio.to_thread(build_overlay)
            return web.json_response({"status": "success", "mesh": mesh_data})
        except Exception as e:
            import traceback
            traceback.print_exc()
            return web.json_response({"error": str(e)}, status=500)
