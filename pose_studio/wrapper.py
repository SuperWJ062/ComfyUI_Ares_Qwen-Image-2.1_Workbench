"""V3 registration shell for the copied Pose Studio node.

本项目约定 __init__.py 不得出现 NODE_CLASS_MAPPINGS（会走旧式注册），
所以 node.py 里的旧式节点类通过这个 ComfyNode 壳走 comfy_entrypoint 注册。
"""

import json

from comfy_api.latest import io

from .node import Ares_PoseStudio


class AresPoseStudio(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="Ares_PoseStudio",
            display_name="Ares Pose Studio",
            category="Ares/pose",
            inputs=[
                io.String.Input("pose_data", multiline=True, default="{}"),
                io.Image.Input("pose_image", optional=True),
                io.String.Input(
                    "camera_prompt",
                    default="",
                    force_input=True,
                    optional=True,
                    tooltip="Camera direction text. Angle/shot tokens orient the skydome background.",
                ),
                io.Boolean.Input(
                    "animation_image_batch",
                    default=False,
                    optional=True,
                    tooltip="Return animation frames as one IMAGE batch instead of VIDEO.",
                ),
            ],
            outputs=[
                io.Custom("IMAGE,VIDEO").Output(display_name="images", is_output_list=True),
            ],
            hidden=[io.Hidden.unique_id],
        )

    @classmethod
    def fingerprint_inputs(cls, pose_data="{}", camera_prompt="", animation_image_batch=False, **_):
        # Debug Mode 下每次都重新执行（等价旧式 IS_CHANGED 返回 NaN）。
        try:
            data = json.loads(pose_data)
            if isinstance(data, dict) and data.get("export", {}).get("debugMode", False):
                return float("NaN")
        except Exception:
            pass
        return f"{pose_data}|{camera_prompt or ''}|{animation_image_batch is True}"

    @classmethod
    def execute(cls, pose_data="{}", pose_image=None, camera_prompt="", animation_image_batch=False):
        result = Ares_PoseStudio().generate(
            pose_data=pose_data,
            pose_image=pose_image,
            camera_prompt=camera_prompt,
            animation_image_batch=animation_image_batch,
            unique_id=cls.hidden.unique_id,
        )
        images = result[0]
        # 动画"图像批次"模式返回整段 [B,H,W,C] 张量；其余路径已是列表。
        if not isinstance(images, list):
            images = [images]
        return io.NodeOutput(images)
