import os
from PIL import Image, ImageEnhance, ImageFilter, ImageDraw

MASTER_FACE_PATH = r"C:\Users\NISHANT\.gemini\antigravity-ide\brain\43f9f3c1-dba7-4d75-bc9c-e318c3d2085f\ultron_robot_face_1789283903352.jpg"
MASTER_OG_PATH = r"C:\Users\NISHANT\.gemini\antigravity-ide\brain\43f9f3c1-dba7-4d75-bc9c-e318c3d2085f\ultron_og_banner_1789283923319.jpg"

WORKSPACE_ROOT = r"c:\U.L.T.R.O.N.E"

def create_circular_mask(size):
    mask = Image.new("L", (size * 4, size * 4), 0)
    draw = ImageDraw.Draw(mask)
    padding = int(size * 4 * 0.04)
    draw.ellipse((padding, padding, size * 4 - padding, size * 4 - padding), fill=255)
    mask = mask.resize((size, size), Image.Resampling.LANCZOS)
    return mask

def make_launcher_icon(master_img, size, round_icon=False):
    canvas = Image.new("RGBA", (size, size), (5, 8, 15, 255))
    
    scale_factor = 0.82 if not round_icon else 0.80
    face_size = int(size * scale_factor)
    scaled_face = master_img.resize((face_size, face_size), Image.Resampling.LANCZOS)
    
    offset_x = (size - face_size) // 2
    offset_y = (size - face_size) // 2
    canvas.paste(scaled_face, (offset_x, offset_y))
    
    if round_icon:
        round_canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        mask = create_circular_mask(size)
        round_canvas.paste(canvas, (0, 0), mask=mask)
        
        draw = ImageDraw.Draw(round_canvas)
        padding = int(size * 0.04)
        draw.ellipse(
            (padding, padding, size - padding, size - padding),
            outline=(0, 240, 255, 60),
            width=max(1, int(size * 0.015))
        )
        return round_canvas
    else:
        round_rect_canvas = Image.new("RGBA", (size, size), (0, 0, 0, 0))
        mask = Image.new("L", (size * 4, size * 4), 0)
        draw_m = ImageDraw.Draw(mask)
        radius = int(size * 4 * 0.20)
        draw_m.rounded_rectangle((0, 0, size * 4, size * 4), radius=radius, fill=255)
        mask = mask.resize((size, size), Image.Resampling.LANCZOS)
        round_rect_canvas.paste(canvas, (0, 0), mask=mask)
        
        draw = ImageDraw.Draw(round_rect_canvas)
        draw.rounded_rectangle(
            (0, 0, size - 1, size - 1),
            radius=int(size * 0.20),
            outline=(20, 35, 55, 180),
            width=max(1, int(size * 0.012))
        )
        return round_rect_canvas

def make_favicon_ico(master_img, out_path):
    w, h = master_img.size
    crop_box = (int(w * 0.12), int(h * 0.06), int(w * 0.88), int(h * 0.90))
    cropped = master_img.crop(crop_box)
    
    enhancer = ImageEnhance.Contrast(cropped)
    contrast_img = enhancer.enhance(1.25)
    sharpener = ImageEnhance.Sharpness(contrast_img)
    sharp_img = sharpener.enhance(1.3)
    
    sizes = [(16, 16), (32, 32), (48, 48)]
    ico_frames = []
    for s in sizes:
        frame = Image.new("RGBA", s, (5, 8, 15, 255))
        resized = sharp_img.resize(s, Image.Resampling.LANCZOS)
        frame.paste(resized, (0, 0))
        ico_frames.append(frame)
    
    ico_frames[0].save(
        out_path,
        format="ICO",
        sizes=sizes,
        append_images=ico_frames[1:]
    )
    print(f"Saved favicon ICO to {out_path}")

def make_apple_icon(master_img, out_path):
    size = 180
    canvas = Image.new("RGBA", (size, size), (5, 8, 15, 255))
    face_size = int(size * 0.86)
    scaled = master_img.resize((face_size, face_size), Image.Resampling.LANCZOS)
    offset = (size - face_size) // 2
    canvas.paste(scaled, (offset, offset))
    
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, size - 1, size - 1), outline=(15, 25, 45, 200), width=1)
    canvas.save(out_path, format="PNG")
    print(f"Saved Apple icon to {out_path}")

def make_icon_png(master_img, out_path):
    size = 512
    canvas = Image.new("RGBA", (size, size), (5, 8, 15, 255))
    face_size = int(size * 0.88)
    scaled = master_img.resize((face_size, face_size), Image.Resampling.LANCZOS)
    offset = (size - face_size) // 2
    canvas.paste(scaled, (offset, offset))
    canvas.save(out_path, format="PNG")
    print(f"Saved 512x512 icon.png to {out_path}")

def make_og_image(master_og_img, out_path):
    target_w, target_h = 1200, 630
    w, h = master_og_img.size
    
    target_ratio = target_w / target_h
    current_ratio = w / h
    
    if current_ratio > target_ratio:
        new_w = int(h * target_ratio)
        offset_x = (w - new_w) // 2
        cropped = master_og_img.crop((offset_x, 0, offset_x + new_w, h))
    else:
        new_h = int(w / target_ratio)
        offset_y = (h - new_h) // 2
        cropped = master_og_img.crop((0, offset_y, w, offset_y + new_h))
        
    resized = cropped.resize((target_w, target_h), Image.Resampling.LANCZOS)
    resized.save(out_path, format="PNG")
    print(f"Saved OG Image to {out_path}")

def main():
    print("Loading master face image...")
    face_img = Image.open(MASTER_FACE_PATH).convert("RGBA")
    
    print("Loading master OG banner image...")
    og_img = Image.open(MASTER_OG_PATH).convert("RGBA")
    
    densities = {
        "mipmap-mdpi": 48,
        "mipmap-hdpi": 72,
        "mipmap-xhdpi": 96,
        "mipmap-xxhdpi": 144,
        "mipmap-xxxhdpi": 192,
    }
    
    res_dir = os.path.join(WORKSPACE_ROOT, "android", "app", "src", "main", "res")
    for folder, size in densities.items():
        dir_path = os.path.join(res_dir, folder)
        os.makedirs(dir_path, exist_ok=True)
        
        sq_icon = make_launcher_icon(face_img, size, round_icon=False)
        sq_path = os.path.join(dir_path, "ic_launcher.png")
        sq_icon.save(sq_path, format="PNG")
        
        rd_icon = make_launcher_icon(face_img, size, round_icon=True)
        rd_path = os.path.join(dir_path, "ic_launcher_round.png")
        rd_icon.save(rd_path, format="PNG")
        print(f"Generated {folder} ({size}x{size}): ic_launcher.png & ic_launcher_round.png")

    public_dir = os.path.join(WORKSPACE_ROOT, "public")
    app_dir = os.path.join(WORKSPACE_ROOT, "app")
    
    make_favicon_ico(face_img, os.path.join(public_dir, "favicon.ico"))
    make_favicon_ico(face_img, os.path.join(app_dir, "favicon.ico"))
    
    make_apple_icon(face_img, os.path.join(public_dir, "apple-icon.png"))
    make_apple_icon(face_img, os.path.join(app_dir, "apple-icon.png"))
    
    make_icon_png(face_img, os.path.join(public_dir, "icon.png"))
    
    make_og_image(og_img, os.path.join(public_dir, "og-image.png"))

if __name__ == "__main__":
    main()
