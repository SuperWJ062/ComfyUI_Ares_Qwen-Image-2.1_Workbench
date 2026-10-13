"""局部重绘：裁剪与缝合核心（工作台「裁剪重绘」与「Ares 局部缝合」共用）。

缝合混合逻辑移植自 ComfyUI-Inpaint-CropAndStitch 的 Inpaint Stitch（改进版）：
采样图还原到画布裁剪区尺寸，用「扩边 + 高斯羽化」的缝合掩膜与原图 alpha 混合，
掩膜外像素保持原样。
"""

import math

import numpy as np
import torch
from PIL import Image
from scipy.ndimage import binary_closing, binary_fill_holes, gaussian_filter, grey_dilation

ALIGN = 16  # 裁剪区对齐粒度（Qwen VAE 8 倍下采样 × patch 2）

# 采样分辨率自适应（包裹物体所需像素范围）：方形化后的裁剪区边长
# 小于 SAMPLE_MIN 放大到 SAMPLE_MIN（小物体给模型足够画布，如草莓→512），
# 大于 SAMPLE_MAX 等比缩到 SAMPLE_MAX（大物体保留原生细节并保护显存），
# 中间原尺寸。全程等比，比例不变。
SAMPLE_MIN = 512
SAMPLE_MAX = 2048


_PIL_FILTERS = {
    "nearest": Image.Resampling.NEAREST,
    "bilinear": Image.Resampling.BILINEAR,
    "bicubic": Image.Resampling.BICUBIC,
    "lanczos": Image.Resampling.LANCZOS,
}


def _resize_image(image: torch.Tensor, w: int, h: int, algorithm: str = "lanczos") -> torch.Tensor:
    """[B,H,W,C] float 0-1 → PIL 缩放 → [B,h,w,C]。"""
    out = []
    for i in range(image.shape[0]):
        arr = (image[i].clamp(0, 1).cpu().numpy() * 255.0).round().astype(np.uint8)
        im = Image.fromarray(arr).resize((w, h), _PIL_FILTERS.get(algorithm, Image.Resampling.LANCZOS))
        out.append(torch.from_numpy(np.array(im).astype(np.float32) / 255.0))
    return torch.stack(out, dim=0)


def _resize_mask(mask: torch.Tensor, w: int, h: int) -> torch.Tensor:
    """[B,H,W] → [B,h,w]，双线性。"""
    return torch.nn.functional.interpolate(
        mask.unsqueeze(1).float(), size=(h, w), mode="bilinear", align_corners=False
    ).squeeze(1).clamp(0, 1)


def _expand_mask(mask: torch.Tensor, pixels: int) -> torch.Tensor:
    """方形 footprint 膨胀（sigma=pixels/4，kernel=ceil(sigma*1.5+1)，同参考实现）。"""
    if pixels <= 0:
        return mask
    k = int(math.ceil((pixels / 4) * 1.5 + 1))
    foot = np.ones((k, k), dtype=np.uint8)
    out = []
    for i in range(mask.shape[0]):
        d = grey_dilation(mask[i].float().cpu().numpy(), footprint=foot, mode="reflect")
        out.append(torch.from_numpy(d.astype(np.float32)).clamp(0, 1))
    return torch.stack(out, dim=0)


def _blur_mask(mask: torch.Tensor, pixels: float) -> torch.Tensor:
    if pixels <= 0:
        return mask
    sigma = pixels / 4
    out = []
    for i in range(mask.shape[0]):
        b = gaussian_filter(mask[i].float().cpu().numpy(), sigma=sigma, mode="reflect")
        out.append(torch.from_numpy(b).float().clamp(0, 1))
    return torch.stack(out, dim=0)


def parse_crop_rect(raw):
    """画布带回的重绘范围 {x,y,w,h} → (x,y,w,h)；缺字段或过小返回 None。"""
    if not isinstance(raw, dict):
        return None
    try:
        x = int(float(raw.get("x")))
        y = int(float(raw.get("y")))
        w = int(float(raw.get("w")))
        h = int(float(raw.get("h")))
    except (TypeError, ValueError):
        return None
    if w < 16 or h < 16:
        return None
    return (x, y, w, h)


def parse_crop_blend(raw, default: int = 32) -> int:
    """画布带回的缝合羽化（blend，像素）；缺省或非法用 default。"""
    if isinstance(raw, dict):
        try:
            v = int(float(raw.get("blend")))
        except (TypeError, ValueError):
            return default
        return max(0, min(256, v))
    return default


def parse_crop_ctx(raw, default: float = 1.2) -> float:
    """画布带回的上下文系数（ctx）：裁剪方形 = 物体方形边界 × ctx。"""
    if isinstance(raw, dict):
        try:
            v = float(raw.get("ctx"))
        except (TypeError, ValueError):
            return default
        if v == v:  # 滤掉 NaN
            return max(1.0, min(4.0, v))
    return default


def parse_crop_mark(raw, default: bool = True) -> bool:
    """画布带回的「标注给模型」开关：把遮罩画进采样图帮模型定位（原工作流的遮挡开关）。"""
    if isinstance(raw, dict) and raw.get("mark") is not None:
        return bool(raw.get("mark"))
    return default


def hipass_mask(mask: torch.Tensor, threshold: float) -> torch.Tensor:
    """滤除低于阈值的遮罩浮点（同参考实现 hipassfilter_m）。"""
    m = mask.clone()
    m[m < threshold] = 0
    return m


def fillholes_mask(mask: torch.Tensor) -> torch.Tensor:
    """多阈值迭代闭运算+填洞（阈值阶梯同参考实现 fillholes_iterative_hipass_fill_m）。"""
    thresholds = [1, 0.99, 0.97, 0.95, 0.93, 0.9, 0.8, 0.7, 0.6, 0.5, 0.4, 0.3, 0.2, 0.1]
    out = []
    for i in range(mask.shape[0]):
        m = mask[i].float().cpu().numpy()
        for t in thresholds:
            closed = binary_closing(m >= t, structure=np.ones((3, 3)), border_value=1)
            filled = binary_fill_holes(closed)
            m = np.maximum(m, np.where(filled, t, 0))
        out.append(torch.from_numpy(m.astype(np.float32)))
    return torch.stack(out, dim=0)


def feather_mask(mask: torch.Tensor, pixels: int) -> torch.Tensor:
    """遮罩外扩 pixels + 高斯羽化 pixels/2（噪声口与缝合掩膜共用的羽化处理）。"""
    bp = max(0, int(pixels or 0))
    m = _expand_mask(mask, bp) if bp > 0 else mask
    return _blur_mask(m, bp * 0.5)


def prepare_crop(image: torch.Tensor, hard_mask: torch.Tensor, blend_pixels: int = 32,
                 ctx_factor: float = 1.2, fill_holes: bool = True, hipass: float = 0.0):
    """按遮罩裁剪图 1（圈选/笔刷遮罩即重绘范围）。

    image [1,H,W,C]；hard_mask [1,H,W]（0/1）。
    - 遮罩预处理：hipass 滤除低值浮点、多阈值填洞（同参考实现默认行为）；
    - 裁剪区 = 遮罩外接框的正方形边界 × 上下文系数（绕遮罩中心、收进画布、
      至少容纳缝合羽化带）——先包裹物体和上下文，比例不变；
    - 采样分辨率自适应：方形边长 clamp(SAMPLE_MIN, SAMPLE_MAX) 后对齐 32
      （小物体放大给模型足够画布，大物体保留原生细节）。
    返回 (裁剪图, 裁剪遮罩, 缝合数据)；遮罩为空返回 None。
    """
    H, W = int(image.shape[1]), int(image.shape[2])
    bp = max(0, int(blend_pixels or 0))

    if hipass > 0:
        hard_mask = hipass_mask(hard_mask, hipass)
    if fill_holes:
        hard_mask = fillholes_mask(hard_mask)

    m = hard_mask[0] > 0.02
    if not bool(m.any()):
        return None
    ys, xs = torch.nonzero(m, as_tuple=True)
    bx0, bx1 = int(xs.min()), int(xs.max()) + 1
    by0, by1 = int(ys.min()), int(ys.max()) + 1
    obj_side = max(bx1 - bx0, by1 - by0)  # 物体的正方形边界

    # 裁剪方形 = 物体方形边界 × 上下文系数（至少包住羽化带），绕物体中心收进画布
    side = max(int(obj_side * max(1.0, ctx_factor)), obj_side + 2 * bp + ALIGN)
    side = min(side, W, H)
    ncx, ncy = (bx0 + bx1) // 2, (by0 + by1) // 2
    nx0 = max(0, min(ncx - side // 2, W - side))
    ny0 = max(0, min(ncy - side // 2, H - side))
    x0e, y0e = nx0, ny0
    cw = ch = side

    # 噪声遮罩 = 遮罩外扩 bp + 高斯羽化 bp/2（同参考实现：cropped_mask 也是羽化过的，
    # 重绘边缘在采样阶段就平滑过渡）；缝合掩膜在此基础上再羽化 bp/2
    noise_full = feather_mask(hard_mask, bp)
    hard_crop = noise_full[:, y0e:y0e + cw, x0e:x0e + cw]
    crop_img = image[:, y0e:y0e + cw, x0e:x0e + cw, :]

    # 采样分辨率自适应（包裹物体所需的像素范围）：小物体放大到 SAMPLE_MIN
    # 给模型足够画布，大物体保留原生分辨率，超过 SAMPLE_MAX 等比缩小保护显存
    sample = min(max(side, SAMPLE_MIN), SAMPLE_MAX)
    sample = -(-sample // 32) * 32  # 对齐 32（VAE 8x × patch 2）
    tw = th = sample
    if (tw, th) != (cw, ch):
        crop_img = _resize_image(crop_img, tw, th)
        hard_crop = _resize_mask(hard_crop, tw, th)
    blend_crop = _blur_mask(hard_crop, bp * 0.5)

    stitcher = {
        "canvas_image": image[:1].clone(),
        "rect": [int(x0e), int(y0e), int(cw), int(ch)],
        "blend_mask": blend_crop.clone(),
        "blend_pixels": bp,
        "sample_size": [int(tw), int(th)],
    }
    return crop_img, hard_crop, stitcher


def stitch(stitcher: dict, inpainted: torch.Tensor) -> torch.Tensor:
    """把采样结果缝回原图。inpainted [B,th,tw,C]（VAE 解码输出）→ [B,H,W,C]。

    缝合掩膜外像素与原图逐位一致；批输入逐张复用同一份缝合数据。
    """
    canvas = stitcher["canvas_image"]
    x, y, cw, ch = (int(v) for v in stitcher["rect"])
    blend = stitcher["blend_mask"].to(device=inpainted.device, dtype=inpainted.dtype)
    if inpainted.ndim == 5:  # 批维误叠两层（[B,1,H,W,C]）时压平
        inpainted = inpainted.reshape(-1, *inpainted.shape[-3:])
    outs = []
    for i in range(inpainted.shape[0]):
        im = inpainted[i:i + 1].to(device=canvas.device, dtype=canvas.dtype)
        if im.shape[1] != blend.shape[1] or im.shape[2] != blend.shape[2]:
            im = _resize_image(im, blend.shape[2], blend.shape[1])
        im = _resize_image(im, cw, ch)
        bm = _resize_mask(blend, cw, ch).unsqueeze(-1)
        # 通道对齐：RGBA 画布保留自身 alpha，只混 RGB
        if canvas.shape[-1] == 4 and im.shape[-1] == 3:
            im = torch.cat([im, canvas[:, y:y + ch, x:x + cw, 3:4]], dim=-1)
        elif canvas.shape[-1] == 3 and im.shape[-1] == 4:
            im = im[..., :3]
        region = canvas[:, y:y + ch, x:x + cw, :]
        out = canvas.clone()
        out[:, y:y + ch, x:x + cw, :] = bm * im + (1.0 - bm) * region
        outs.append(out)
    return torch.cat(outs, dim=0)
