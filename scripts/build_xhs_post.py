# -*- coding: utf-8 -*-
from __future__ import annotations

import json
import math
import sqlite3
from pathlib import Path

import numpy as np
import pandas as pd
from PIL import Image, ImageColor, ImageDraw, ImageEnhance, ImageFilter, ImageFont


ROOT = Path(__file__).resolve().parents[1]
DB = ROOT / "data" / "transactions.sqlite3"
GEOJSON = ROOT / "static" / "beijing-districts.geojson"
OUT = ROOT / "小红书帖子"
DATA_OUT = OUT / "data"
PREVIEW_OUT = OUT / "preview"
BG = OUT / "assets" / "cover-background.png"

W, H = 1152, 1536
PAD = 76
NAVY = "#081828"
INK = "#10212F"
MUTED = "#63717E"
PAPER = "#F6F1E7"
PAPER_2 = "#EEE7DA"
WHITE = "#FFFFFF"
GREEN = "#0C8A62"
GREEN_DARK = "#075C46"
GREEN_LIGHT = "#D8EEE5"
RED = "#D65447"
RED_LIGHT = "#F7DEDA"
GOLD = "#E6AC45"
BLUE = "#3478B8"

FONT_REGULAR = "/System/Library/Fonts/Hiragino Sans GB.ttc"
FONT_BOLD = "/System/Library/Fonts/STHeiti Medium.ttc"
FONT_SERIF = "/System/Library/Fonts/Supplemental/Songti.ttc"


def font(size: int, bold: bool = False, serif: bool = False):
    path = FONT_SERIF if serif else (FONT_BOLD if bold else FONT_REGULAR)
    return ImageFont.truetype(path, size=size)


def rr(draw, box, radius=28, fill=WHITE, outline=None, width=1):
    draw.rounded_rectangle(box, radius=radius, fill=fill, outline=outline, width=width)


def text(draw, xy, s, size, fill=INK, bold=False, anchor=None, spacing=10, serif=False):
    draw.multiline_text(xy, s, font=font(size, bold, serif), fill=fill, anchor=anchor, spacing=spacing)


def fit_text(draw, box, s, start_size, min_size=22, fill=INK, bold=False, spacing=10, align="left"):
    x0, y0, x1, y1 = box
    for size in range(start_size, min_size - 1, -2):
        f = font(size, bold)
        lines = []
        for para in s.split("\n"):
            cur = ""
            for ch in para:
                test = cur + ch
                if draw.textbbox((0, 0), test, font=f)[2] <= x1 - x0:
                    cur = test
                else:
                    lines.append(cur)
                    cur = ch
            lines.append(cur)
        candidate = "\n".join(lines)
        bb = draw.multiline_textbbox((0, 0), candidate, font=f, spacing=spacing, align=align)
        if bb[3] - bb[1] <= y1 - y0:
            draw.multiline_text((x0, y0), candidate, font=f, fill=fill, spacing=spacing, align=align)
            return size
    draw.multiline_text((x0, y0), s, font=font(min_size, bold), fill=fill, spacing=spacing, align=align)
    return min_size


def new_page(color=PAPER):
    return Image.new("RGB", (W, H), color)


def header(draw, kicker, title, subtitle=None, dark=False):
    main = WHITE if dark else INK
    muted = "#B6CAD8" if dark else MUTED
    text(draw, (PAD, 62), kicker, 26, GOLD if dark else GREEN, True)
    text(draw, (PAD, 112), title, 57, main, True, spacing=12)
    if subtitle:
        text(draw, (PAD, 250), subtitle, 27, muted, False, spacing=8)


def footer(draw, page, note="43.4万笔北京二手房成交｜数据截至 2025-07"):
    draw.line((PAD, H - 76, W - PAD, H - 76), fill="#CFC7B9", width=2)
    text(draw, (PAD, H - 57), note, 20, MUTED)
    text(draw, (W - PAD, H - 57), f"{page}/9", 20, MUTED, True, anchor="ra")


def pct(v):
    return f"{v * 100:.1f}%"


def load_analysis():
    with sqlite3.connect(DB) as con:
        df = pd.read_sql_query(
            """SELECT sale_month,district,business_area,community,rooms,area,unit_price,sale_price
               FROM transactions WHERE sale_month <= '2025-07'""",
            con,
        )
    df["district_geo"] = df["district"].replace({"北京经济技术开发区": "大兴"})
    months = sorted(df.sale_month.unique())
    rolling = []
    for end in months:
        start = (pd.Period(end, "M") - 11).strftime("%Y-%m")
        sample = df[(df.sale_month >= start) & (df.sale_month <= end)]
        rolling.append(
            {
                "end": end,
                "start": start,
                "count": int(len(sample)),
                "districts": int(sample.district.nunique()),
                "median": float(sample.unit_price.median()),
                "area_median": float(sample.area.median()),
            }
        )
    rolling = pd.DataFrame(rolling)
    valid = rolling[(rolling["count"] >= 50_000) & (rolling["districts"] >= 16)]
    market_peak = valid.loc[valid["median"].idxmax()]
    base_start, base_end = str(market_peak.start), str(market_peak.end)
    current_start, current_end = "2024-08", "2025-07"

    valid_windows = [(str(r.end), str(r.start)) for r in valid.itertuples(index=False)]

    def aggregate(frame, district_col="district_geo", min_n=100):
        rows = []
        for district, group in frame.groupby(district_col):
            windows = []
            for end, start in valid_windows:
                sample = group[(group.sale_month >= start) & (group.sale_month <= end)]
                if len(sample) >= min_n:
                    windows.append({"end": end, "start": start, "n": len(sample), "price": sample.unit_price.median(), "area": sample.area.median()})
            if not windows:
                continue
            windows = pd.DataFrame(windows)
            current = windows[windows.end == current_end]
            if current.empty:
                continue
            current = current.iloc[0]
            peak_row = windows.loc[windows.price.idxmax()]
            rows.append({
                "district": district, "peak_start": peak_row.start, "peak_end": peak_row.end,
                "base_n": int(peak_row.n), "base_price": float(peak_row.price), "base_area": float(peak_row.area),
                "current_n": int(current.n), "current_price": float(current.price), "current_area": float(current.area),
                "change": float(current.price / peak_row.price - 1),
                "volume_change": float(current.n / peak_row.n - 1),
                "area_change": float(current.area / peak_row.area - 1),
            })
        return pd.DataFrame(rows).sort_values("change")

    districts = aggregate(df)
    fixed = aggregate(df[(df.area >= 60) & (df.area <= 120) & df.rooms.isin(["2室", "3室"])])
    b = df[(df.sale_month >= base_start) & (df.sale_month <= base_end)]
    c = df[(df.sale_month >= current_start) & (df.sale_month <= current_end)]
    overall = {
        "base_n": int(len(b)),
        "current_n": int(len(c)),
        "base_price": float(b.unit_price.median()),
        "current_price": float(c.unit_price.median()),
        "change": float(c.unit_price.median() / b.unit_price.median() - 1),
        "volume_change": float(len(c) / len(b) - 1),
        "base_area": float(b.area.median()),
        "current_area": float(c.area.median()),
    }
    rows = []
    for keys, group in df.groupby(["district", "business_area", "community"]):
        current = group[(group.sale_month >= current_start) & (group.sale_month <= current_end)]
        if len(current) < 30:
            continue
        windows = []
        for end, start in valid_windows:
            sample = group[(group.sale_month >= start) & (group.sale_month <= end)]
            if len(sample) >= 30:
                windows.append({"end": end, "start": start, "n": len(sample), "price": sample.unit_price.median(), "area": sample.area.median()})
        if not windows:
            continue
        windows = pd.DataFrame(windows)
        peak_row = windows.loc[windows.price.idxmax()]
        if int(peak_row.n) + len(current) < 100:
            continue
        rows.append({"district": keys[0], "business_area": keys[1], "community": keys[2],
                     "peak_start": peak_row.start, "peak_end": peak_row.end, "base_n": int(peak_row.n), "base_price": float(peak_row.price), "base_area": float(peak_row.area),
                     "current_n": int(len(current)), "current_price": float(current.unit_price.median()), "current_area": float(current.area.median()),
                     "change": float(current.unit_price.median()/peak_row.price-1), "area_change": float(current.area.median()/peak_row.area-1)})
    communities = pd.DataFrame(rows).sort_values("change")
    return df, rolling, market_peak, districts, fixed, communities, overall


def pain_page():
    im = new_page(); d = ImageDraw.Draw(im)
    header(d, "01｜为什么要做", "你真的了解北京的小区吗？", "普通人依赖平台推荐、朋友介绍和几次实地看房，很容易困在有限样本里。")
    rr(d, (PAD, 350, W-PAD, 710), 34, fill=NAVY)
    text(d, (PAD+42, 393), "这份数据里有", 29, "#BDD0DD", True)
    text(d, (PAD+42, 467), "7,943", 106, GOLD, True)
    text(d, (PAD+430, 530), "个有成交记录的小区", 38, WHITE, True)
    text(d, (PAD+42, 625), "而你真正看过、问过、比较过的，可能只是其中一小部分。", 28, "#D5E2E9")
    problems = [("样本太少", "知道的小区，多来自身边和推荐"), ("维度太感性", "学区、地段、物业很难统一量化"), ("选错代价大", "一套房可能压上全家多年的现金流")]
    y = 790
    for i, (a, b) in enumerate(problems, 1):
        rr(d, (PAD, y, W-PAD, y+155), 28, fill=WHITE)
        d.ellipse((PAD+24, y+31, PAD+112, y+119), fill=GREEN_DARK)
        text(d, (PAD+68, y+75), str(i), 35, WHITE, True, anchor="mm")
        text(d, (PAD+145, y+27), a, 36, INK, True)
        text(d, (PAD+145, y+84), b, 25, MUTED)
        y += 178
    rr(d, (PAD, 1320, W-PAD, 1410), 23, fill=RED_LIGHT)
    text(d, (W//2, 1365), "所以：先用数据缩小范围，再去看具体房子。", 31, RED, True, anchor="mm")
    footer(d, 2)
    return im


def draw_cover(overall):
    im = Image.open(BG).convert("RGB").resize((W, H), Image.Resampling.LANCZOS)
    im = ImageEnhance.Contrast(im).enhance(1.08)
    overlay = Image.new("RGBA", (W, H), (0, 0, 0, 0))
    od = ImageDraw.Draw(overlay)
    od.rectangle((0, 0, W, 1030), fill=(4, 18, 31, 105))
    overlay = overlay.filter(ImageFilter.GaussianBlur(4))
    im = Image.alpha_composite(im.convert("RGBA"), overlay).convert("RGB")
    d = ImageDraw.Draw(im)
    rr(d, (PAD, 70, 430, 126), 28, fill="#E6AC45")
    text(d, (PAD + 22, 84), "真实成交数据调查", 24, NAVY, True)
    text(d, (PAD, 190), "北京房价", 91, WHITE, True)
    text(d, (PAD, 302), "到底跌了多少？", 91, WHITE, True)
    text(d, (PAD, 450), "43.4 万笔成交告诉你", 39, "#C3D8E6", True)
    rr(d, (PAD, 560, W - PAD, 765), 32, fill="#F5F0E8")
    text(d, (PAD + 34, 592), "全北京中位数", 26, MUTED, True)
    text(d, (PAD + 34, 635), pct(overall["change"]), 78, GREEN_DARK, True)
    d.line((530, 592, 530, 735), fill="#D1C7B6", width=2)
    text(d, (574, 592), "反直觉结论", 26, MUTED, True)
    text(d, (574, 642), "最抗跌的\n不是海淀", 50, RED, True, spacing=4)
    text(d, (PAD, 830), "跌幅榜｜抗跌榜｜小区样本｜买房怎么用", 30, WHITE, True)
    text(d, (PAD, H - 70), "滑动 12 个月中位数 · 高点窗口 vs 最新完整窗口", 21, "#BED1DE")
    text(d, (W - PAD, H - 70), "1/9", 21, WHITE, True, anchor="ra")
    return im


def line_chart_page(rolling, peak, overall):
    im = new_page(); d = ImageDraw.Draw(im)
    header(d, "02｜北京整体", "高点之后，整体回撤约 22.7%", "不是拿某一个月制造焦虑，而是比较两个完整 12 个月窗口。")
    x0, y0, x1, y1 = PAD, 390, W - PAD, 930
    rr(d, (x0, y0, x1, y1), 32, fill=WHITE)
    data = rolling[(rolling["count"] >= 50_000) & (rolling["end"] >= "2019-12")].copy()
    vals = data["median"].to_numpy(); vmin, vmax = vals.min() * .96, vals.max() * 1.04
    xs = np.linspace(x0 + 64, x1 - 42, len(data)); ys = y1 - 75 - (vals - vmin) / (vmax - vmin) * (y1 - y0 - 155)
    for tick in [40000, 50000, 60000]:
        if vmin <= tick <= vmax:
            yy = y1 - 75 - (tick - vmin)/(vmax-vmin)*(y1-y0-155)
            d.line((x0+62, yy, x1-40, yy), fill="#E5DED1", width=2)
            text(d, (x0+50, yy), f"{tick/10000:.0f}万", 20, MUTED, anchor="ra")
    pts = list(zip(xs, ys)); d.line(pts, fill=GREEN_DARK, width=7, joint="curve")
    peak_idx = data["median"].idxmax(); pi = list(data.index).index(peak_idx)
    px, py = pts[pi]; d.ellipse((px-10, py-10, px+10, py+10), fill=RED)
    text(d, (px, py-34), f"高点 {data.iloc[pi]['median']/10000:.2f}万/㎡", 23, RED, True, anchor="ms")
    lx, ly = pts[-1]; d.ellipse((lx-10, ly-10, lx+10, ly+10), fill=GREEN_DARK)
    text(d, (lx, ly+35), f"最新 {data.iloc[-1]['median']/10000:.2f}万/㎡", 23, GREEN_DARK, True, anchor="ma")
    for year in [2020,2021,2022,2023,2024,2025]:
        candidates = data[data.end.str.startswith(str(year))]
        if len(candidates):
            idx = data.index.get_loc(candidates.index[0]); text(d, (xs[idx], y1-38), str(year), 20, MUTED, anchor="ma")
    cards = [("高点窗口", "2021-11 ～ 2022-10", f"{overall['base_n']:,} 笔"), ("最新窗口", "2024-08 ～ 2025-07", f"{overall['current_n']:,} 笔"), ("单价中位数", "5.80万 → 4.48万/㎡", "-22.7%")]
    cy=1000; cw=(W-2*PAD-32)/3
    for i,(a,b,c) in enumerate(cards):
        xx=PAD+i*(cw+16); rr(d,(xx,cy,xx+cw,1240),28,fill=PAPER_2)
        text(d,(xx+24,cy+25),a,23,MUTED,True); text(d,(xx+24,cy+76),b,27,INK,True); text(d,(xx+24,cy+143),c,31,GREEN_DARK if i==2 else BLUE,True)
    rr(d,(PAD,1280,W-PAD,1402),24,fill=GREEN_LIGHT)
    text(d,(PAD+28,1312),"一句话：北京确实跌了，但区与区之间最多相差约 15 个百分点。",31,GREEN_DARK,True)
    footer(d,3)
    return im


def bar_page(districts):
    im=new_page();d=ImageDraw.Draw(im)
    header(d,"03｜区域跌幅榜","跌得最狠的区域，集中在远郊","各区与自己的滚动高点比；经开区归入大兴。绿色越深，回撤越大。")
    data=districts.sort_values("change").head(7)
    xbar0,xbar1=340,W-PAD; y=390; max_abs=0.33
    for i,row in enumerate(data.itertuples(index=False)):
        yy=y+i*125
        text(d,(PAD,yy+12),f"{i+1}",25,MUTED,True)
        text(d,(PAD+55,yy+4),row.district,35,INK,True)
        text(d,(PAD+55,yy+48),f"{int(row.base_n):,} → {int(row.current_n):,} 笔",20,MUTED)
        d.rounded_rectangle((xbar0,yy,xbar1,yy+54),radius=27,fill="#E3DED3")
        width=(xbar1-xbar0)*abs(row.change)/max_abs
        color=GREEN_DARK if i<3 else GREEN
        d.rounded_rectangle((xbar0,yy,xbar0+width,yy+54),radius=27,fill=color)
        rr(d,(xbar1-128,yy+5,xbar1-2,yy+49),20,fill=PAPER)
        text(d,(xbar1-14,yy+8),pct(row.change),28,GREEN_DARK,True,anchor="ra")
    rr(d,(PAD,1295,W-PAD,1410),25,fill=RED_LIGHT)
    text(d,(PAD+26,1325),f"{data.iloc[0].district}约 {pct(data.iloc[0].change)}，是样本充足区域里回撤最大的行政区。",30,RED,True)
    footer(d,4)
    return im


def map_page(districts):
    im=new_page();d=ImageDraw.Draw(im)
    header(d,"04｜空间分布","越远，不一定越便宜；但更容易深跌","核心城六区相对更抗跌，北部与西南远郊回撤更明显。")
    geo=json.loads(GEOJSON.read_text(encoding="utf-8"))
    values=dict(zip(districts.district,districts.change))
    coords=[]
    def walk(obj):
        if isinstance(obj,(list,tuple)) and len(obj)==2 and all(isinstance(v,(int,float)) for v in obj): coords.append(obj)
        elif isinstance(obj,(list,tuple)):
            for z in obj: walk(z)
    for f in geo["features"]: walk(f["geometry"]["coordinates"])
    minx,miny=np.min(coords,axis=0);maxx,maxy=np.max(coords,axis=0)
    bx0,by0,bx1,by1=PAD,350,W-PAD,1170
    scale=min((bx1-bx0)/(maxx-minx),(by1-by0)/(maxy-miny)); ox=(bx0+bx1-(maxx-minx)*scale)/2; oy=(by0+by1+(maxy-miny)*scale)/2
    centers={}
    def proj(p): return (ox+(p[0]-minx)*scale,oy-(p[1]-miny)*scale)
    def color(v):
        if v is None:return "#D8D3C9"
        t=max(0,min(1,(-v-.15)/.17)); a=np.array(ImageColor.getrgb("#BFE5D4"));b=np.array(ImageColor.getrgb("#075C46")); return tuple((a*(1-t)+b*t).astype(int))
    for f in geo["features"]:
        name=f["properties"]["name"]; geom=f["geometry"]; polys=geom["coordinates"] if geom["type"]=="MultiPolygon" else [geom["coordinates"]]
        allp=[]
        for poly in polys:
            for ring in poly:
                pts=[proj(p) for p in ring];allp.extend(pts);d.polygon(pts,fill=color(values.get(name)),outline=PAPER,width=2)
        if allp: centers[name]=(sum(p[0] for p in allp)/len(allp),sum(p[1] for p in allp)/len(allp))
    label_names=["房山","密云","怀柔","顺义","昌平","大兴","朝阳","海淀","西城","东城","门头沟","通州"]
    offsets={"西城":(-30,18),"东城":(38,-8),"朝阳":(50,-8),"海淀":(-32,-24),"怀柔":(-12,18),"昌平":(-20,12),"顺义":(25,12),"通州":(15,25)}
    for name in label_names:
        if name in centers:
            x,y=centers[name]; dx,dy=offsets.get(name,(0,0)); x+=dx; y+=dy
            text(d,(x,y),f"{name}\n{pct(values[name]) if name in values else '样本少'}",18,WHITE if values.get(name,-.15)<-.20 else INK,True,anchor="mm",spacing=0)
    rr(d,(PAD,1215,W-PAD,1398),24,fill=WHITE)
    best=districts.sort_values("change",ascending=False).iloc[0]; worst=districts.iloc[0]
    text(d,(PAD+25,1242),f"最抗跌：{best.district} {pct(best.change)}",29,RED,True)
    text(d,(PAD+25,1295),f"最深跌：{worst.district} {pct(worst.change)}",29,GREEN_DARK,True)
    text(d,(PAD+25,1350),"注意：低成交量区域与固定房型结果可能差异较大，不作单一结论。",22,MUTED)
    footer(d,5)
    return im


def resilient_page(districts, fixed):
    im=new_page();d=ImageDraw.Draw(im)
    header(d,"05｜抗跌榜","最抗跌的，不是海淀","同时看全量和固定 60–120㎡、2/3 室口径，西城方向最稳定。")
    fixed_map=dict(zip(fixed.district,fixed.change))
    top=districts[districts.district.isin(fixed_map)].sort_values("change",ascending=False).head(6).copy()
    for i,row in enumerate(top.itertuples(index=False)):
        y=370+i*142
        rr(d,(PAD,y,W-PAD,y+112),24,fill=WHITE)
        text(d,(PAD+28,y+27),f"{i+1}",30,GOLD,True)
        text(d,(PAD+86,y+20),row.district,38,INK,True)
        text(d,(PAD+315,y+22),"全量",22,MUTED,True);text(d,(PAD+405,y+14),pct(row.change),36,RED if row.change>-.20 else GREEN_DARK,True)
        fv=fixed_map.get(row.district)
        if fv is not None:
            text(d,(PAD+660,y+22),"固定房型",22,MUTED,True);text(d,(W-PAD-24,y+14),pct(fv),36,RED if fv>-.20 else GREEN_DARK,True,anchor="ra")
    rr(d,(PAD,1260,W-PAD,1400),26,fill=RED_LIGHT)
    west=districts[districts.district=="西城"].iloc[0]; hai=districts[districts.district=="海淀"].iloc[0]
    text(d,(PAD+28,1285),f"西城：全量 {pct(west.change)}，固定房型 {pct(fixed_map['西城'])}",34,RED,True)
    text(d,(PAD+28,1340),f"海淀：全量 {pct(hai.change)}，固定房型 {pct(fixed_map['海淀'])}",29,INK,True)
    footer(d,6)
    return im


def volume_page(districts, overall):
    im=new_page();d=ImageDraw.Draw(im)
    header(d,"06｜成交量","价格跌，不等于没人买","最新 12 个月样本反而比全市高点窗口多 12.2%；要分清“价跌”和“量缩”。")
    rr(d,(PAD,350,W-PAD,650),32,fill=NAVY)
    text(d,(PAD+45,390),"北京成交笔数",29,"#B9CDDA",True)
    text(d,(PAD+45,455),f"{overall['base_n']:,}",69,WHITE,True)
    text(d,(W//2,483),"→",50,GOLD,True,anchor="mm")
    text(d,(W-PAD-45,455),f"{overall['current_n']:,}",69,WHITE,True,anchor="ra")
    text(d,(W-PAD-45,555),f"{pct(overall['volume_change'])}",48,GOLD,True,anchor="ra")
    text(d,(PAD,690),"各区成交量：自身高点窗口 → 最新窗口",23,MUTED,True)
    data=districts.sort_values("volume_change",ascending=False).head(8)
    y0=730
    for i,row in enumerate(data.itertuples(index=False)):
        y=y0+i*73
        text(d,(PAD,y),row.district,26,INK,True)
        text(d,(PAD+200,y),f"{int(row.base_n):,} → {int(row.current_n):,}",23,MUTED)
        text(d,(W-PAD,y),pct(row.volume_change),27,RED if row.volume_change>0 else GREEN_DARK,True,anchor="ra")
    rr(d,(PAD,1335,W-PAD,1410),22,fill=GREEN_LIGHT)
    text(d,(PAD+24,1353),"成交量是样本可靠度，不是涨跌方向。量大也可能是以价换量。",27,GREEN_DARK,True)
    footer(d,7)
    return im


def community_page(communities):
    im=new_page();d=ImageDraw.Draw(im)
    header(d,"07｜小区样本","同一个北京，小区差距更夸张","仅保留高点和最新期各 ≥30 笔、合计 ≥100 笔的小区；这不是“推荐榜”。")
    worst=communities.head(5)
    mature=communities[communities.peak_end <= "2023-12"]
    best=mature.sort_values("change",ascending=False).head(5)
    rr(d,(PAD,345,W//2-12,1250),28,fill=GREEN_LIGHT)
    text(d,(PAD+28,375),"跌幅较大",34,GREEN_DARK,True)
    for i,row in enumerate(worst.itertuples(index=False)):
        y=450+i*150
        text(d,(PAD+28,y),f"{i+1}. {row.community}",28,INK,True)
        text(d,(PAD+28,y+47),f"{row.district} · {row.business_area}",21,MUTED)
        text(d,(W//2-42,y+85),pct(row.change),34,GREEN_DARK,True,anchor="ra")
    rr(d,(W//2+12,345,W-PAD,1250),28,fill=RED_LIGHT)
    text(d,(W//2+40,375),"全量表现靠前",34,RED,True)
    for i,row in enumerate(best.itertuples(index=False)):
        y=450+i*150
        text(d,(W//2+40,y),f"{i+1}. {row.community}",28,INK,True)
        text(d,(W//2+40,y+47),f"{row.district} · {row.business_area}",21,MUTED)
        text(d,(W-PAD-24,y+85),pct(row.change),34,RED if row.change>-.10 else INK,True,anchor="ra")
    rr(d,(PAD,1288,W-PAD,1405),24,fill=WHITE)
    text(d,(PAD+26,1315),"小区级更容易被面积、户型、新房交付和成交结构影响；",26,INK,True)
    text(d,(PAD+26,1360),"榜单只用于找线索，必须回看同户型逐笔成交。",26,MUTED,True)
    footer(d,8)
    return im


def methodology_page():
    im=new_page();d=ImageDraw.Draw(im)
    header(d,"08｜买房怎么用","这份数据，适合排雷，不适合替你下单","先看大区，再看小区；先看趋势，再回到具体房源。")
    steps=[("1","看区域","判断板块是否长期跑输全市"),("2","看成交量","确认结论不是少数样本"),("3","锁房型","面积、户型尽量保持一致"),("4","查逐笔成交","别只看挂牌价和中介口径")]
    y=360
    for n,a,b in steps:
        rr(d,(PAD,y,W-PAD,y+170),28,fill=WHITE)
        d.ellipse((PAD+26,y+35,PAD+118,y+127),fill=NAVY)
        text(d,(PAD+72,y+80),n,39,WHITE,True,anchor="mm")
        text(d,(PAD+150,y+34),a,38,INK,True)
        text(d,(PAD+150,y+92),b,26,MUTED)
        y+=195
    rr(d,(PAD,1175,W-PAD,1400),28,fill=NAVY)
    text(d,(PAD+32,1205),"统计口径",27,GOLD,True)
    fit_text(d,(PAD+32,1255,W-PAD-32,1385),"12 个月滑动成交单价中位数。北京整体：全市高点窗口 2021-11～2022-10 对比 2024-08～2025-07；区域/小区榜：各自滚动高点对比最新窗口。区域每期 ≥100 笔，小区每期 ≥30 笔且合计 ≥100 笔。成交样本 ≠ 房屋估值。",23,19,WHITE,False,7)
    footer(d,9,note="数据源：项目内北京二手房真实成交记录｜清洗后 434,488 笔")
    return im


def save_contact_sheet(paths):
    thumb_w=288; thumb_h=384; gap=20
    rows=math.ceil(len(paths)/4)
    sheet=Image.new("RGB",(thumb_w*4+gap*5,thumb_h*rows+gap*(rows+1)),"#D8D1C5")
    for i,p in enumerate(paths):
        im=Image.open(p).convert("RGB").resize((thumb_w,thumb_h),Image.Resampling.LANCZOS)
        x=gap+(i%4)*(thumb_w+gap);y=gap+(i//4)*(thumb_h+gap);sheet.paste(im,(x,y))
    sheet.save(PREVIEW_OUT/"contact-sheet.png",quality=95)


def write_copy(peak, districts, communities, overall):
    worst=districts.iloc[0];best=districts.sort_values("change",ascending=False).iloc[0]
    topc=communities[communities.peak_end <= "2023-12"].sort_values("change",ascending=False).iloc[0]
    body=f"""标题（主推）\n43万笔真实成交：北京房价最抗跌的竟不是海淀\n\n备选标题\n1. 北京哪里跌得最狠？我翻了43万笔真实成交\n2. 北京房价回撤地图：买房前先看这9张图\n3. 同样在北京，房价跌幅竟能差16个百分点\n\n正文\n你真正了解、看过、问过的北京小区有多少个？\n\n我把项目里的 {434488:,} 笔二手房成交重新跑了一遍，数据里一共有 7,943 个小区。普通人依赖平台推荐、朋友介绍和几次实地看房，很容易被有限的信息困住；但买房选错，付出的可能是全家很多年的现金流。\n\n这轮房价调整反而给了我们一个观察机会：潮水退去之后，哪些地方价格更坚挺？\n\n为了避免拿某一个月、某几套低价房制造“暴跌”，我定了三条规则：\n1）成交量不够的不进榜；\n2）采用 12 个月滑动成交单价中位数；\n3）每个区域自己和自己的滚动高点比，不比较绝对房价。\n\n先说结论：\n① 北京整体高点窗口：{overall['base_price']/10000:.2f} 万/㎡ → 最新 {overall['current_price']/10000:.2f} 万/㎡，约 {pct(overall['change'])}\n② 回撤较大：{worst.district}，从自己的高点到最新约 {pct(worst.change)}\n③ 相对抗跌：{best.district}，约 {pct(best.change)}\n④ 最反直觉：海淀约 -23.5%，并不是最抗跌的区域\n⑤ 小区差异更大：样本门槛内，较早形成有效高点的小区中，{topc.community}约 {pct(topc.change)}；但小区榜仍会受面积、户型和成交结构影响，不能直接当推荐榜\n\n还有一个容易被忽略的点：北京最新窗口的成交笔数比整体高点窗口多约 {pct(overall['volume_change'])}。所以“价格跌”和“没人买”不是一回事，很多区域可能是在以价换量。\n\n如果你正在北京看房，我更建议这样用：\n1）先用区域长期走势排雷；\n2）再看目标小区全部逐笔成交；\n3）把面积、户型、楼层尽量对齐；\n4）最后才判断具体房源值不值。\n\n买房不是寻找标准答案，而是尽量缩小选择范围、减少信息差和感性冲动。数据不替你下单，但能帮你少走弯路。\n\n你更想看哪个区或哪个小区？评论区留名字，我可以继续做下一期。\n\n话题标签\n#北京买房 #北京二手房 #北京房价 #买房攻略 #房价走势 #数据分析 #北京生活 #刚需买房 #改善型住房 #买房避坑\n\n首条评论建议\n这期先做全北京。下一期你们投票：①300万以内 ②300—500万 ③500—1000万 ④指定行政区。留言具体小区，我会优先查逐笔成交和同户型走势。\n\n封面短标题\n北京房价到底跌了多少？\n副标题：43.4万笔真实成交 / 最抗跌的不是海淀\n"""
    (OUT/"发布文案.md").write_text(body,encoding="utf-8")
    method={"records":434488,"data_end":"2025-07","rolling_window_months":12,"beijing_peak_window":[str(peak.start),str(peak.end)],"current_window":["2024-08","2025-07"],"district_comparison":"each district own rolling peak vs current window","district_min_each_period":100,"community_comparison":"each community own rolling peak vs current window","community_min_each_period":30,"community_min_total":100,"metric":"unit_price_median"}
    (DATA_OUT/"methodology.json").write_text(json.dumps(method,ensure_ascii=False,indent=2),encoding="utf-8")


def main():
    OUT.mkdir(exist_ok=True);DATA_OUT.mkdir(exist_ok=True);PREVIEW_OUT.mkdir(exist_ok=True)
    df,rolling,peak,districts,fixed,communities,overall=load_analysis()
    rolling.to_csv(DATA_OUT/"rolling_12m_beijing.csv",index=False)
    districts.to_csv(DATA_OUT/"district_ranking.csv",index=False)
    fixed.to_csv(DATA_OUT/"district_ranking_fixed_structure.csv",index=False)
    communities.to_csv(DATA_OUT/"community_candidates.csv",index=False)
    pages=[draw_cover(overall),pain_page(),line_chart_page(rolling,peak,overall),bar_page(districts),map_page(districts),resilient_page(districts,fixed),volume_page(districts,overall),community_page(communities),methodology_page()]
    paths=[]
    for i,im in enumerate(pages,1):
        p=OUT/f"{i:02d}.png"; im.save(p,optimize=True);paths.append(p)
    save_contact_sheet(paths);write_copy(peak,districts,communities,overall)
    print(json.dumps({"pages":[str(p) for p in paths],"preview":str(PREVIEW_OUT/'contact-sheet.png'),"overall":overall,"peak":peak.to_dict()},ensure_ascii=False,indent=2))


if __name__ == "__main__":
    main()
