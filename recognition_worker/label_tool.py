"""
GUI для ручной разметки кропов из extract_faces.py.

Один видеоролик почти всегда один человек — поэтому разметка идёт ПО ПАПКАМ
(одна папка = один video), а не по отдельным фото: показывает превью всех
кропов папки разом, по клику на кнопку с именем — все фото из папки переезжают
в dataset/<label>/. "Пропустить" — папка не используется вообще (например
видно несколько разных людей, или качество не внушает доверия).

Usage:
    python label_tool.py
"""
import shutil
from pathlib import Path
import tkinter as tk
from PIL import Image, ImageTk

SRC = Path("extracted_faces")
DST = Path("dataset")
LABELS = ["andrey", "liliya", "kamelia", "grisha"]

for label in LABELS:
    (DST / label).mkdir(parents=True, exist_ok=True)


class LabelApp:
    def __init__(self, root):
        self.root = root
        self.folders = sorted(p for p in SRC.iterdir() if p.is_dir())
        self.idx = 0
        self.thumb_refs = []

        # Режим "разное": внутри текущей папки размечаем по одному фото,
        # а не всю папку разом — для случаев, когда в одном видео мелькнуло
        # несколько разных людей.
        self.mixed_mode = False
        self.mixed_images = []
        self.mixed_pos = 0

        self.title_var = tk.StringVar()
        tk.Label(root, textvariable=self.title_var, font=("Segoe UI", 13, "bold")).pack(pady=8)

        self.frame_thumbs = tk.Frame(root)
        self.frame_thumbs.pack(padx=10, pady=10)

        btns = tk.Frame(root)
        btns.pack(pady=10)
        for i, label in enumerate(LABELS, 1):
            b = tk.Button(
                btns, text=f"{label}  ({i})", width=14, height=2,
                font=("Segoe UI", 11), command=lambda l=label: self.assign(l)
            )
            b.pack(side=tk.LEFT, padx=5)
            root.bind(str(i), lambda e, l=label: self.assign(l))

        skip_btn = tk.Button(
            btns, text="Пропустить (0)", width=14, height=2, bg="#dddddd",
            font=("Segoe UI", 11), command=self.skip
        )
        skip_btn.pack(side=tk.LEFT, padx=5)
        root.bind("0", lambda e: self.skip())

        self.mixed_btn = tk.Button(
            btns, text="Разное — по одному (m)", width=18, height=2, bg="#ffd8a8",
            font=("Segoe UI", 11), command=self.enter_mixed_mode
        )
        self.mixed_btn.pack(side=tk.LEFT, padx=5)
        root.bind("m", lambda e: self.enter_mixed_mode())

        self.status_var = tk.StringVar()
        tk.Label(root, textvariable=self.status_var, font=("Segoe UI", 10)).pack(pady=6)

        self.show_current()

    def show_current(self):
        for w in self.frame_thumbs.winfo_children():
            w.destroy()
        self.thumb_refs.clear()

        if self.mixed_mode:
            self._show_mixed()
            return

        if self.idx >= len(self.folders):
            self.title_var.set("Готово! Все папки размечены.")
            self.status_var.set(self._summary())
            self.mixed_btn.config(state=tk.DISABLED)
            return

        self.mixed_btn.config(state=tk.NORMAL)
        folder = self.folders[self.idx]
        images = sorted(folder.glob("*.jpg"))
        self.title_var.set(f"[{self.idx + 1}/{len(self.folders)}] {folder.name}  —  {len(images)} фото")

        for i, img_path in enumerate(images[:12]):
            img = Image.open(img_path)
            img.thumbnail((150, 150))
            tkimg = ImageTk.PhotoImage(img)
            self.thumb_refs.append(tkimg)
            tk.Label(self.frame_thumbs, image=tkimg, borderwidth=1, relief="solid").grid(
                row=i // 6, column=i % 6, padx=4, pady=4
            )

        self.status_var.set(f"Осталось папок: {len(self.folders) - self.idx}   |   {self._summary()}")

    def _show_mixed(self):
        self.mixed_btn.config(state=tk.DISABLED)
        if self.mixed_pos >= len(self.mixed_images):
            # Папка разобрана по одному — идём дальше к следующей папке.
            self.mixed_mode = False
            self.idx += 1
            self.show_current()
            return

        img_path = self.mixed_images[self.mixed_pos]
        folder = self.folders[self.idx]
        self.title_var.set(
            f"[{self.idx + 1}/{len(self.folders)}] {folder.name} — РАЗНОЕ, фото {self.mixed_pos + 1}/{len(self.mixed_images)}"
        )
        img = Image.open(img_path)
        img.thumbnail((320, 320))
        tkimg = ImageTk.PhotoImage(img)
        self.thumb_refs.append(tkimg)
        tk.Label(self.frame_thumbs, image=tkimg, borderwidth=1, relief="solid").pack()
        self.status_var.set(f"Осталось папок: {len(self.folders) - self.idx}   |   {self._summary()}")

    def _summary(self):
        counts = {label: len(list((DST / label).glob("*.jpg"))) for label in LABELS}
        return " | ".join(f"{label}: {n}" for label, n in counts.items())

    def enter_mixed_mode(self):
        if self.idx >= len(self.folders) or self.mixed_mode:
            return
        folder = self.folders[self.idx]
        self.mixed_images = sorted(folder.glob("*.jpg"))
        self.mixed_pos = 0
        self.mixed_mode = True
        self.show_current()

    def assign(self, label):
        if self.mixed_mode:
            if self.mixed_pos >= len(self.mixed_images):
                return
            img_path = self.mixed_images[self.mixed_pos]
            folder = self.folders[self.idx]
            dst_dir = DST / label
            new_name = f"{folder.name}_{img_path.name}"
            shutil.move(str(img_path), str(dst_dir / new_name))
            self.mixed_pos += 1
            self.show_current()
            return

        if self.idx >= len(self.folders):
            return
        folder = self.folders[self.idx]
        dst_dir = DST / label
        for img_path in folder.glob("*.jpg"):
            new_name = f"{folder.name}_{img_path.name}"
            shutil.move(str(img_path), str(dst_dir / new_name))
        self.idx += 1
        self.show_current()

    def skip(self):
        if self.mixed_mode:
            if self.mixed_pos >= len(self.mixed_images):
                return
            self.mixed_pos += 1
            self.show_current()
            return

        if self.idx >= len(self.folders):
            return
        self.idx += 1
        self.show_current()


if __name__ == "__main__":
    root = tk.Tk()
    root.title("Разметка лиц — recognition_worker")
    root.geometry("980x650")
    app = LabelApp(root)
    root.mainloop()

    print("\nИтоговая разметка:")
    for label in LABELS:
        n = len(list((DST / label).glob("*.jpg")))
        print(f"  {label}: {n}")
