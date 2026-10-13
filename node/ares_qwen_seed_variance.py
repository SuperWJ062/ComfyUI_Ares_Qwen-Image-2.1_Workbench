"""同提示词下增加人物面部 / 构图多样性: 对文本嵌入注入结构化噪声.

Qwen-Image 系列经过 DPO 后训练, 同提示词换种子时面部等身份特征高度趋同
(官方论文 4.2.2 确认 DPO; musubi-tuner #804 讨论佐证). 本节点把条件拆成
两段: 加噪版在采样前段(sigma 百分比 0 ~ EARLY_RANGE)生效, 扰动身份与构图;
干净原条件接管后段, 保住细节与提示词对齐. 加噪不是每步衰减, 而是 ComfyUI
原生的 conditioning 分段调度, 无需模型回调.

单一"多样性"参数控制注入强度, "曲线"选项决定滑杆到强度的映射方式;
种子内部取自系统熵, 每次队列自动变化.
"""
import torch

import node_helpers

from comfy_api.latest import io

# 加噪条件占据的采样区间(sigma 百分比). 只在前段扰动: 少步数蒸馏模型里
# 这几步决定构图与身份, 后段再交给干净条件收敛细节.
EARLY_RANGE = 0.4
# 最大注入幅度, 相对每个 token 自身的 RMS. 多样性=1 时噪声约为信号的 1.6 倍
# (0.8 逐 token 份额 × 2.0): 1.0 附近会明显偏离提示词, 0.2~0.4 是日常区间.
MAX_SCALE = 2.0
# 预算分配: 逐 token 独立噪声是主力 (直接扰动 cross-attention 的 key),
# 共享方向分量只留两成 -- 整体平移会被模型内部的 RMSNorm 类归一化吸收掉.
TOKEN_SHARE = 0.8


# 多样性滑杆 -> 实际注入强度的映射曲线. 全部单调、0 映射到 0.
CURVES = {
    "线性": lambda d: d,                          # 直来直去, 所见即所得
    "S曲线": lambda d: d * d * (3.0 - 2.0 * d),   # smoothstep, 两端收敛, 中段过渡柔和
    "平方": lambda d: d * d,                      # 低档很轻, 高档陡增, 适合精修微调
    "γ曲线": lambda d: d ** 0.5,                  # gamma=0.5, 低档就有明显效果, 0.2 ≈ 线性 0.45
}


def _structured_noise(embeds: torch.Tensor, strength: float) -> torch.Tensor:
    """逐 token 独立高斯为主 + 一个共享方向, 按各 token 自身 RMS 定标.

    全局 std 会被 padding token 稀释, 也算不出有效 token 的真实幅度,
    所以这里逐 token 定标: 每个有效 token 都吃到等比于自身强度的扰动.
    """
    ref = embeds.detach().to("cpu", torch.float32)
    token_rms = ref.pow(2).mean(dim=-1, keepdim=True).sqrt().clamp_min(1e-6)
    gen = torch.Generator("cpu").manual_seed(torch.seed() & 0x7FFFFFFF)
    per_token = torch.randn(ref.shape, generator=gen)
    direction = torch.randn(ref.shape[-1], generator=gen)
    direction = direction / direction.norm().clamp_min(1e-6)
    noise = TOKEN_SHARE * per_token + (1.0 - TOKEN_SHARE) * direction
    return (noise * token_rms * MAX_SCALE * strength).to(device=embeds.device, dtype=embeds.dtype)


class AresQwenSeedVariance(io.ComfyNode):
    @classmethod
    def define_schema(cls) -> io.Schema:
        return io.Schema(
            node_id="AresQwenSeedVariance",
            display_name="Ares 多样性增强",
            category="✨Prompt Assistant",
            description="同提示词下增加人物面部/构图多样性。对文本嵌入注入结构化噪声(仅采样前段生效),缓解 Qwen 系列同提示词换种子人脸趋同的问题。",
            inputs=[
                io.Conditioning.Input("conditioning", tooltip="正向条件接进来,输出接到 KSampler 的 positive。"),
                io.Float.Input("diversity", default=0.5, min=0.0, max=1.0, step=0.05,
                               tooltip="多样性强度:0=不使用(原样输出),1=最大。噪声种子每次运行自动随机,重复出图即可得到不同人脸。"),
                io.Combo.Input("curve", options=list(CURVES), default="线性",
                               tooltip="多样性到实际注入强度的映射曲线。线性=所见即所得;S曲线=两端收敛、中段柔和;平方=低档极轻、高档陡增;γ曲线=gamma 0.5 开方,低档就有明显效果。"),
            ],
            outputs=[
                io.Conditioning.Output(display_name="conditioning"),
            ],
        )

    @classmethod
    def execute(cls, conditioning, diversity, curve) -> io.NodeOutput:
        if diversity <= 0.0:
            return io.NodeOutput(conditioning)
        strength = CURVES[curve](diversity)
        noisy = []
        for embeds, cond_dict in conditioning:
            noisy.append((embeds + _structured_noise(embeds, strength), cond_dict))
        result = node_helpers.conditioning_set_values(
            noisy, {"start_percent": 0.0, "end_percent": EARLY_RANGE}
        )
        result += node_helpers.conditioning_set_values(
            conditioning, {"start_percent": EARLY_RANGE, "end_percent": 1.0}
        )
        return io.NodeOutput(result)
