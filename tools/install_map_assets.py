import sys, os, json, uuid, shutil
from PIL import Image

src_dir, dst_dir = sys.argv[1], sys.argv[2]
os.makedirs(dst_dir, exist_ok=True)

files = ['campus-map-gray.png'] + [f'campus-region-{name}.png' for name in
    ['guide', 'l01', 'l02', 'l03', 'l04', 'l05', 'l06', 'l07', 'l08', 'l09', 'l10']]

for name in files:
    src = os.path.join(src_dir, name)
    dst = os.path.join(dst_dir, name)
    shutil.copyfile(src, dst)
    w, h = Image.open(dst).size
    uid = str(uuid.uuid4())
    has_alpha = name != 'campus-map-gray.png'
    meta = {
        "ver": "1.0.27",
        "importer": "image",
        "imported": True,
        "uuid": uid,
        "files": [".png", ".json"],
        "subMetas": {
            "6c48a": {
                "importer": "texture",
                "uuid": uid + "@6c48a",
                "displayName": os.path.splitext(name)[0],
                "id": "6c48a",
                "name": "texture",
                "userData": {
                    "wrapModeS": "clamp-to-edge",
                    "wrapModeT": "clamp-to-edge",
                    "imageUuidOrDatabaseUri": uid,
                    "isUuid": True,
                    "visible": False,
                    "minfilter": "linear",
                    "magfilter": "linear",
                    "mipfilter": "none",
                    "anisotropy": 0,
                },
                "ver": "1.0.22",
                "imported": True,
                "files": [".json"],
                "subMetas": {},
            },
            "f9941": {
                "importer": "sprite-frame",
                "uuid": uid + "@f9941",
                "displayName": os.path.splitext(name)[0],
                "id": "f9941",
                "name": "spriteFrame",
                "userData": {
                    "trimThreshold": 0,
                    "rotated": False,
                    "offsetX": 0,
                    "offsetY": 0,
                    "trimX": 0,
                    "trimY": 0,
                    "width": w,
                    "height": h,
                    "rawWidth": w,
                    "rawHeight": h,
                    "borderTop": 0,
                    "borderBottom": 0,
                    "borderLeft": 0,
                    "borderRight": 0,
                    "packable": False,
                    "pixelsToUnit": 100,
                    "pivotX": 0.5,
                    "pivotY": 0.5,
                    "meshType": 0,
                    "vertices": {
                        "rawPosition": [-w / 2, -h / 2, 0, w / 2, -h / 2, 0, -w / 2, h / 2, 0, w / 2, h / 2, 0],
                        "indexes": [0, 1, 2, 2, 1, 3],
                        "uv": [0, h, w, h, 0, 0, w, 0],
                        "nuv": [0, 0, 1, 0, 0, 1, 1, 1],
                        "minPos": [-w / 2, -h / 2, 0],
                        "maxPos": [w / 2, h / 2, 0],
                    },
                    "isUuid": True,
                    "imageUuidOrDatabaseUri": uid + "@6c48a",
                    "atlasUuid": "",
                    "trimType": "none",
                },
                "ver": "1.0.12",
                "imported": True,
                "files": [".json"],
                "subMetas": {},
            },
        },
        "userData": {
            "type": "sprite-frame",
            "fixAlphaTransparencyArtifacts": False,
            "hasAlpha": has_alpha,
            "redirect": uid + "@6c48a",
        },
    }
    with open(dst + '.meta', 'w', encoding='utf-8', newline='\n') as f:
        json.dump(meta, f, ensure_ascii=False, indent=2)
        f.write('\n')
    print('installed', name, w, h)
