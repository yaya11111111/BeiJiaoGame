import sys, os, json
from collections import deque
import numpy as np
from PIL import Image, ImageDraw, ImageOps

ann_path, color_path, outdir = sys.argv[1], sys.argv[2], sys.argv[3]
mode = sys.argv[4] if len(sys.argv) > 4 else 'preview'
os.makedirs(outdir, exist_ok=True)

ann = Image.open(ann_path).convert('RGB')
col = Image.open(color_path).convert('RGB')
aw, ah = ann.size
cw, ch = col.size
a = np.asarray(ann).astype(np.int16)
mx = a.max(axis=2); mn = a.min(axis=2)
dark = (mx < 115) & ((mx - mn) < 50)

def erode(m, it=1):
    m = m.copy()
    for _ in range(it):
        p = np.pad(m, 1, mode='edge')
        m = p[1:-1,1:-1] & p[:-2,1:-1] & p[2:,1:-1] & p[1:-1,:-2] & p[1:-1,2:]
    return m

def dilate(m, it=1):
    m = m.copy()
    for _ in range(it):
        p = np.pad(m, 1, mode='edge')
        m = p[1:-1,1:-1] | p[:-2,1:-1] | p[2:,1:-1] | p[1:-1,:-2] | p[1:-1,2:]
    return m

obstacle = dilate(erode(dark, 2), 3)
free = ~obstacle
centers = {
    'GUIDE': (0.440, 0.930), 'L01': (0.3991, 0.786), 'L02': (0.411, 0.577),
    'L03': (0.3996, 0.4298), 'L04': (0.6418, 0.4339), 'L05': (0.6384, 0.8917),
    'L06': (0.8069, 0.6868), 'L07': (0.5647, 0.281), 'L08': (0.1727, 0.2033),
    'L09': (0.0652, 0.4934), 'L10': (0.3007, 0.7124),
}

visited = np.zeros((ah, aw), dtype=bool)
regions = {}
for level, (px, py) in centers.items():
    x, y = int(px * aw), int(py * ah)
    if not free[y, x]:
        for rad in range(1, 40):
            done = False
            for dy in range(-rad, rad + 1):
                for dx in range(-rad, rad + 1):
                    ny, nx = y + dy, x + dx
                    if 0 <= ny < ah and 0 <= nx < aw and free[ny, nx]:
                        y, x = ny, nx; done = True; break
                if done: break
            if done: break
    if visited[y, x]:
        print('warning: level', level, 'fell into an already filled region')
        continue
    q = deque([(y, x)])
    visited[y, x] = True
    mask = np.zeros((ah, aw), dtype=bool)
    miny = maxy = y; minx = maxx = x
    while q:
        cy, cx = q.popleft()
        mask[cy, cx] = True
        if cy < miny: miny = cy
        if cy > maxy: maxy = cy
        if cx < minx: minx = cx
        if cx > maxx: maxx = cx
        for dy, dx in ((1,0),(-1,0),(0,1),(0,-1)):
            ny, nx = cy + dy, cx + dx
            if 0 <= ny < ah and 0 <= nx < aw and free[ny, nx] and not visited[ny, nx]:
                visited[ny, nx] = True
                q.append((ny, nx))
    # 补丁向外膨胀 2px，压住黑色分区线，避免区域之间出现白色细缝
    mask = dilate(mask, 2)
    if level == 'GUIDE':
        # 第 0 关区域补到城门底部，否则城门本体仍是灰的
        gx0, gx1 = int(0.34 * aw), int(0.55 * aw)
        gy0 = int(0.90 * ah)
        mask[gy0:ah, gx0:gx1] = True
    ys, xs = np.nonzero(mask)
    regions[level] = {
        'mask': mask,
        'bbox': (int(xs.min()), int(ys.min()), int(xs.max()), int(ys.max())),
    }

sx = cw / aw
sy = ch / ah

if mode == 'preview':
    base = np.asarray(ImageOps.grayscale(col).convert('RGB')).astype(np.uint8)
    base = (base * 0.94).clip(0, 255).astype(np.uint8)
    # light paper tint
    base = np.stack([base[...,0]*0.99, base[...,1]*0.985, base[...,2]*0.96], axis=-1).clip(0,255).astype(np.uint8)
    comp = base.copy()
    shown = ['GUIDE', 'L01', 'L02', 'L03']
    for level in shown:
        r = regions[level]
        x0, y0, x1, y1 = r['bbox']
        bx0, by0 = int(round(x0 * sx)), int(round(y0 * sy))
        bx1, by1 = int(round((x1 + 1) * sx)), int(round((y1 + 1) * sy))
        m = Image.fromarray((r['mask'] * 255).astype(np.uint8), 'L').resize((cw, ch), Image.NEAREST)
        m = np.asarray(m) > 128
        sub = comp[by0:by1, bx0:bx1]
        msub = m[by0:by1, bx0:bx1]
        sub[msub] = np.asarray(col)[by0:by1, bx0:bx1][msub]
    Image.fromarray(comp).resize((cw * 2, ch * 2), Image.LANCZOS).save(os.path.join(outdir, 'preview_comp.png'))
    print('preview saved', os.path.join(outdir, 'preview_comp.png'))
else:
    gray = ImageOps.grayscale(col).convert('RGB')
    arr = np.asarray(gray).astype(np.float32)
    arr = np.stack([arr[...,0]*0.99, arr[...,1]*0.985, arr[...,2]*0.96], axis=-1)
    arr = (arr * 0.95).clip(0, 255).astype(np.uint8)
    Image.fromarray(arr).save(os.path.join(outdir, 'campus-map-gray.png'))
    meta = {}
    for level in centers:
        r = regions[level]
        if not r: continue
        x0, y0, x1, y1 = r['bbox']
        bx0, by0 = int(round(x0 * sx)), int(round(y0 * sy))
        bx1, by1 = int(round((x1 + 1) * sx)), int(round((y1 + 1) * sy))
        m = Image.fromarray((r['mask'] * 255).astype(np.uint8), 'L').resize((cw, ch), Image.NEAREST)
        m = np.asarray(m)
        msub = m[by0:by1, bx0:bx1] > 128
        patch = np.asarray(col)[by0:by1, bx0:bx1].copy()
        rgba = np.dstack([patch, (msub * 255).astype(np.uint8)])
        name = 'campus-region-' + level.lower() + '.png'
        Image.fromarray(rgba, 'RGBA').save(os.path.join(outdir, name))
        meta[level] = {
            'file': name,
            'pixel': [bx0, by0, bx1 - bx0, by1 - by0],
            'rect': [round(bx0 / cw, 5), round(by0 / ch, 5), round((bx1 - bx0) / cw, 5), round((by1 - by0) / ch, 5)],
        }
    with open(os.path.join(outdir, 'regions.json'), 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
    print(json.dumps(meta, ensure_ascii=False, indent=2))
