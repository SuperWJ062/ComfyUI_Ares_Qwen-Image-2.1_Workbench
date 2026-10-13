# Ares Qwen Workbench — All-in-One Assembly Nodes for Qwen-Image-2.1 (ComfyUI Custom Edition)

[简体中文](README.md) · **English**

![version](https://img.shields.io/badge/version-v1.0-71f6d2) ![comfyui](https://img.shields.io/badge/ComfyUI-custom--node-8de7ff) ![styles](https://img.shields.io/badge/style--library-3941%20entries-b79cff) ![license](https://img.shields.io/badge/license-MIT-8291aa)

**Current release v1.0** (2026-10-13)

One node handles the entire pre-generation assembly for Qwen-Image-2.1 — style templates, reference images (canvas editing / mask annotation / crop-and-redraw), line-based batch prompts, with optional per-line rewriting through PE (the Prompt-Enhance model) before output. Bundled with an interactive 3D Pose Studio for one-stop control-map generation.

## Screenshot

**Workbench** — style library / reference images / batch prompts assembled on one screen, 3941 styles with real output thumbnails

![Workbench](shots/workbench.png)

**Canvas editor** — multi-layer compositing / PS-style 8-direction handles / ratio presets / snap-to-32, layer documents saved per card

![Canvas editor](shots/canvas.png)

## Nodes

| Node | node id | Purpose |
|---|---|---|
| Ares Qwen Workbench | `AresQwenWorkbench` | Full-featured assembly desk (styles / reference images / masks / crop-and-redraw / batch) |
| Ares Text Enhance | `AresTextEnhance` | Pure PE rewrite: prompt in → rewritten_prompt + cfg out (legacy workflow compatible) |
| Ares Seed Variance | `AresQwenSeedVariance` | Injects structured noise into text embeddings to mitigate face convergence with identical prompts |
| Ares Inpaint Stitch | `AresInpaintStitch` | Stitches sampled results from the cropped region back into the original image with a feathered mask (pairs with Workbench crop-and-redraw) |
| Ares Pose Studio | `Ares_PoseStudio` (category `Ares/pose`) | Interactive 3D pose studio: body sliders, multi-pose tabs, animation timeline, SAM 3D image-to-pose, Mixamo FBX, pose library; outputs control maps (mesh / canny / soft_edge / lineart / depth / openpose) and camera prompts |

Workbench, Text Enhance, Seed Variance and Inpaint Stitch register via `comfy_entrypoint` (modern API); Pose Studio lives in `pose_studio/` + `web/pose_studio/`, adapted from ComfyUI_VNCCS_Utils and can coexist with the original plugin.

## Features

### Workbench Panel

```
Style lib  ← switch category (dropdown)
Mode       ← text-to-image / image editing
Rewrite    ← PE on/off
thinking   ← whether PE reasons before emitting JSON (better quality, slower)
seed       ← empty = random per line; filled = same seed per line for reproducibility
① Style  ② Reference images  ③ Prompts (workbench UI)
```

**Advanced parameters** (right-click node → Show Advanced):
`cfg_t2i` / `cfg_i2i` (recommended values for the cfg output), `do_sample` / `temperature` / `top_p` / `top_k` (PE sampling, official defaults), `max_length` (PE generation cap, default 4096).

### Outputs

| Output | Connects to |
|---|---|
| Image1~6 | `TextEncodeQwenImage21` image_1~6 |
| Prompts | Its prompt (PE-rewritten text, one entry per line, output as a list) |
| cfg | Sampler cfg (recommended value auto-switched by mode) |
| Redraw Mask | Feathered mask for local editing: crop-redraw = cropped-region size, red-overlay mode = full-image resolution (connect to Set Latent Noise Mask to limit the redraw area); empty when no mask is drawn |
| Stitch Data | Connects to the Ares Inpaint Stitch node to sample back into the full original; empty when crop-and-redraw is off |
| Original Image1 | The untouched original of image 1 (uncropped, no red overlay), for comparison nodes |

### Mode Behavior

**Text-to-image**: the style template is injected whole (full-image description); PE rewrites per the T2I protocol; rewriting can be disabled for raw passthrough.

**Image editing**: styles come in three shapes —

- **Descriptive** (appearance templates without `{prompt}`): derived into a "rendering style (scope auto-limited) + edit instructions" structure, fused and rewritten by PE;
- **Instructional** (operation templates containing `{prompt}`, e.g. four-view / pose change): constraint skeleton + prompt-box content substituted in place, output **directly** without PE;
- **`{pe}` seed** (instruction ending with the `{pe}` marker): assembled like instructional, but the whole thing goes to PE for image-anchored rewriting — the template guarantees constraint completeness while PE refines against the actual image, markedly better for fine tasks like face/head swapping.

**Automatic rules**: lines containing keywords such as transparent / cutout / remove background / PNG skip PE automatically (PE drops transparency requirements); reference image outputs are RGB / RGBA based on the source file.

### PE Rewrite Engine (official PE model, engineered further)

Built directly on the **official Qwen PE weights** (`qwen3.5_9b_qwen_image_2.1_pe` T2I / I2I) — no retraining, with a full set of engineering improvements on top:

- **Dual-weight auto swap**: only the T2I / I2I weight matching the current mode loads; the other moves back to memory automatically — saves VRAM, zero manual work on mode switch
- **Image-anchored rewriting (`{pe}` seed type)**: goes beyond pure text input — the I2I weight refines the rewrite against the actual reference images; the template guarantees constraint completeness while PE refines against the real picture, markedly better for fine tasks like face / head swaps
- **thinking toggle**: PE reasons before emitting JSON (better quality, slower); switch off for speed
- **Transparency guard**: lines containing keywords like transparent / cutout / remove background / PNG skip PE automatically — the official PE drops transparency requirements, this catches it
- **Failure fallback**: PE parse failures fall back to the original text instead of killing the queue
- **Plug-and-swap**: community Heretic (abliterated) versions share the same format — just swap the file

### Style Library

- 3941 styles in 12 categories: 3D / Anime / Cartoon / Experimental / Cover Art / Photography / Atmosphere / Comics / Sketch / Painting / Design / Other; browse by sub-category tags within each category, 120 cards per page + "show more";
- **Source**: the base set comes from Krea's public moodboard catalog (gallery page https://www.krea.ai/app?gallery=moodboards , single board format `krea.ai/moodboard-feed/<slug>`) — title-matched ~89.5% against the complete crawl (3549 entries) bundled with the ComfyUI-Krea-Moodboards plugin, adopting its de-duplication naming format ("title — style qualifier"); ~400 additional out-of-catalog supplements / custom entries. Processing form: keyword string + `Subject:{prompt}`, with Chinese names and local webp thumbnails;
- Search box: global library-wide search (Chinese/English names / prompt content / library name / sub-category name), multi-word and fuzzy matching supported;
- **Custom** (default library): 23 common editing templates — four-view / outpaint / pose change / text & clothing change / hair color change / expression change / background removal / cutout completion / background swap / object removal / watermark removal / watermark text removal / hi-res fix / style transfer / watermark addition / reference-based clothing swap / reference-based face swap / layer-blend face swap / **reference-based head swap** and more; hover a card for ✎ edit / ✕ delete, "+" to create (previews auto-converted to webp);
- **Favorites**: hover a style card and click ☆/★ in the top-left corner (favorited cards show a persistent gold star); the "★ Favorites" tag in the sub-category row lists all favorites across libraries (newest first, clicking a card switches to its library automatically). Favorites live in `ares_style_favorites.json` in the ComfyUI root — they follow ComfyUI, not the browser;
- Every style ships with a real output thumbnail (webp throughout).

### Reference Images

- Up to 6 images, referenced as `<image1~6>` in order; any size (downstream auto-aligns to multiples of 32), transparent PNGs keep RGBA untouched;
  - **6 is enough — no more needed**: thanks to the canvas editor's layer system, extra source material doesn't need extra cards — stack everything as layers into image 1's compositing canvas (multi-layer placement / 8-direction handles / layer documents saved per card), compose once, one slot holds it all;
- Cards can be drag-reordered (adjusting `<imageN>` numbering); hover for a large preview (transparency shown as checkerboard);
- ↩ restores the original (appears only after editing; history persists with the workflow);
- **Each card's canvas editor is independent** (hover ✎):
  - **Image 1** = compositing canvas: multi-layer placement, board expansion, multi-element composition; output writes back to image 1;
  - **Images 2~6** = edit that image itself: cutout / background erase / cropping and other pure reference pre-processing; output writes back to that card, never merged into image 1.

### Mask Annotation (card "Mask" button)

**Masks apply only to the first reference image.** Use them for edit targets that are hard to locate with words.

- Click **"Mask" / "Edit Mask"** below the image-1 card → opens ComfyUI's **native mask editor** (temporary node, workflow untouched); paint the area to modify, then save;
- On save the strokes are converted to a black-and-white mask PNG written back to the card, with a **red-overlay preview** + blue "Mask" badge on the thumbnail; **"Clear Mask"** removes it in one click;
- At run time the masked area is burned into image 1 as a semi-transparent red overlay for the model (soft blend, feathered edges); the prompt automatically gets a "modify only the masked area" scope note; when the mask covers nearly all or nearly none of the image, it degrades to full-image editing with no overlay;
- While participating in generation, the mask also outputs a **Redraw Mask** port (full-resolution feathered mask, connectable to Set Latent Noise Mask or preview);
- A resized board invalidates any existing mask — it is auto-cleared with a prompt to repaint;
- Compatible with any template / PE combination.

### Crop-and-Redraw (canvas selection of the redraw area)

Enabled when image 1 is framed with the **"Redraw Range" tool** in the canvas editor. The goal: cut sampling cost from full image to a local region, while stitching guarantees pixels outside the range stay bit-identical.

- **Selection is the mask**: inside = redraw, outside = untouched — no separate mask needed;
- **Mask ∩ selection**: when a mask is also drawn on the card, it is limited to the framed range — the frame picks the rough area, the mask finely limits what gets repainted inside (non-intersecting → treated as full-image mask with a warning);
- **Crop region = bounding square of the effective redraw area × context factor** (centered on the object, expand-only, aspect preserved); Image 1 outputs the **clean crop** (no annotations; downstream `TextEncodeQwenImage21` image_1 and VAE Encode both take it; to feed visual annotations to the TextEncode branch, hang a DrawMaskOnImage-like node on the image1→TextEncode line);
- **Sampling resolution adapts to object size**: crop square <512 upscaled to 512, >2048 downscaled to 2048, in-between kept as-is, aspect preserved, aligned to 32;
- The **Ares Inpaint Stitch** node restores VAE Decode results to crop size and blends them back with an expand + Gaussian-feathered mask — pixels outside the mask stay bit-identical; empty stitch data = passthrough (safe to keep permanently wired);
- **Stitch feather** (transition width, default 32px) and **context factor** (default ×1.2) are adjusted in the "Redraw Range" tool sidebar, saved per card with the selection;
- Both the redraw mask and the stitch mask carry feathering (mask expansion + Gaussian transition) for smooth seam-free edges; batch lines share the same crop and stitch data;
- Annotations are never rendered into exported images.

### Canvas Editor

Each card gets a canvas with an independent document (iframe + native canvas, not the main UI DOM). The iframe fully isolates drawing events from the ComfyUI main interface, so an 8192-class canvas never drops frames from host re-layout.

| Concept | Behavior |
|---|---|
| **Board** | Independent size (initial = image size), grow or shrink; aligned to multiples of 32 (64~8192); ratio presets (1:1 / 4:3 / 16:9 / 3:4 / 2:3 / 9:16, width fixed, height derived) or manual entry; eight-direction drag handles — drag any edge/corner and it follows, opposite side stays put |
| **View** | Wheel zoom (cursor-centered), middle-drag pan (left-drag + Space identical). **Changes the viewport only, never image data** |
| **Select** | **Click an image on the canvas to select it** (topmost when overlapping); click empty space to deselect |
| **Layers** | Drag inside the frame to move; PS-style 8-handle scaling (corners proportional / edges single-axis); **drag anywhere outside the image = rotate around center** (snaps near 15°, Shift disables); layer list supports show/hide / delete / drag-reorder |
| **Multi-select** | **Ctrl + left-drag rubber-band**; Ctrl+click to add / remove; when multi-selected the merged bounding box shows group handles — drag translates the whole group, handles scale / rotate it (relative positions preserved); a plain click collapses back to single selection |
| **Eraser** | Size 2~256px, edge feathering 0~100%, brush ring follows the cursor; erases only the selected layer's pixels |
| **Crop** | Frame a region of the current layer (outside dimmed), apply via double-click / Enter / button; rotation preserved, never crops beyond the image, one-step undo |
| **Redraw Range** | Image 1 canvas only: frame the crop range for local redraw (auto-aligned to 32) with a stitch-feather / context-factor sidebar, see "Crop-and-Redraw" |
| **Board Expansion** | "Expand to layers" grows the board to just fit all content; **new board area stays transparent** — run with the "Outpaint" or "Layer Blend" template for outpainting tasks |
| **Export** | Render PNG at the board's native size (transparent outside the board) → upload and write back to the current card |

**Layer memory**: edits persist per card as a "layer document" (board size + each layer's source / position / size / rotation / opacity / visibility + redraw range). Re-entering the same card **restores every layer exactly** — repeated edits never flatten into a single bitmap. Restoring the original (↩) or swapping the image after reorder voids the card's document.

### Face / Head Swap SOP

**Route 1: pure reference images (recommended)**

1. On the face/head source card (2nd or later), click ✎ to edit independently: cut out, erase background clutter; output writes back to that card;
2. Run directly with the "Reference Face Swap" or "Reference Head Swap" template (`{pe}`) — the face/head's position geometry, lighting and body all come from image 1, appearance from image 2.

**Route 2: canvas compositing**

1. Click ✎ on image 1 to enter the compositing canvas, "+ Add" the face source file, position and align (drag / 8 handles / off-image rotation), resize the board if needed;
2. Apply → the composite replaces image 1; run with the "Layer Blend" template (`{pe}`);
3. For a stronger spatial lock, add a mask on the image-1 card.

> Alignment accuracy: the original 2.1 model (50 steps, no distilled LoRA) edits are pixel-accurate; the 4-step distilled LoRA is faster but introduces geometric drift — disable LoRA for position-critical tasks.

### Batch

Prompts are one segment per line; `Start Index / Max Lines / Skip Empty Lines` selects which lines run this time; downstream executes per entry, one image per line; reference images are reused for every line.

## Installation (ComfyUI custom_nodes)

1. **Clone into ComfyUI's custom_nodes directory**
   ```
   cd ComfyUI/custom_nodes
   git clone https://github.com/SuperWJ062/ComfyUI_Ares_Qwen2.1_Workbench.git
   ```
2. **Install dependencies** (using ComfyUI's bundled Python):
   ```
   ComfyUI/python/python.exe -m pip install -r ComfyUI_Ares_Qwen2.1_Workbench/requirements.txt
   ```
3. **Restart ComfyUI**; all nodes appear under the `Ares` / `Ares/pose` categories.

## Model Download (PE rewrite weights)

Place the PE weights in `models/text_encoders/`, loaded via `CLIPLoader` (type=qwen_image):

| Purpose | File |
|---|---|
| T2I rewrite | `qwen3.5_9b_qwen_image_2.1_pe_t2i.int8_convrot.safetensors` |
| I2I rewrite | `qwen3.5_9b_qwen_image_2.1_pe_i2i.int8_convrot.safetensors` |

**Official download sources**

| Source | URL | Notes |
|---|---|---|
| Qwen official PE repos | https://huggingface.co/Qwen/Qwen-Image-2.1-PE-T2I · https://huggingface.co/Qwen/Qwen-Image-2.1-PE-I2I | Official original releases (origin of the files above) |
| Comfy-Org repackaged repo | https://huggingface.co/Comfy-Org/Qwen-Image-2.1 | `text_encoders/` folder — the int8_convrot files in the table come from here (9.47 GB each, SHA256 provided) |
| Base model | https://huggingface.co/Qwen/Qwen-Image-2.1 | Official base model |

> Mainland China: replace `huggingface.co` with `hf-mirror.com` in any URL for the mirror.

When both are connected, only the one matching the current mode loads; the other is automatically moved back to memory. The community also offers Heretic (abliteration-refusal-removed) versions with identical formats — directly swappable.

## Relationship to Source Projects

- **Crop-and-redraw stitching**: blending strategy adapted from [lquesada/ComfyUI-Inpaint-CropAndStitch](https://github.com/lquesada/ComfyUI-Inpaint-CropAndStitch), refined and adapted for this project (feathered stitching / context factor / 32-alignment)
- **Pose Studio**: partially adapted from [AHEKOT/ComfyUI_VNCCS_Utils](https://github.com/AHEKOT/ComfyUI_VNCCS_Utils), substantially refined and reworked for this project (control-map export / UI restructuring / depth rework), coexists with the original plugin
- **Style library**: based on Krea's public moodboard catalog, aligned with ComfyUI-Krea-Moodboards' catalog crawl and de-duplication naming
- Style / template JSON changes automatically invalidate the execution cache (the node fingerprint includes the style-file signature) — just re-run, no restart needed

## Directory Structure

```
node/ares_qwen_prompt_enhance.py   Workbench node
node/ares_text_enhance_node.py     "Ares Text Enhance" node (legacy workflow compatible)
node/ares_pe_engine.py             PE rewrite engine
node/ares_qwen21_styles.py         Style library reader (thumbnails unified to webp)
node/ares_qwen_seed_variance.py    Seed variance node
node/ares_inpaint_core.py          Crop-and-redraw core: cropping / feathered stitching
node/ares_inpaint_stitch.py        "Ares Inpaint Stitch" node
web/ares_qwen_prompt_enhance.js    Frontend UI (style grid / reference cards / parameter area)
web/ares_canvas_editor.js          Canvas editor host (iframe overlay shell + image upload normalization + cache busting)
web/ares_canvas_editor_v2.html     Canvas editor body (independent document + native canvas)
web/_tests/                        Canvas editor automated tests (node run_all.js, 76 items)
web/pose_studio/                   Pose Studio frontend (three.js)
pose_studio/                       Pose Studio backend (node shell / SAM 3D / pose library API)
styles/*.json                      Style library (12 categories + custom)
styles/samples/                    Style thumbnails (all webp)
requirements.txt                   Python dependencies (SAM 3D etc.)
```

## Updating

```
cd ComfyUI/custom_nodes/ComfyUI_Ares_Qwen2.1_Workbench
git pull
```

Restart ComfyUI to take effect; frontend-only changes under `web/` need just a page refresh (plugin responses already carry no-cache headers). Model weights and style favorites (`ares_style_favorites.json`) live outside the repo — updates never touch them.

## Example Workflow

[`example_workflows/Ares-Qwen2.1-全能版Turbo.json`](example_workflows/Ares-Qwen2.1-全能版Turbo.json) — full-feature assembly demo: style template + reference images + batch prompts + PE rewrite, wired straight into `TextEncodeQwenImage21`. Drag the JSON into ComfyUI to load (configured for fast Turbo distilled-LoRA output).

## Usage Notes

- Description text is always English; text to be rendered in the image keeps its own language.
- PE sampling: er_sde, simple, 25 steps.
- PE decode speed is bound by memory bandwidth (int8: 60 tokens/s on a 4090); disabling thinking gives a large speedup.
- Canvas page changes take effect by reopening the editor; main frontend / Python changes require a restart.

## Author & License

**Author**: [猫叔哥- (Uncle Cat)](https://space.bilibili.com/108196159) (GitHub: [SuperWJ062](https://github.com/SuperWJ062)) — workbench nodes, canvas editor, style library curation and all documentation.

**License**

| Component | License | Notes |
|---|---|---|
| This repository (workbench / canvas editor / style library curation / docs) | [MIT](LICENSE) | Free to use / modify / distribute |
| Pose Studio (from ComfyUI_VNCCS_Utils) | Upstream license | Renamed-isolated; check the upstream repo for commercial redistribution |
| Stitching logic (from ComfyUI-Inpaint-CropAndStitch) | Upstream license | Blending strategy ported; see its repo LICENSE |

**Model licenses** (model files are not in this repository; comply with their respective terms):
- Qwen-Image-2.1 base model — Qwen team
- PE rewrite weights / Heretic versions — per their respective release pages

## Acknowledgments

- [Qwen team](https://huggingface.co/Qwen) — Qwen-Image-2.1 and PE weights
- [lquesada/ComfyUI-Inpaint-CropAndStitch](https://github.com/lquesada/ComfyUI-Inpaint-CropAndStitch) — crop-and-redraw stitching approach
- [AHEKOT/ComfyUI_VNCCS_Utils](https://github.com/AHEKOT/ComfyUI_VNCCS_Utils) — Pose Studio prototype
- [Krea](https://www.krea.ai/) — public moodboard catalog (style library base)
- [ComfyUI](https://github.com/comfyanonymous/ComfyUI) — the platform this runs on
