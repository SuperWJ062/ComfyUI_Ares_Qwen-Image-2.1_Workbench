"""Ares Qwen 工作台（风格 / 参考图遮罩 / 批量提示词 / PE 改写，单节点）

装配 + 改写一体：风格模板套用、参考图加载与遮罩标注、按行批量提示词、
可选经 PE（Qwen-Image-2.1 提示词改写模型）逐行改写后输出。
UI 由 web/ares_qwen_prompt_enhance.js 接管；改写引擎在 ares_pe_engine.py。

必须走新式注册（io.ComfyNode + comfy_entrypoint）：
本模块若出现 NODE_CLASS_MAPPINGS，节点会被旧式适配器重新包装，
输入张量传递方式改变，视觉塔会拿到不匹配的尺寸（10880 vs 8160）。

模式：
    文生图     风格模板 + 输入，PE 走 T2I 改写，参考图忽略
    图片编辑   额外加 <imageN> 定位前缀（按实际图片数），PE 走 I2I 改写

遮罩：
    只有第 1 张参考图的遮罩参与局部编辑：遮罩区叠半透明红、提示词追加
    红色区域说明，标注图随图像输出口送 TextEncodeQwenImage21 编辑；
    遮罩近全图或近空时按整图编辑。遮罩与 PE 改写模型无关。
"""
from __future__ import annotations

import json
import logging
import os
import re

import numpy as np
import torch
from PIL import Image, ImageOps

import folder_paths
import comfy.model_management
import comfy.utils

from comfy_api.latest import io

from .ares_inpaint_core import feather_mask, parse_crop_blend, parse_crop_ctx, parse_crop_rect, prepare_crop
from .ares_pe_engine import pe_rewrite
from .ares_qwen21_styles import (
    all_styles_sig,
    apply_style,
    find_style,
    lib_choices,
    resolve_lib,
    style_core_text,
)

log = logging.getLogger(__name__)

MAX_OUT = 6

MODE_T2I = "文生图"
MODE_EDIT = "图片编辑"
MODES = [MODE_T2I, MODE_EDIT]

# 局部编辑时追加的说明，告诉模型红色是标注不是内容
_MASK_TIP = "只修改红色半透明区域，不要保留红色，区域外必须与原图完全一致。"
# 裁剪重绘时追加的范围说明（图上没有红色标注，措辞不同）
_CROP_TIP = "只修改遮罩区域内的内容，区域外必须与原图完全一致。"
# 命中这些关键词的行跳过 PE 改写：PE 会丢失透明背景类要求。
# 只匹配「背景意图」的明确短语——裸词如 透明/alpha/png 会误伤「透明丝袜」「半透明蕾丝」等正常描述。
_NO_PE_RE = re.compile(
    r"透明背景|背景透明|透明底|透明底图|去背景|去除背景|去掉背景|去掉底|去背|"
    r"背景(去掉|去除|移除|删掉|抹掉)|移除背景|移掉背景|"
    r"抠图|抠像|免扣|免抠|去底|白底图|"
    r"transparent background|remove the background|no background|alpha channel",
    re.I)



def _load_image_tensor(path: str):
    img = Image.open(path)
    img = ImageOps.exif_transpose(img)
    if img.mode == "I":
        img = img.point(lambda i: i * (1 / 255))
    has_alpha = img.mode in ("RGBA", "LA") or (img.mode == "P" and "transparency" in img.info)
    image = img.convert("RGBA") if has_alpha else img.convert("RGB")
    arr = np.array(image).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None, ...]


def _resolve_path(name: str, folder_type: str = "input") -> str | None:
    """按 type=input/output/temp + 相对路径解析图片；只认三个标准目录内的文件，
    目录外的绝对/相对路径一律拒绝。"""
    if not name:
        return None
    name = str(name).strip().replace("\\", "/")

    bases = []
    ft = (folder_type or "input").lower()
    try:
        if ft == "output":
            bases.append(folder_paths.get_output_directory())
        elif ft == "temp":
            bases.append(folder_paths.get_temp_directory())
        else:
            bases.append(folder_paths.get_input_directory())
    except Exception:
        pass
    for getter in (
        folder_paths.get_input_directory,
        folder_paths.get_output_directory,
        folder_paths.get_temp_directory,
    ):
        try:
            b = getter()
            if b and b not in bases:
                bases.append(b)
        except Exception:
            pass

    for base in bases:
        root = os.path.realpath(base)
        for cand in (name, os.path.basename(name)):
            p = os.path.realpath(os.path.join(base, cand))
            if os.path.isfile(p) and p.startswith(root + os.sep):
                return p
    return None


def _parse_media_json(raw) -> list[dict]:
    """[{image, mask, type, subfolder}] 或换行路径 → 条目列表。"""
    text = str(raw or "").strip()
    if not text:
        return []
    try:
        data = json.loads(text)
    except Exception:
        return [{"image": p.strip()} for p in text.splitlines() if p.strip()]
    if not isinstance(data, list):
        return []
    out = []
    for item in data:
        if isinstance(item, str) and item.strip():
            out.append({"image": item.strip()})
        elif isinstance(item, dict) and item.get("image"):
            out.append({
                "image": str(item.get("image") or "").strip(),
                "mask": str(item.get("mask") or "").strip(),
                "type": str(item.get("type") or "input").strip() or "input",
                "subfolder": str(item.get("subfolder") or "").strip(),
                "maskType": str(item.get("maskType") or "").strip(),
                "maskSubfolder": str(item.get("maskSubfolder") or "").strip(),
                "inpaintCrop": item.get("inpaintCrop") or None,
            })
    return out


def _prompt_lines(text, start_index=0, max_rows=1000, remove_empty=False) -> list[str]:
    """按行切分。勾选去除空行时，全部非空行合并为一条提示词（一段被换行/空行
    拆开的长提示词算一段，不按行切多张图）。空文本只保留一段空提示。"""
    lines = str(text or "").splitlines()
    if remove_empty:
        merged = " ".join(ln.strip() for ln in lines if ln.strip()).strip()
        return [merged] if merged else [""]
    if not lines:
        return [""]
    start = max(0, min(int(start_index or 0), len(lines) - 1))
    count = max(1, int(max_rows or 1))
    return lines[start:start + count] or [""]


def _edit_prefix(prompt: str, n_img: int) -> str:
    """图片编辑模式：给提示词补图像定位（已带 tag 就不动）。"""
    p = prompt or ""
    if n_img <= 0:
        return p
    low = p.lower()
    if all(f"<image{i}>" in low or f"<image {i}>" in low for i in range(1, n_img + 1)):
        return p
    if n_img == 1:
        prefix = "根据 <image1> 进行编辑。"
    else:
        # 参考列表从 <image2> 起：<image1> 已在前面声明为编辑目标，
        # 再列进"其余"里会让模型把目标图也当参考（2026-10-03 用户指出）。
        tags = " ".join(f"<image{i}>" for i in range(2, n_img + 1))
        prefix = f"图1 <image1> 为编辑目标，其余 {tags} 为参考。"
    return f"{prefix}{p.strip()}" if p.strip() else prefix


def _load_mask_tensor(path: str, h: int, w: int):
    if not path or not os.path.isfile(path):
        return torch.zeros((1, h, w), dtype=torch.float32)
    m = Image.open(path)
    m = ImageOps.exif_transpose(m).convert("L")
    if m.size != (w, h):
        m = m.resize((w, h), Image.Resampling.BILINEAR)
    arr = np.array(m).astype(np.float32) / 255.0
    return torch.from_numpy(arr)[None, ...]


def _mask_from_preview(path: str, h: int, w: int):
    """遮罩若被存成彩色预览，改从透明或亮部还原。"""
    try:
        raw = Image.open(path).convert("RGBA")
        arr = np.array(raw).astype(np.float32) / 255.0
        if arr.shape[-1] == 4 and float(arr[..., 3].min()) < 0.99:
            msk = 1.0 - arr[..., 3]
        else:
            msk = arr[..., 2]
        if msk.shape != (h, w):
            msk = np.array(
                Image.fromarray((msk * 255).astype(np.uint8)).resize((w, h))
            ).astype(np.float32) / 255.0
        return torch.from_numpy(msk)[None, ...]
    except Exception:
        return None


def _load_item_mask(item: dict, h: int, w: int):
    """按条目的 mask/maskType/maskSubfolder 读遮罩，没有或读不到返回 None。"""
    mrel = str(item.get("mask") or "").strip()
    if not mrel:
        return None
    mtype = str(item.get("maskType") or item.get("type") or "input").strip() or "input"
    msub = str(item.get("maskSubfolder") or "").replace("\\", "/").strip("/")
    mpath = mrel.replace("\\", "/")
    if msub and f"{msub}/" not in mpath:
        mpath = f"{msub}/{os.path.basename(mpath)}"
    mp = _resolve_path(mpath, mtype)
    if not mp:
        mp = _resolve_path(os.path.basename(mpath), "input")
    if not mp:
        log.warning("[AresQwenPE] 找不到遮罩文件: %s", mrel)
        return None
    mk = _load_mask_tensor(mp, h, w)
    if float(mk.max()) < 0.01:
        preview = _mask_from_preview(mp, h, w)
        if preview is not None:
            mk = preview
    return mk


def _prep_mask(mask, h: int, w: int):
    m = mask
    if m.ndim == 2:
        m = m.unsqueeze(0)
    if m.ndim == 4:
        m = m[:, 0]
    if m.shape[-2:] != (h, w):
        m = torch.nn.functional.interpolate(
            m.unsqueeze(1).float(), size=(h, w), mode="bilinear", align_corners=False
        ).squeeze(1)
    return (m[:1] > 0.5).float()


def _rect_mask(rect, h: int, w: int) -> torch.Tensor:
    """框选范围 → 整图分辨率 0/1 矩形遮罩（越界收进画布）。"""
    x0, y0, w0, h0 = rect
    x1 = max(x0 + 16, min(x0 + w0, w))
    y1 = max(y0 + 16, min(y0 + h0, h))
    x0 = max(0, min(x0, w - 16))
    y0 = max(0, min(y0, h - 16))
    rm = torch.zeros(1, h, w)
    rm[:, y0:y1, x0:x1] = 1.0
    return rm


def _overlay_mask_red(image: torch.Tensor, mask) -> torch.Tensor:
    """局部编辑标注：遮罩区叠半透明红色，让 Qwen2.1 看见要改的区域。

    遮罩按原值软混合（不二值化）——羽化遮罩的标注边缘也是渐变的。
    """
    img = image if image.ndim == 4 else image.unsqueeze(0)
    rgb = img[:1, ..., :3].float().clone()
    if img.shape[-1] > 3:
        a = img[:1, ..., 3:4].clamp(0, 1)
        rgb = rgb * a + (1.0 - a)
    m = mask
    if m.ndim == 2:
        m = m.unsqueeze(0)
    if m.ndim == 4:
        m = m[:, 0]
    if m.shape[-2:] != (int(rgb.shape[1]), int(rgb.shape[2])):
        m = torch.nn.functional.interpolate(
            m.unsqueeze(1).float(), size=(rgb.shape[1], rgb.shape[2]), mode="bilinear", align_corners=False
        ).squeeze(1)
    m = m[:1].clamp(0, 1).to(device=rgb.device, dtype=rgb.dtype).unsqueeze(-1)
    tint = rgb * 0.4
    tint[..., 0] = (tint[..., 0] + 0.6).clamp(0, 1)
    tint[..., 1] = tint[..., 1] * 0.4
    tint[..., 2] = tint[..., 2] * 0.4
    return (rgb * (1.0 - m) + tint * m).clamp(0, 1)


class AresQwenWorkbench(io.ComfyNode):
    """风格 / 参考图遮罩 / 按行提示词 → 6 张图像 + 改写后提示词 + cfg。"""

    @classmethod
    def define_schema(cls):
        libs = lib_choices()
        default_lib = "自定义" if "自定义" in libs else (libs[0] if libs else "none")
        default_style = "无" if default_lib == "自定义" else "none"
        return io.Schema(
            node_id="AresQwenWorkbench",
            display_name="Ares Qwen 工作台",
            category="✨Prompt Assistant",
            inputs=[
                io.Combo.Input(
                    "风格库",
                    options=libs,
                    default=default_lib,
                    tooltip="风格库（中文名，磁盘上仍是原文件名）。",
                ),
                io.String.Input(
                    "风格",
                    default=default_style,
                    tooltip="当前风格（由风格卡片写入）。",
                ),
                io.Combo.Input(
                    "模式",
                    options=MODES,
                    default=MODE_T2I,
                    tooltip="文生图=风格+输入，PE 走 T2I 改写；图片编辑=额外加图像定位前缀，PE 走 I2I 改写。",
                ),
                io.String.Input(
                    "图片数据",
                    multiline=True,
                    default="[]",
                    tooltip="参考图数据（前端图片区维护）。",
                ),
                io.String.Input(
                    "提示词文本",
                    multiline=True,
                    default="",
                    tooltip="一行一段。",
                ),
                # 可选外部文本口：接上就用上游文本，框内文字本轮忽略（前端会把框置灰）
                io.String.Input(
                    "提示词接入",
                    optional=True,
                    force_input=True,
                    tooltip="接上游文本（STRING）作为提示词。接上后忽略提示词框内容；未接时用框内文本。分批与风格、改写规则对两者一致。",
                ),
                io.Int.Input(
                    "起始索引", default=0, min=0, max=9999,
                    tooltip="从第几行开始取。",
                ),
                io.Int.Input(
                    "最大行数", default=1000, min=1, max=9999,
                    tooltip="最多取多少行。",
                ),
                io.Boolean.Input(
                    "去除空行", default=False,
                    tooltip="勾选后忽略所有换行，全部文本合并为一条提示词（适合一段提示词被换行拆开的写法）。",
                ),
                io.Clip.Input("clip_t2i", optional=True, tooltip="Qwen-Image-2.1-PE-T2I 文本编码器（文生图改写用）"),
                io.Clip.Input("clip_i2i", optional=True, tooltip="Qwen-Image-2.1-PE-I2I 文本编码器（图片编辑改写用）"),
                io.Boolean.Input(
                    "改写", default=True,
                    tooltip="局部编辑（改服装/动作等）建议开启——编辑模型只认 PE 产出的精确指令。行内含透明/抠图/去背景/PNG 等关键词时自动跳过改写（PE 会丢失透明要求）。",
                ),
                io.Float.Input(
                    "cfg_t2i", default=1.0, min=0.0, max=30.0, step=0.1,
                    tooltip="文生图模式下 cfg 输出口的推荐值，可接采样器 cfg。",
                ),
                io.Float.Input(
                    "cfg_i2i", default=3.0, min=0.0, max=30.0, step=0.1,
                    tooltip="图片编辑模式下 cfg 输出口的推荐值，可接采样器 cfg。",
                ),
                io.Int.Input(
                    "max_length",
                    optional=True,
                    default=None,
                    min=0,
                    max=65536,
                    tooltip="PE 生成的最大 token 数；0 或留空用默认 4096。同时决定 KV cache 容量（越大越慢）。",
                ),
                io.Boolean.Input(
                    "thinking",
                    optional=True,
                    default=True,
                    tooltip="启用官方 thinking 推理（先析出思考再取 JSON），质量更好但更慢。",
                ),
                io.Boolean.Input(
                    "do_sample", default=True,
                    tooltip="关闭后 PE 改写为贪心解码，一般保持开启。",
                ),
                io.Float.Input(
                    "temperature", default=1.0, min=0.01, max=2.0, step=0.000001,
                    tooltip="官方推荐 1.0。",
                ),
                io.Float.Input(
                    "top_p", default=0.95, min=0.0, max=1.0, step=0.01,
                    tooltip="官方推荐 0.95。",
                ),
                io.Int.Input(
                    "top_k", default=20, min=0, max=1000,
                    tooltip="官方推荐 20。",
                ),
                io.Int.Input(
                    "seed",
                    optional=True,
                    default=None,
                    min=0,
                    max=0xffffffffffffffff,
                    advanced=True,
                    tooltip="留空=每行随机；填写=各行用同一种子固定复现。",
                ),
            ],
            outputs=[
                io.Image.Output(id="图像1", display_name="图像1"),
                io.Image.Output(id="图像2", display_name="图像2"),
                io.Image.Output(id="图像3", display_name="图像3"),
                io.Image.Output(id="图像4", display_name="图像4"),
                io.Image.Output(id="图像5", display_name="图像5"),
                io.Image.Output(id="图像6", display_name="图像6"),
                io.String.Output(
                    id="提示词", display_name="提示词", is_output_list=True,
                    tooltip="每行一条（已套风格/改写），输出为列表；下游逐条执行实现批量生成。",
                ),
                io.Float.Output(
                    id="cfg", display_name="cfg",
                    tooltip="随模式自动切换的推荐 CFG 值：文生图用 cfg_t2i，图片编辑用 cfg_i2i。",
                ),
                io.Mask.Output(
                    id="重绘遮罩", display_name="重绘遮罩",
                    tooltip="局部编辑的羽化遮罩：裁剪重绘=裁剪区尺寸（接 Set Latent Noise Mask 限制重绘范围）；红罩模式=整图分辨率（同样可接噪声遮罩或预览）；未画遮罩时为空。",
                ),
                io.Custom("ARES_INPAINT_STITCH").Output(
                    id="缝合数据", display_name="缝合数据",
                    tooltip="接「Ares 局部缝合」节点，把采样结果缝回完整原图；未启用裁剪重绘时为空。",
                ),
                io.Image.Output(
                    id="原图1", display_name="原图1",
                    tooltip="图 1 加载时的原始完整图（未裁剪、未叠红罩）——接对比节点当基准图；未接图 1 时为空。",
                ),
            ],
            search_aliases=[
                "qwen prompt", "工作台", "装配", "风格提示词", "提示词增强", "图生图",
                "qwen workbench", "参考图",
            ],
        )

    @classmethod
    def fingerprint_inputs(cls, **kwargs):
        # 风格模板读自磁盘，不随输入值变化；文件一改就使执行缓存失效
        return all_styles_sig()

    @classmethod
    def execute(cls, **kwargs):
        g = kwargs.get
        style_file = resolve_lib(str(g("风格库", "none") or "none"))
        style_name = str(g("风格", "none") or "none")
        mode = str(g("模式", MODE_T2I) or MODE_T2I)
        if mode == "编辑":  # 旧工作流的模式名
            mode = MODE_EDIT
        if mode not in MODES:
            mode = MODE_T2I
        is_i2i = mode == MODE_EDIT

        media = _parse_media_json(g("图片数据", "[]"))
        if len(media) > MAX_OUT:
            log.warning("[AresQwenPE] 参考图 %d 张，只输出前 %d 张", len(media), MAX_OUT)
            media = media[:MAX_OUT]

        images = []
        first_mask = None
        for item in media:
            ftype = str(item.get("type") or "input")
            rel = item.get("image") or ""
            sub = str(item.get("subfolder") or "").replace("\\", "/").strip("/")
            if sub and sub + "/" not in str(rel).replace("\\", "/"):
                rel = f"{sub}/{os.path.basename(str(rel))}"
            p = _resolve_path(rel, ftype)
            if not p:
                log.warning("[AresQwenPE] 找不到图片: %s", rel)
                continue
            try:
                im = _load_image_tensor(p)
            except Exception as e:
                log.warning("[AresQwenPE] 读图失败 %s: %s", p, e)
                continue
            if not images:
                first_mask = _load_item_mask(item, int(im.shape[1]), int(im.shape[2]))
            images.append(im)
        n_img = len(images)

        # 遮罩只看第 1 张图：覆盖近全图或近空都按整图编辑，中间才叠红罩
        if any(str(m.get("mask") or "").strip() for m in media[1:]):
            log.warning("[AresQwenPE] 遮罩只对第 1 张参考图生效，其余参考图的遮罩已忽略")
        has_overlay = False
        crop = None  # (裁剪图, 裁剪遮罩, 缝合数据)
        orig_first = images[0] if images else None  # 任何修改前的图 1（对比基准）
        rect = parse_crop_rect(media[0].get("inpaintCrop")) if media else None
        hard = None
        if images:
            if first_mask is not None:
                hard = _prep_mask(first_mask, int(images[0].shape[1]), int(images[0].shape[2]))
            if rect is not None and (hard is None or float(hard.max()) <= 0.01):
                # 圈选即遮罩：画布框选了重绘范围且没有手画遮罩 → 矩形范围内=1、范围外=0
                H, W = int(images[0].shape[1]), int(images[0].shape[2])
                hard = _rect_mask(rect, H, W)
                log.info("[AresQwenPE] 圈选即遮罩：范围 %dx%d @ %d,%d（未画遮罩，框选范围整体重绘）", rect[2], rect[3], rect[0], rect[1])
            elif rect is not None and hard is not None:
                # 遮罩∩框选：手画遮罩限制在框选范围内
                H, W = int(images[0].shape[1]), int(images[0].shape[2])
                limited = hard * _rect_mask(rect, H, W)
                if float(limited.max()) > 0.01:
                    hard = limited
                    log.info("[AresQwenPE] 遮罩∩框选：遮罩已限制在重绘范围内")
                else:
                    log.warning("[AresQwenPE] 遮罩与框选范围不相交，按整幅遮罩处理")
            if hard is not None:
                m_ratio = float(hard.mean())
                if rect is not None and float(hard.max()) > 0.01:
                    # 画布框选了重绘范围：裁剪重绘——图像1 输出裁剪区，范围外像素由缝合保证不动
                    ictx = parse_crop_ctx(media[0].get("inpaintCrop")) if media else 1.2
                    feather = parse_crop_blend(media[0].get("inpaintCrop")) if media else 32
                    crop = prepare_crop(images[0], hard, blend_pixels=feather, ctx_factor=ictx)
                    if crop is None:
                        log.warning("[AresQwenPE] 重绘范围无效（遮罩为空），回退红罩标注")
                if crop is not None:
                    crop_img, crop_mask, _stitcher = crop
                    images[0] = crop_img  # 恒为干净裁剪图；视觉标注用 DrawMaskOnImage 挂在 TextEncode 支路上
                    log.info(
                        "[AresQwenPE] 裁剪重绘：遮罩外接框 x=%d y=%d %dx%d → 采样 %dx%d（上下文=×%.1f 羽化=%s）",
                        rect[0], rect[1], rect[2], rect[3],
                        crop_img.shape[2], crop_img.shape[1], ictx, feather,
                    )
                elif first_mask is not None and 0.001 < m_ratio < 0.85:
                    images[0] = _overlay_mask_red(images[0], hard)
                    has_overlay = True
                    log.info("[AresQwenPE] 局部编辑：遮罩覆盖 %.0f%%", m_ratio * 100.0)

        # 重绘遮罩输出口：裁剪模式=裁剪区羽化遮罩；红罩模式=整图分辨率羽化遮罩
        # （接 Set Latent Noise Mask / 预览都可用，不再输出 None）
        noise_out = None
        if crop is not None:
            noise_out = crop[1]
        elif hard is not None and float(hard.max()) > 0.01 and images:
            feather = parse_crop_blend(media[0].get("inpaintCrop")) if media else 32
            noise_out = feather_mask(hard, feather)

        # 外部接入优先：接了「提示词接入」就用上游文本（空串也算明确输入），
        # 未接（None）才回退框内文字。分批规则对两者一致。
        fed = g("提示词接入", None)
        text_src = fed if fed is not None else g("提示词文本", "")
        lines = _prompt_lines(
            text_src,
            g("起始索引", 0),
            g("最大行数", 1000),
            bool(g("去除空行", False)),
        )

        tmpl = ""
        pe_seed = False
        found = None
        if style_file != "none" and style_name != "none":
            found = find_style(style_file, style_name)
            if found:
                tmpl = str(found[0] or "")
                # 模板带 {pe} 标记 = 作为 PE 改写种子（模板出约束骨架，PE 做图像锚定改写）
                pe_seed = "{pe}" in tmpl
                tmpl = tmpl.replace("{pe}", "")
        has_style = bool(tmpl.strip())
        # 「无」等空模板是有意不套风格，只对真正缺失的风格提示
        if style_name != "none" and found is None:
            log.warning("[AresQwenPE] 风格「%s」不存在，未套用任何风格内容", style_name)
        # 编辑模式下风格分两形：描述型 → PE 融合改写；指令型（本身已是精确指令）→ 跳过 PE；
        # 带 {pe} 种子标记的指令型 → 仍交 PE 改写
        directive_form = bool(mode == MODE_EDIT and has_style
                              and not style_core_text(style_file, style_name) and not pe_seed)
        styled = []
        for raw in lines:
            pos, _neg = apply_style(raw, style_file, style_name)
            core = style_core_text(style_file, style_name) if (mode == MODE_EDIT and has_style) else ""
            if mode == MODE_EDIT and core:
                # 描述型风格 → 自动派生编辑形态：渲染风格（范围自动限定）+ 编辑要求
                text = _edit_prefix("", n_img) + (
                    f"渲染风格（仅作用于编辑要求涉及的范围，其余部分保持原图不变）：{core}。"
                    f"编辑要求：{raw.strip()}"
                )
            else:
                # 指令型模板（四视图/扩图/用户自写）→ 原有替换方式；
                # 模板自带保留条款，不注入范围限定（会与多视图/画布变换矛盾）
                text = pos or raw
                if mode == MODE_EDIT:
                    text = _edit_prefix(text, n_img)
            if has_overlay:
                text = f"{text.strip()}。{_MASK_TIP}" if text.strip() else _MASK_TIP
            elif crop is not None:
                text = f"{text.strip()}。{_CROP_TIP}" if text.strip() else _CROP_TIP
            styled.append(text)

        # —— PE 改写 ——
        clip_t2i = g("clip_t2i", None)
        clip_i2i = g("clip_i2i", None)
        clip = clip_i2i if is_i2i else clip_t2i
        unused = clip_t2i if is_i2i else clip_i2i
        if unused is not None and unused is not clip:
            p = unused.patcher
            if any(param.device != p.offload_device for param in p.model.parameters()):
                p.partially_unload(p.offload_device, 1e30)
        # 改写由用户按任务决定：局部编辑开 PE（模型只认 PE 产出的精确指令格式），
        # 透明背景等任务关 PE（改写会丢失透明要求）
        want_rewrite = bool(g("改写", True))
        if want_rewrite and clip is None:
            log.warning("[AresQwenPE] 未连接 PE 的 clip，提示词不改写、原样直出")
        if is_i2i and not images:
            log.warning("[AresQwenPE] I2I 模式未接任何参考图，改写结果可能不可用")

        if want_rewrite and clip is not None and directive_form:
            log.info("[AresQwenPE] 指令型风格（%s）跳过 PE 改写", style_name)
        if want_rewrite and clip is not None and not directive_form:
            rewritten = []
            pbar = comfy.utils.ProgressBar(len(styled))
            for li, line in enumerate(styled):
                raw_line = lines[li] if li < len(lines) else ""
                # 响应取消；单行失败回退原文，不拖垮整批
                comfy.model_management.throw_exception_if_processing_interrupted()
                hit = _NO_PE_RE.search(raw_line or "")
                if hit:
                    log.info("[AresQwenPE] 第 %d 行含透明背景关键词（%s），跳过 PE 改写",
                             li + 1, hit.group(0))
                    rewritten.append(line)
                    pbar.update(1)
                    continue
                try:
                    rewritten.append(pe_rewrite(
                        clip, line, images if is_i2i else None,
                        is_i2i=is_i2i, thinking=bool(g("thinking", True)),
                        do_sample=bool(g("do_sample", True)),
                        temperature=float(g("temperature", 1.0)),
                        top_p=float(g("top_p", 0.95)),
                        top_k=int(g("top_k", 20)),
                        seed=g("seed", None),
                        max_length=g("max_length", None),
                    ))
                except Exception as e:
                    log.warning("[AresQwenPE] 第 %d 行改写失败，回退原文: %s",
                                len(rewritten) + 1, str(e)[:90])
                    rewritten.append(line)
                pbar.update(1)
        else:
            rewritten = styled

        # 空口输出 None：TextEncodeQwenImage21 按 None 跳过，一一对应接线时
        # 多出来的口不影响执行
        outs = list(images) + [None] * (MAX_OUT - n_img)
        cfg = float(g("cfg_i2i", 3.0)) if is_i2i else float(g("cfg_t2i", 1.0))

        log.info(
            "[AresQwenPE] 模式=%s 图=%d 提示段=%d 文本=%s 改写=%s 风格=%s/%s 遮罩=%s",
            mode, n_img, len(rewritten), "接入" if fed is not None else "框内",
            "是" if want_rewrite and clip is not None else "否",
            style_file, style_name,
            "裁剪" if crop else ("红罩" if has_overlay else "无"),
        )
        # 提示词口是 is_output_list：按行输出列表，下游逐条执行实现批量
        return io.NodeOutput(
            *outs, rewritten, cfg,
            noise_out,                   # 重绘遮罩
            crop[2] if crop else None,   # 缝合数据
            orig_first,                  # 原图1（对比基准）
        )
