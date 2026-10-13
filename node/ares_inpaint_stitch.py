"""「Ares 局部缝合」：把裁剪区的采样结果按羽化遮罩缝回原图。

配合工作台「缝合数据」输出口使用：图像1 输出裁剪区去采样，
本节点把解码结果缝回完整原图，范围外像素保持原样。
缝合数据为空（未启用裁剪重绘）时直通输入图像，节点可常驻接在工作流里。
"""

import logging

from comfy_api.latest import io

from .ares_inpaint_core import stitch

log = logging.getLogger(__name__)


class AresInpaintStitch(io.ComfyNode):
    @classmethod
    def define_schema(cls):
        return io.Schema(
            node_id="AresInpaintStitch",
            display_name="Ares 局部缝合",
            category="✨Prompt Assistant",
            description="把裁剪重绘的采样结果按羽化掩膜缝回原图：掩膜内用新图，掩膜外保持原像素。",
            inputs=[
                io.Custom("ARES_INPAINT_STITCH").Input(
                    "缝合数据",
                    tooltip="工作台「缝合数据」输出口；为空（未启用裁剪重绘）时本节点直通 image。",
                ),
                io.Image.Input(
                    "image",
                    tooltip="裁剪区的采样结果（VAE Decode 输出）；尺寸与裁剪区不一致时自动缩放回缝。",
                ),
            ],
            outputs=[
                io.Image.Output(id="图像", display_name="图像"),
            ],
            search_aliases=["inpaint stitch", "局部重绘", "缝合", "拼接"],
        )

    @classmethod
    def execute(cls, **kwargs):
        stitcher = kwargs.get("缝合数据")
        image = kwargs.get("image")
        if image is None:
            raise ValueError("image 为空：请接 VAE Decode 出来的采样结果")
        if stitcher is None:
            # 未启用裁剪重绘：直通，让节点可以常驻在工作流里
            log.info("[AresStitch] 缝合数据为空（未启用裁剪重绘），image 原样输出")
            return io.NodeOutput(image)
        return io.NodeOutput(stitch(stitcher, image))
