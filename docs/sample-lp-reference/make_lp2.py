"""倉庫のデータ（1店分のJSON）から、営業提案用の見本ページ（1枚のHTML）を作る（デザイン版）。

事実（店名・住所・電話・営業時間）はデータをそのまま差し込み、AIには書かせない。
説明文・写真は業種ごとに人が用意したもの（CATEGORY）だけを使う。
使い方: python make_lp2.py shop.json 出力.html
"""
import base64
import html
import json
import os
import sys
import urllib.parse

HERE = os.path.dirname(os.path.abspath(__file__))


def esc(s):
    return html.escape(str(s), quote=True)


def photo(folder, name):
    path = os.path.join(HERE, "photos", folder, name)
    if not folder or not os.path.exists(path):
        return ""
    return "data:image/jpeg;base64," + base64.b64encode(open(path, "rb").read()).decode()


# ---- アイコン（線画のSVG） ----
def ico(name, size=22):
    p = {
        "pin": '<path d="M20 10c0 6-8 12-8 12S4 16 4 10a8 8 0 0 1 16 0Z"/><circle cx="12" cy="10" r="3"/>',
        "phone": '<path d="M22 16.9v3a2 2 0 0 1-2.2 2 19.8 19.8 0 0 1-8.6-3.1 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 2.1 4.2 2 2 0 0 1 4.1 2h3a2 2 0 0 1 2 1.7c.1 1 .4 1.9.7 2.8a2 2 0 0 1-.5 2.1L8 9.9a16 16 0 0 0 6 6l1.3-1.3a2 2 0 0 1 2.1-.4c.9.3 1.8.6 2.8.7a2 2 0 0 1 1.7 2Z"/>',
        "clock": '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
        "heart": '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/>',
        "users": '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M22 21v-2a4 4 0 0 0-3-3.9M16 3.1a4 4 0 0 1 0 7.8"/>',
        "hand": '<path d="M18 11V6a2 2 0 0 0-4 0v5M14 10V4a2 2 0 0 0-4 0v6M10 10.5V6a2 2 0 0 0-4 0v8"/><path d="M18 8a2 2 0 1 1 4 0v6a8 8 0 0 1-8 8h-2c-2.8 0-4.5-.9-6-2.4l-3.6-3.6a2 2 0 0 1 2.8-2.8L7 15"/>',
        "pulse": '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
        "heartpulse": '<path d="M19 14c1.5-1.5 3-3.2 3-5.5A5.5 5.5 0 0 0 16.5 3c-1.8 0-3 .5-4.5 2-1.5-1.5-2.7-2-4.5-2A5.5 5.5 0 0 0 2 8.5c0 2.3 1.5 4 3 5.5l7 7Z"/><path d="M3.2 12H9l.5-1 2 4.5 2-7 1.5 3.5h5.3"/>',
        "check": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
        "clipboard": '<rect x="8" y="2" width="8" height="4" rx="1"/><path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2M12 11h4M12 16h4M8 11h.01M8 16h.01"/>',
        "file": '<path d="M15 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V7Z"/><path d="M14 2v4a2 2 0 0 0 2 2h4M10 9H8M16 13H8M16 17H8"/>',
        "train": '<rect x="4" y="3" width="16" height="16" rx="2"/><path d="M4 11h16M12 3v8M8 19l-2 3M18 22l-2-3M8 15h.01M16 15h.01"/>',
        "camera": '<path d="M14.5 4h-5L7 7H4a2 2 0 0 0-2 2v9a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2V9a2 2 0 0 0-2-2h-3Z"/><circle cx="12" cy="13" r="3"/>',
        "info": '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4M12 8h.01"/>',
        "ext": '<path d="M15 3h6v6M10 14 21 3M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    }[name]
    return (f'<svg width="{size}" height="{size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" '
            f'stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">{p}</svg>')


# ---- 業種ごとの文と写真（人が一度確認したものだけ。効果をうたう表現は入れない） ----
CATEGORY = {
    "整骨院": {
        "photos": "seikotsuin",
        "catch": ["つらい身体に、", "安心して相談できる", "場所を。"],
        "hero_cap": ("施術イメージ", "身体の状態を確認しながら<br>丁寧に対応します"),
        "lead": "お悩みを丁寧に伺い、身体の状態に合わせて施術します。",
        "about": "{name}は、{area}にある整骨院です。地域の皆さまが安心して通えるよう、分かりやすい説明と丁寧な施術を心がけております。",
        "features": [
            ("heart", "丁寧な対応", "一人ひとりの身体の状態に合わせ、ていねいに施術を行います。"),
            ("users", "幅広い世代に", "お年寄りから働く世代まで、さまざまなお悩みのご相談をお受けします。"),
            ("pin", "地域密着", "{area}の皆さまに親しまれる整骨院を目指しています。"),
        ],
        "concerns": ["肩や首の張りが気になる方", "腰のつらさが気になる方", "背中の張りが気になる方",
                     "膝や関節が気になる方", "身体の不調を放っておいている方"],
        "treatments": [
            ("hand", "手技による施術", "身体の状態に合わせた手技でアプローチします。", "詳細な施術内容は院長様に確認のうえ掲載"),
            ("pulse", "状態に合わせた対応", "お悩みを伺い、身体の状態に合わせた施術をご提案します。", "具体的なメニューは院長様に確認のうえ掲載"),
            ("heartpulse", "日常の不調のご相談", "日々の生活で気になる身体の不調をご相談ください。", "取扱いの範囲は院長様に確認のうえ掲載"),
        ],
        "steps": [
            ("clipboard", "受付・問診", "ご来院いただいたら、まずは問診票にご記入いただきます。気になる症状などを伺います。"),
            ("file", "身体の状態を確認", "問診票の内容をもとに、現在の身体の状態を確認いたします。"),
            ("hand", "施術", "お身体の状態に合わせた施術を行います。ご不明点はお気軽にご質問ください。"),
            ("phone", "アフターフォロー", "施術後の過ごし方や、日常での注意点などをお伝えします。"),
        ],
        "cta": "お身体のお悩み、<br>お気軽にご相談ください",
        "cta_sub": "{name}は、地域の皆さまの毎日の生活を身体のケアでサポートします。まずはお電話でお問い合わせください。",
    },
}


def group_hours(hours):
    """同じ時間の曜日をまとめる: [('月・火・木・金', '8:00〜12:00 / 15:00〜19:15'), ...]"""
    out = []
    for d, h in hours:
        for g in out:
            if g[1] == h:
                g[0].append(d)
                break
        else:
            out.append([[d], h])
    return [("・".join(ds), h) for ds, h in out]


def build(shop):
    c = CATEGORY[shop["category"]]
    name, area = shop["name"], shop["area"]
    fmt = lambda s: s.format(name=name, area=area)
    tel = shop["phone"].replace("-", "")
    q = urllib.parse.quote(f'{name} {shop["address"]}')
    map_open = f"https://www.google.com/maps/search/?api=1&query={q}"
    map_embed = f"https://www.google.com/maps?q={urllib.parse.quote(shop['address'])}&output=embed"
    img_hero, img_room, img_recep = (photo(c["photos"], n) for n in ("hero.jpg", "room.jpg", "reception.jpg"))
    groups = group_hours(shop["hours"])
    open_groups = [g for g in groups if "休" not in g[1]]
    closed = [g for g in groups if "休" in g[1]]
    initial = name[0]

    chips = "".join(f'<span class="chip">{ico("clock", 18)}{esc(d)}&nbsp;{esc(h)}</span>' for d, h in open_groups)
    if closed:
        chips += f'<span class="chip off">{ico("clock", 18)}{esc(closed[0][0])}&nbsp;定休日</span>'
    hours_rows = "".join(
        f'<div class="hrow{" off" if "休" in h else ""}"><span class="d">{ico("clock", 20)}{esc(d)}曜日</span>'
        f'<span class="t">{"<br>".join(esc(x) for x in h.split(" / "))}</span></div>' for d, h in shop["hours"])
    foot_hours = "".join(f'<p>{esc(d)}：{esc(h)}</p>' for d, h in open_groups + closed)
    feat_imgs = [(img_hero, "60% 40%"), (img_recep, "45% 50%"), (img_room, "50% 60%")]
    features = "".join(
        f'<div class="feat"><div class="fph"><img src="{feat_imgs[k][0]}" alt="" style="object-position:{feat_imgs[k][1]}"></div>'
        f'<h3>{esc(t)}</h3><p>{esc(fmt(b))}</p></div>'
        for k, (i, t, b) in enumerate(c["features"]))
    bfeat = "".join(f'<span>{ico(i, 18)}{esc(t)}</span>' for i, t, b in c["features"])
    binfo_hours = " / ".join(f'{esc(d)} {esc(h)}' for d, h in open_groups)
    binfo_closed = (esc(closed[0][0]) + "曜 定休") if closed else ""
    concerns = "".join(f'<li>{ico("check", 26)}<span>{esc(x)}</span></li>' for x in c["concerns"])
    treats = "".join(
        f'<div class="treat"><div class="tic">{ico(i, 54)}</div><div class="tb"><h3>{esc(t)}</h3>'
        f'<p>{esc(b)}</p><p class="todo">{ico("info", 16)}{esc(n)}</p></div></div>'
        for i, t, b, n in c["treatments"])
    steps = "".join(
        f'<li><span class="sn">{k}</span><div class="sb"><h3>{ico(i, 22)}{esc(t)}</h3><p>{esc(b)}</p></div></li>'
        for k, (i, t, b) in enumerate(c["steps"], 1))
    catch = c["catch"]
    catch_html = "<br>".join(esc(x) for x in catch[:-1]) + f'<br><em>{esc(catch[-1])}</em>'

    def sec_head(en, ja, sub=""):
        s = f'<p class="en">{en}</p><h2>{ja}</h2><span class="bar"></span>'
        return s + (f'<p class="sub">{sub}</p>' if sub else "")

    return f"""<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow, noarchive">
<title>【見本】{esc(name)}｜{esc(area)}の{esc(shop["category"])}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Noto+Sans+JP:wght@400;500;700;900&family=Noto+Serif+JP:wght@600;900&display=swap" rel="stylesheet">
<style>
:root{{--teal:#0d9488;--teal-d:#0f766e;--teal-l:#ccfbf1;--teal-xl:#f0fdfa;--ink:#1e293b;--sub:#64748b;--line:#e2e8f0;
--orange:#ea580c;--orange-l:#fff7ed;--navy:#1e293b;--bg:#fff;}}
*{{box-sizing:border-box}}
body{{margin:0;font-family:"Noto Sans JP","Hiragino Sans",sans-serif;color:var(--ink);background:var(--bg);line-height:1.8;
-webkit-font-smoothing:antialiased;padding-bottom:76px}}
a{{color:inherit}}
.sample{{background:#fff7ed;color:#9a3412;font-size:12.5px;text-align:center;padding:7px 16px;border-bottom:1px solid #fed7aa}}
.sample b{{font-weight:700}}
header{{position:sticky;top:0;z-index:20;background:rgba(255,255,255,.94);backdrop-filter:blur(8px);
box-shadow:0 2px 12px rgba(15,23,42,.06);display:flex;align-items:center;gap:12px;padding:12px 16px}}
.logo{{width:44px;height:44px;border-radius:50%;background:var(--teal);color:#fff;font-weight:900;font-size:22px;
display:flex;align-items:center;justify-content:center;flex:none}}
.hname{{font-weight:900;font-size:19px;letter-spacing:.02em}}
.wrap{{max-width:760px;margin:0 auto;padding:0 18px}}
section{{padding:64px 0}}
.en{{color:var(--teal);font-weight:700;letter-spacing:.08em;text-align:center;margin:0;font-size:15px}}
h2{{text-align:center;font-size:27px;font-weight:900;margin:6px 0 0;line-height:1.4}}
.bar{{display:block;width:64px;height:5px;border-radius:9px;background:#14b8a6;margin:16px auto 22px}}
.sub{{text-align:center;color:var(--sub);margin:0 0 30px}}
/* hero */
.hero{{background:linear-gradient(180deg,#f0fdfa 0%,#f8fafc 60%,#eff6ff 100%);padding:34px 0 40px;text-align:center}}
.pill{{display:inline-flex;align-items:center;gap:6px;background:var(--teal-l);color:var(--teal-d);font-weight:700;
padding:7px 18px;border-radius:999px;font-size:15px}}
.hero h1{{font-size:34px;font-weight:900;line-height:1.45;margin:22px 0 26px;letter-spacing:.02em}}
.hero h1 em{{font-style:normal;color:var(--teal)}}
.himg{{position:relative;border-radius:28px;overflow:hidden;box-shadow:0 20px 40px -12px rgba(13,148,136,.35)}}
.himg img{{display:block;width:100%;aspect-ratio:16/11;object-fit:cover}}
.himg .cap{{position:absolute;left:16px;bottom:16px;right:28%;background:rgba(255,255,255,.95);border-radius:18px;
padding:12px 16px;text-align:left;font-size:12px;color:var(--sub);line-height:1.5}}
.himg .cap b{{display:block;color:var(--ink);font-size:15.5px;font-weight:900;margin-top:2px}}
.lead{{color:var(--sub);font-size:17px;margin:24px 0}}
.btn{{display:flex;align-items:center;justify-content:center;gap:10px;font-weight:900;font-size:18px;text-decoration:none;
border-radius:16px;padding:17px;margin-top:14px}}
.btn.p{{background:var(--teal);color:#fff;box-shadow:0 10px 20px -8px rgba(13,148,136,.6)}}
.btn.o{{border:3px solid #5eead4;color:var(--teal-d);background:#fff}}
.chips{{display:flex;flex-wrap:wrap;justify-content:center;gap:8px 18px;margin-top:22px;color:var(--sub);font-size:14px}}
.chip{{display:inline-flex;align-items:center;gap:5px}}.chip svg{{color:#14b8a6}}.chip.off svg{{color:#94a3b8}}
/* banner */
.banner{{position:relative;min-height:640px;background:#1e293b center/cover no-repeat;color:#fff;display:flex;flex-direction:column;justify-content:flex-end}}
.banner::before{{content:"";position:absolute;inset:0;background:linear-gradient(180deg,rgba(15,23,42,.15) 0%,rgba(15,23,42,.35) 40%,rgba(8,47,45,.92) 100%)}}
.bcap{{position:absolute;top:12px;right:12px;font-size:11px;background:rgba(0,0,0,.45);padding:3px 9px;border-radius:6px;z-index:1}}
.bin{{position:relative;padding:0 22px 26px;text-align:center}}
.beyebrow{{font-family:"Noto Serif JP",serif;font-size:14px;letter-spacing:.18em;opacity:.95;margin:0 0 6px}}
.bname{{font-family:"Noto Serif JP",serif;font-weight:900;font-size:46px;line-height:1.25;letter-spacing:.08em;margin:0;
text-shadow:0 4px 18px rgba(0,0,0,.45)}}
.bline{{width:120px;height:2px;margin:14px auto;background:linear-gradient(90deg,transparent,#fcd34d,transparent)}}
.bcatch{{font-family:"Noto Serif JP",serif;font-size:21px;font-weight:600;line-height:1.7;margin:0 0 18px;text-shadow:0 2px 10px rgba(0,0,0,.5)}}
.bfeat{{display:flex;flex-wrap:wrap;justify-content:center;gap:8px}}
.bfeat span{{display:inline-flex;align-items:center;gap:6px;background:rgba(255,255,255,.16);border:1px solid rgba(255,255,255,.45);
backdrop-filter:blur(4px);padding:6px 12px;border-radius:999px;font-size:13.5px;font-weight:700}}
.binfo{{position:relative;background:#0b2f2c;border-top:1px solid rgba(252,211,77,.4);padding:14px 20px;font-size:13.5px;line-height:1.7}}
.binfo div{{display:flex;gap:8px;align-items:flex-start}}.binfo svg{{color:#fcd34d;flex:none;margin-top:3px}}
.binfo b{{font-size:19px;letter-spacing:.04em}}
.hero-actions{{padding:26px 0 34px;text-align:center;background:#fbf7f1}}
.hero-actions .lead{{margin:0 0 6px}}
/* section colors */
.about{{background:#fbf7f1}}.treatsec{{background:#fff}}.photos{{background:#fbf7f1}}.hourssec{{background:#fff}}
/* about */
.about p.txt{{text-align:center;color:#475569;font-size:16.5px}}
.feat{{background:#fff;border:1.5px solid #ccfbf1;border-radius:24px;padding:30px 22px;
text-align:center;margin-top:20px}}
.fph{{width:150px;height:150px;border-radius:50%;overflow:hidden;margin:0 auto 18px;border:6px solid #fff;
box-shadow:0 0 0 3px #99f6e4,0 14px 28px -12px rgba(13,148,136,.55)}}
.fph img{{width:100%;height:100%;object-fit:cover;display:block}}
.feat h3{{font-size:21px;font-weight:900;margin:0 0 8px}}.feat p{{color:var(--sub);margin:0}}
/* concerns */
.concerns{{background:var(--teal-xl)}}
.clist{{background:#fff;border:1.5px solid #ccfbf1;border-radius:28px;padding:16px 26px;list-style:none;margin:0}}
.clist li{{display:flex;align-items:center;gap:14px;padding:16px 0;font-size:17px;color:#334155}}
.clist li+li{{border-top:1px dashed var(--line)}}.clist svg{{color:#14b8a6;flex:none}}
/* treatments */
.treat{{border:1px solid var(--line);border-radius:24px;overflow:hidden;margin-top:22px;background:#fff}}
.tic{{background:linear-gradient(135deg,#14b8a6,#0f766e);color:#fff;display:flex;align-items:center;justify-content:center;height:140px}}
.tb{{padding:24px 26px}}.tb h3{{margin:0 0 6px;font-size:21px;font-weight:900}}.tb p{{margin:0;color:var(--sub)}}
.todo{{display:flex;align-items:center;gap:6px;color:var(--orange)!important;font-size:14px;margin-top:10px!important}}
.note-box{{background:#f8fafc;border-radius:20px;padding:20px 24px;color:var(--sub);font-size:15px;margin-top:24px}}
/* steps */
.first{{background:#eff6ff}}
.steps{{list-style:none;margin:0;padding:0}}
.steps li{{display:flex;gap:16px;position:relative;padding-bottom:22px}}
.steps li:not(:last-child)::before{{content:"";position:absolute;left:31px;top:70px;bottom:6px;width:3px;background:#99f6e4}}
.sn{{flex:none;width:64px;height:64px;border-radius:50%;background:var(--teal);color:#fff;font-weight:900;font-size:22px;
display:flex;align-items:center;justify-content:center;box-shadow:0 8px 16px -6px rgba(13,148,136,.6)}}
.sb{{background:#fff;border-radius:22px;padding:20px 22px;flex:1;box-shadow:0 6px 18px -8px rgba(15,23,42,.12)}}
.sb h3{{display:flex;align-items:center;gap:8px;margin:0 0 4px;font-size:19px;font-weight:900}}.sb h3 svg{{color:#14b8a6}}
.sb p{{margin:0;color:var(--sub);font-size:15px}}
.pic{{border-radius:24px;overflow:hidden;position:relative;margin-bottom:24px}}
.pic img{{display:block;width:100%}}
.pic::after{{content:"";position:absolute;left:0;right:0;bottom:0;height:45%;background:linear-gradient(transparent,rgba(0,0,0,.45))}}
.pic span{{position:absolute;left:14px;bottom:12px;color:#fff;font-size:14px;display:flex;gap:6px;align-items:center;
text-shadow:0 1px 6px rgba(0,0,0,.5);z-index:1}}
.imgnote{{border:1.5px solid #ccfbf1;border-radius:20px;padding:16px;text-align:center;color:var(--sub);font-size:14.5px}}
/* hours */
.htable{{border:1.5px solid #ccfbf1;border-radius:28px;overflow:hidden;box-shadow:0 10px 30px -14px rgba(13,148,136,.25)}}
.hrow{{display:flex;align-items:center;padding:20px 22px;gap:12px}}.hrow+.hrow{{border-top:1px solid #f1f5f9}}
.hrow .d{{display:flex;align-items:center;gap:10px;font-weight:700;width:7.5em;flex:none}}.hrow .d svg{{color:#14b8a6}}
.hrow .t{{color:#334155}}.hrow.off{{background:#fffbf5}}.hrow.off .d svg{{color:#94a3b8}}.hrow.off .t{{color:var(--sub)}}
.hnote{{color:var(--sub);font-size:14px;margin-top:14px;text-align:center}}
/* access */
.access{{background:var(--teal-xl)}}
.arow{{display:flex;gap:16px;align-items:center;margin:0 0 22px}}
.aic{{width:66px;height:66px;border-radius:50%;background:var(--teal-l);color:var(--teal-d);display:flex;align-items:center;justify-content:center;flex:none}}
.arow b{{display:block;font-size:17px}}.arow span{{color:var(--sub)}}.arow a{{color:var(--teal);font-weight:900;font-size:24px;text-decoration:none}}
.map{{position:relative;border-radius:28px;overflow:hidden;box-shadow:0 10px 30px -14px rgba(15,23,42,.3);margin-top:8px}}
.map iframe{{display:block;width:100%;height:320px;border:0}}
.map a{{position:absolute;left:12px;top:12px;background:#fff;color:#1a73e8;text-decoration:none;font-size:15px;
padding:8px 14px;border-radius:6px;box-shadow:0 2px 6px rgba(0,0,0,.2);display:flex;gap:6px;align-items:center}}
/* cta */
.cta{{background:linear-gradient(135deg,#14b8a6,#0f766e);color:#fff;text-align:center;position:relative;overflow:hidden}}
.cta::before{{content:"";position:absolute;width:420px;height:420px;border-radius:50%;background:rgba(255,255,255,.08);left:-200px;top:-180px}}
.cta h2{{color:#fff;font-size:30px;position:relative}}.cta p{{opacity:.9;position:relative}}
.cta .btn{{background:#fff;color:var(--teal-d);font-size:24px;max-width:420px;margin:26px auto 0;position:relative}}
/* footer */
footer{{background:var(--navy);color:#cbd5e1;padding:48px 0 30px}}
footer .fl{{display:flex;align-items:center;gap:12px;margin-bottom:14px}}footer .hname{{color:#fff}}
footer p{{margin:6px 0}}footer .fi{{display:flex;gap:10px;align-items:center;margin:10px 0}}footer .fi svg{{color:#2dd4bf}}
footer h4{{color:#fff;display:flex;gap:10px;align-items:center;font-size:19px;margin:26px 0 8px}}footer h4 svg{{color:#2dd4bf}}
footer .btn{{display:inline-flex;padding:14px 30px;font-size:17px;background:var(--teal);color:#fff;margin-top:18px}}
.disc{{border-top:1px solid #334155;margin-top:30px;padding-top:20px;font-size:13px;color:#94a3b8;text-align:center}}
.callbar{{position:fixed;left:0;right:0;bottom:0;z-index:30;background:var(--teal);box-shadow:0 -6px 20px rgba(0,0,0,.12)}}
.callbar a{{display:flex;align-items:center;justify-content:center;gap:10px;color:#fff;font-weight:900;font-size:20px;
text-decoration:none;padding:16px}}
@media (min-width:760px){{.feats{{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}}.treats{{display:grid;grid-template-columns:repeat(3,1fr);gap:16px}}}}
</style>
</head>
<body>
<div class="sample"><b>営業提案用の見本です。</b>{esc(name)}様の公式サイトではありません（株式会社エストック作成）</div>
<header><div class="logo">{esc(initial)}</div><div class="hname">{esc(name)}</div></header>

<div class="banner" style="background-image:url('{img_hero}')">
  <span class="bcap">写真はイメージです</span>
  <div class="bin">
    <p class="beyebrow">{esc(area)}の{esc(shop["category"])}</p>
    <p class="bname">{esc(name)}</p>
    <div class="bline"></div>
    <p class="bcatch">{"".join(esc(x) for x in catch)}</p>
    <div class="bfeat">{bfeat}</div>
  </div>
  <div class="binfo">
    <div>{ico("pin", 16)}<span>〒{esc(shop["postal"])} {esc(shop["address"])}</span></div>
    <div>{ico("phone", 16)}<b>{esc(shop["phone"])}</b></div>
    <div>{ico("clock", 16)}<span>{binfo_hours}{("　" + binfo_closed) if binfo_closed else ""}</span></div>
  </div>
</div>
<div class="hero-actions"><div class="wrap">
  <p class="lead">{esc(c["lead"])}</p>
  <a class="btn p" href="tel:{esc(tel)}">{ico("phone", 24)}電話で問い合わせる</a>
  <a class="btn o" href="#access">{ico("pin", 24)}アクセスを見る</a>
</div></div>

<section class="about"><div class="wrap">
  {sec_head("ABOUT", f"{esc(name)}について")}
  <p class="txt">{esc(fmt(c["about"]))}</p>
  <div class="feats">{features}</div>
</div></section>

<section class="concerns"><div class="wrap">
  {sec_head("CONCERNS", "このようなお悩みの方へ", "こんなことでお困りではありませんか？")}
  <ul class="clist">{concerns}</ul>
</div></section>

<section class="treatsec"><div class="wrap">
  {sec_head("TREATMENTS", "施術案内", "お身体の状態に合わせた施術をご案内いたします。")}
  <div class="treats">{treats}</div>
  <div class="note-box">※ 施術内容・メニュー・料金等の詳細につきましては、お電話または来院時にお問い合わせください。</div>
</div></section>

<section class="first"><div class="wrap">
  {sec_head("FIRST VISIT", "初めての方へ", "初めてご来院の方も安心してお越しください。")}
  <ol class="steps">{steps}</ol>
</div></section>

<section class="photos"><div class="wrap">
  <div class="pic"><img src="{img_room}" alt="施術スペースのイメージ写真" ><span>{ico("camera", 18)}施術スペースイメージ</span></div>
  <div class="pic"><img src="{img_recep}" alt="受付のイメージ写真" ><span>{ico("camera", 18)}受付イメージ</span></div>
  <div class="imgnote">写真はイメージです。実際の院内写真・スタッフ写真ではありません。</div>
</div></section>

<section id="hours" class="hourssec"><div class="wrap">
  {sec_head("HOURS", "営業時間", "ご来院の際は営業時間をご確認ください。")}
  <div class="htable">{hours_rows}</div>
  <p class="hnote">祝日・年末年始などは時間が変わることがあります。</p>
</div></section>

<section class="access" id="access"><div class="wrap">
  {sec_head("ACCESS", "アクセス", f"{esc(area)}にございます。お気軽にお越しください。")}
  <div class="arow"><div class="aic">{ico("pin", 28)}</div><div><b>住所</b><span>〒{esc(shop["postal"])} {esc(shop["address"])}</span></div></div>
  <div class="arow"><div class="aic">{ico("phone", 28)}</div><div><b>電話番号</b><a href="tel:{esc(tel)}">{esc(shop["phone"])}</a></div></div>
  <a class="btn p" href="tel:{esc(tel)}">{ico("phone", 24)}電話で問い合わせる</a>
  <div class="map" style="margin-top:28px"><iframe src="{esc(map_embed)}" loading="lazy" title="地図"></iframe>
    <a href="{esc(map_open)}" target="_blank" rel="noopener">マップで開く {ico("ext", 16)}</a></div>
</div></section>

<section class="cta"><div class="wrap">
  <h2>{c["cta"]}</h2>
  <p>{esc(fmt(c["cta_sub"]))}</p>
  <a class="btn" href="tel:{esc(tel)}">{ico("phone", 30)}{esc(shop["phone"])}</a>
</div></section>

<footer><div class="wrap">
  <div class="fl"><div class="logo">{esc(initial)}</div><div class="hname">{esc(name)}</div></div>
  <p>{esc(area)}で、地域の皆さまの健康をサポートする整骨院です。</p>
  <p class="fi">{ico("pin", 20)}〒{esc(shop["postal"])} {esc(shop["address"])}</p>
  <p class="fi">{ico("phone", 20)}{esc(shop["phone"])}</p>
  <h4>{ico("clock", 24)}営業時間</h4>{foot_hours}
  <a class="btn" href="tel:{esc(tel)}">{ico("phone", 20)}電話する</a>
  <div class="disc">※ 当サイトは営業提案用のサンプルサイトです。正式な公式サイトではありません。<br>
  掲載情報はGoogleマップの掲載内容（{esc(shop["source_date"])}時点）をもとにしています。<br>
  作成：株式会社エストック（兵庫県姫路市）TEL 0120-830-046</div>
</div></footer>

<div class="callbar"><a href="tel:{esc(tel)}">{ico("phone", 24)}電話で問い合わせる</a></div>
</body>
</html>
"""


if __name__ == "__main__":
    shop = json.load(open(sys.argv[1], encoding="utf-8"))
    open(sys.argv[2], "w", encoding="utf-8").write(build(shop))
    print("wrote", sys.argv[2])
