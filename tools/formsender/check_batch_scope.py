#!/usr/bin/env python3
"""送信ツールの「バッチ単位の処理済み判定」を当てる前の確認用(読むだけ・何も書き換えない)。

使い方: python3 check_batch_scope.py sender_20261026_175332_9b8e [/opt/eigyo-form-sender/data]
同じバッチで過去に処理したジョブを特定できるか、件数を表示する。
"""
import csv, json, sys
from pathlib import Path

code = sys.argv[1].strip()
data = Path(sys.argv[2] if len(sys.argv) > 2 else "/opt/eigyo-form-sender/data")
results, rows_dir = data / "results", data / "results" / "rows"

def batch_of(rows):
    s = {r[6].strip() for r in rows if len(r) > 6 and r[6].strip().startswith("sender_")}
    return next(iter(s)) if len(s) == 1 else ""

ids_hist, ids_snap = set(), set()
try:
    for h in json.loads((data / "history.json").read_text(encoding="utf-8")):
        if isinstance(h, dict) and str(h.get("stoc_batch_code", "")).strip() == code:
            ids_hist.add(str(h.get("id")))
except Exception as e:
    print("履歴を読めません:", e)
for p in rows_dir.glob("*.csv"):
    try:
        with p.open(encoding="utf-8-sig", newline="") as f:
            if batch_of(list(csv.reader(f))) == code:
                ids_snap.add(p.stem)
    except Exception:
        pass

ids = ids_hist | ids_snap
print(f"バッチ {code}")
print(f"  履歴で見つかったジョブ: {len(ids_hist)}件 / 控えで見つかったジョブ: {len(ids_snap)}件 / 合計: {len(ids)}件")
cnt, urls = {}, set()
for i in sorted(ids):
    p = results / f"{i}.csv"
    if not p.exists():
        print(f"  ジョブ {i}: 結果CSVなし")
        continue
    with p.open(encoding="utf-8-sig", newline="") as f:
        for r in csv.reader(f):
            if len(r) < 2 or r[0] == "送信先URL":
                continue
            cnt[r[1].strip()] = cnt.get(r[1].strip(), 0) + 1
            urls.add(r[0].strip().lower().rstrip("/"))
print("  このバッチで処理済みの内訳:", cnt or "なし")
print(f"  このバッチで処理済みのURL(重複除く): {len(urls)}件")
if not ids:
    print("  ★注意: このバッチの過去ジョブを特定できません。適用すると、既に送った先へ再送する恐れがあります。")
