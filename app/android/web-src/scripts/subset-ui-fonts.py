#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""为 NoriDroid App 生成界面可选字体的子集（woff2）。

用法（需要 fonttools；源字体不放进仓库）：
  python subset-ui-fonts.py --wenkai <LXGWWenKai-*.woff2|ttf> --kuaile <ZCOOLKuaiLe-Regular.ttf> --out <src/assets/fonts>

字符集：
  * 基本拉丁 0x20~0x7E + 常用中英标点
  * GB2312 全量汉字（6763 字，覆盖日常聊天的绝大多数字）
  * App 源码里出现的所有字符（保证界面文案一定不缺字）
覆盖不到的罕见字会由系统字体兜底（不会显示成方块）。

字体来源与许可（SIL OFL 1.1，可商用、可嵌入、可随包分发）：
  * 霞鹜文楷 LXGW WenKai  https://github.com/lxgw/LxgwWenKai        （本脚本用 Fontsource 的 woff2 全量包）
  * 站酷快乐体 ZCOOL KuaiLe https://github.com/google/fonts/tree/main/ofl/zcoolkuaile
"""
import argparse
import pathlib
import re

ASCII = "".join(chr(c) for c in range(0x20, 0x7F))
PUNCT = "，。、；：？！…—－·～「」『』（）〔〕【】《》〈〉“”‘’％＃＠＆＊＋／＝　"
SRC_GLOB = ["*.vue", "*.ts", "*.html", "*.json", "*.less", "*.css"]
HAN_RE = re.compile(r"[\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]")


def gb2312_chars() -> str:
    """枚举 GB2312 全量汉字（一级 3755 + 二级 3008）"""
    out = []
    for hi in range(0xB0, 0xF8):
        for lo in range(0xA1, 0xFF):
            try:
                out.append(bytes([hi, lo]).decode("gb2312"))
            except UnicodeDecodeError:
                pass
    return "".join(out)


def source_chars(src_dir: pathlib.Path) -> str:
    buf = []
    for pat in SRC_GLOB:
        for f in src_dir.rglob(pat):
            if "node_modules" in f.parts:
                continue
            try:
                buf.append(f.read_text(encoding="utf-8", errors="ignore"))
            except OSError:
                pass
    return "".join(buf)


def build_text(src_dir: pathlib.Path) -> tuple[str, dict]:
    parts = {"ascii": ASCII, "punct": PUNCT, "gb2312": gb2312_chars(), "source": source_chars(src_dir)}
    chars = set("".join(parts.values())) - set("\n\r\t\x00")
    stats = {
        "ascii+punct": len(set(ASCII + PUNCT)),
        "gb2312 汉字": len(set(HAN_RE.findall(parts["gb2312"]))),
        "源码里出现的汉字": len(set(HAN_RE.findall(parts["source"]))),
        "合计字符": len(chars),
    }
    return "".join(sorted(chars)), stats


def subset(src: pathlib.Path, text: str, out: pathlib.Path, family_note: str) -> None:
    from fontTools import subset as fts

    opts = fts.Options()
    opts.flavor = "woff2"
    opts.layout_features = ["kern", "liga", "calt", "ccmp", "locl", "palt", "halt", "vert", "vrt2"]
    opts.hinting = False
    opts.desubroutinize = True
    opts.name_IDs = ["*"]
    opts.notdef_outline = True
    opts.drop_tables += ["DSIG"]
    font = fts.load_font(str(src), opts)
    sub = fts.Subsetter(opts)
    sub.populate(text=text)
    sub.subset(font)
    out.parent.mkdir(parents=True, exist_ok=True)
    fts.save_font(font, str(out), opts)
    print(f"  {family_note}: {src.name} -> {out.name} ({out.stat().st_size / 1024:.1f} KB)")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--wenkai", required=True)
    ap.add_argument("--kuaile", required=True)
    ap.add_argument("--out", required=True)
    ap.add_argument("--src", default=None, help="App 源码目录（默认 web-src/src）")
    args = ap.parse_args()

    here = pathlib.Path(__file__).resolve()
    src_dir = pathlib.Path(args.src) if args.src else here.parent.parent / "src"
    out_dir = pathlib.Path(args.out)
    text, stats = build_text(src_dir)
    for k, v in stats.items():
        print(f"  {k}: {v}")
    subset(pathlib.Path(args.wenkai), text, out_dir / "wenkai-ui.woff2", "霞鹜文楷")
    subset(pathlib.Path(args.kuaile), text, out_dir / "kuaile-ui.woff2", "站酷快乐体")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
