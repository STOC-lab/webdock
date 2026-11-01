#!/usr/bin/env python3
"""eigyo-form-sender の main.py に「バッチ単位の処理済み判定」を当てる書き換えスクリプト。

使い方:
    python3 apply_batch_patch.py /opt/eigyo-form-sender/main.py

内容:
  - 送信リストに単一の STOC バッチコードがあるとき、処理済み判定(_load_processed_urls /
    _unprocessed_rows)と重複送信防止(_run_job の sent_urls)を「同じバッチのジョブの結果CSV」
    だけで行う。バッチコードが無いリストは従来どおり全結果CSVで判定する。
  - 適用済みなら何もしない。書き換え前に main.py.bak_batch_<日時> を作る。
  - 対象箇所が1つでも見つからない/複数見つかる場合は、何も書かずにエラー終了する。
"""
import ast
import datetime
import io
import os
import shutil
import sys

MARKER_FUNC = "_job_ids_for_batch"  # この関数があれば適用済みとみなす


class PatchError(Exception):
    pass


# --------------------------------------------------------------------------
# 差し替える関数(コメント・ログは日本語)
# --------------------------------------------------------------------------
NEW_LOAD_PROCESSED = '''def _job_ids_for_batch(batch_code: str) -> set[str]:
    """指定した STOC バッチコードに属するジョブIDを集める。

    判定の根拠は次の3つ(どれかが読めなくても無視して続行する)。
      1) history.json の各エントリの "stoc_batch_code"
      2) 再送用スナップショット(JOB_ROWS_DIR/<job_id>.csv)の行から求めたバッチコード
      3) 実行中ジョブ(_current_job)の stoc_batch_code
    注意: _start_job は _lock を保持したままここを呼ぶので、ここで _lock を取ってはいけない。
    """
    ids: set[str] = set()
    if not batch_code:
        return ids
    # 1) 履歴に保存されたバッチコード(古い履歴には無いことがある)
    try:
        for entry in _load_history():
            if (
                isinstance(entry, dict)
                and entry.get("id")
                and str(entry.get("stoc_batch_code", "")).strip() == batch_code
            ):
                ids.add(str(entry["id"]))
    except Exception:
        pass
    # 2) 送信行スナップショットからの逆引き(履歴にバッチコードが無い古いジョブ用)
    try:
        snapshot_paths = list(JOB_ROWS_DIR.glob("*.csv"))
    except Exception:
        snapshot_paths = []
    for path in snapshot_paths:
        try:
            with path.open("r", encoding="utf-8-sig", newline="") as handle:
                snapshot_rows = list(csv.reader(handle))
            if _stoc_batch_code_from_rows(snapshot_rows) == batch_code:
                ids.add(path.stem)
        except Exception:
            # 壊れたスナップショットは無視する。
            continue
    # 3) 実行中のジョブ
    try:
        current = _current_job
        if (
            current
            and current.get("id")
            and str(current.get("stoc_batch_code", "")).strip() == batch_code
        ):
            ids.add(str(current["id"]))
    except Exception:
        pass
    return ids


def _batch_result_paths(batch_code: str) -> list:
    """同じバッチコードのジョブの結果CSV(存在するものだけ)を返す。"""
    paths = []
    for job_id in sorted(_job_ids_for_batch(batch_code)):
        if "/" in job_id or "\\\\" in job_id or ".." in job_id:
            continue
        path = RESULTS_DIR / f"{job_id}.csv"
        if path.exists():
            paths.append(path)
    return paths


def _load_sent_urls_for_batch(batch_code: str) -> set[str]:
    """同じバッチのジョブの結果CSVから、送信成功したURLだけを集める(重複送信防止用)。

    cio.load_sent_urls() と同じく、URLは row[0].strip() のまま(正規化しない)で返す。"""
    sent: set[str] = set()
    for path in _batch_result_paths(batch_code):
        try:
            with path.open("r", encoding="utf-8-sig", newline="") as handle:
                for row in csv.reader(handle):
                    if len(row) < 2 or row[1].strip() != "成功":
                        continue
                    url = row[0].strip()
                    if url and url != "送信先URL":
                        sent.add(url)
        except Exception:
            # 壊れた過去ファイルは無視し、送信処理を止めない。
            continue
    return sent


def _load_processed_urls(success_only: bool = False, batch_code: str = "") -> set[str]:
    """過去ジョブの逐次保存CSVから、処理済みURLを復元する。

    既定は、成功・失敗・スキップをすべて既処理として扱う。途中停止後に先頭へ
    戻って同じサイトへ再送することを防ぎ、未処理の次の宛先から再開する。
    success_only=True のときは、結果が「成功」の行だけを既処理とする（失敗・スキップは再び対象になる）。
    batch_code を指定したときは、同じバッチコードのジョブの結果CSVだけを根拠にする
    （別キャンペーンで送った先を、今回のリストから除外してしまわないため）。
    batch_code が空のときは従来どおり全結果CSVを対象にする。
    """
    processed = set()
    paths = _batch_result_paths(batch_code) if batch_code else RESULTS_DIR.glob("*.csv")
    for path in paths:
        try:
            with path.open("r", encoding="utf-8-sig", newline="") as handle:
                for row in csv.reader(handle):
                    if not row:
                        continue
                    url = _normalize_url(row[0])
                    if success_only and (len(row) < 2 or row[1].strip() != "成功"):
                        continue
                    if url and url != "送信先URL":
                        processed.add(url)
        except Exception:
            # 壊れた過去ファイルは無視し、現在の再開処理を止めない。
            continue
    return processed'''

NEW_UNPROCESSED = '''def _unprocessed_rows(rows: list, success_only: bool = False, batch_code: str | None = None) -> tuple[list, int, int | None]:
    # batch_code 未指定のときは、リスト自体の単一バッチコードから自動判定する。
    # バッチコードが無いリストは空文字となり、従来どおり全結果CSVで判定する。
    if batch_code is None:
        batch_code = _stoc_batch_code_from_rows(rows)
    processed = _load_processed_urls(success_only, batch_code)
    remaining = []
    first_index = None
    for index, row in enumerate(rows, start=1):
        url = _normalize_url(row[0]) if row else ""
        if url and url not in processed:
            if first_index is None:
                first_index = index
            remaining.append(row)
    return remaining, len(rows) - len(remaining), first_index'''

# 1行置換: (関数名, 置換前の行(インデント除く), 置換後の行リスト(インデントは元の行に合わせて前置))
LINE_EDITS = [
    (
        "_start_job",
        "resume_rows, already_processed, resume_from_index = _unprocessed_rows(rows, once_success_only)",
        [
            "_batch_scope = _stoc_batch_code_from_rows(rows)  # バッチ単位で処理済みを判定する（バッチ無しなら空）",
            "resume_rows, already_processed, resume_from_index = _unprocessed_rows(rows, once_success_only, _batch_scope)",
        ],
    ),
]

START_JOB_LOG_ANCHOR_PREFIX = '_append_log(job, f"前回までの処理済み '
START_JOB_NEW_LOG = [
    "if _batch_scope:",
    '    _append_log(job, f"[バッチ単位] 処理済みの判定は同じバッチ({_batch_scope})の結果だけで行いました")',
]

RUN_JOB_OLD = 'sent_urls = set() if force_resend else (cio.load_sent_urls() if cfg.get("DoNotDuplicateSend") else set())'
RUN_JOB_NEW = [
    "# 送信リストに単一のバッチコードがあり、重複送信防止がONのときは、同じバッチの成功結果だけで判定する。",
    "# （別キャンペーンで送った先を「送信済み」としてスキップしないため。成功先再送のときは従来どおり空）",
    '_sent_batch = "" if force_resend else (_stoc_batch_code_from_rows(rows) if cfg.get("DoNotDuplicateSend") else "")',
    "if _sent_batch:",
    "    sent_urls = _load_sent_urls_for_batch(_sent_batch)",
    '    _append_log(job, f"[バッチ単位] 送信済みの判定は同じバッチ({_sent_batch})の成功結果だけで行いました")',
    "else:",
    '    sent_urls = set() if force_resend else (cio.load_sent_urls() if cfg.get("DoNotDuplicateSend") else set())',
]


def _find_func(tree, name):
    found = [
        n for n in tree.body
        if isinstance(n, (ast.FunctionDef, ast.AsyncFunctionDef)) and n.name == name
    ]
    if len(found) != 1:
        raise PatchError(f"関数 {name} がモジュール直下に{len(found)}個見つかりました（1個である必要があります）")
    return found[0]


def _func_range(node):
    """関数の開始行(デコレータ込み)〜終了行を 1始まりで返す。"""
    start = node.lineno
    if node.decorator_list:
        start = min([start] + [d.lineno for d in node.decorator_list])
    return start, node.end_lineno


def _single_line_in(lines, node, old_stripped, what):
    """関数の範囲内で、strip後に完全一致する行がちょうど1つであることを確認し、その0始まり添字を返す。"""
    start, end = _func_range(node)
    hits = [i for i in range(start - 1, end) if lines[i].strip() == old_stripped]
    if len(hits) != 1:
        raise PatchError(
            f"{node.name} 内の「{what}」の行が{len(hits)}か所見つかりました（ちょうど1か所である必要があります）"
        )
    return hits[0]


def _prefix_line_in(lines, node, prefix, what):
    start, end = _func_range(node)
    hits = [i for i in range(start - 1, end) if lines[i].strip().startswith(prefix)]
    if len(hits) != 1:
        raise PatchError(
            f"{node.name} 内の「{what}」の行が{len(hits)}か所見つかりました（ちょうど1か所である必要があります）"
        )
    return hits[0]


def _indent_of(line):
    return line[: len(line) - len(line.lstrip(" \t"))]


def build_patched(src):
    """書き換え後のソースと、変更内容の説明リストを返す。失敗時は PatchError。"""
    if f"def {MARKER_FUNC}(" in src:
        # 呼び出し側で「適用済み」として扱う
        return None, []
    tree = ast.parse(src)
    eol = "\r\n" if "\r\n" in src else "\n"
    lines = io.StringIO(src, newline="").readlines()  # ast と同じ改行規則で分割する

    # (開始添字, 終了添字(含まない), 新しい行リスト(改行なし))
    edits = []
    notes = []

    # --- 関数の丸ごと差し替え ---
    f_load = _find_func(tree, "_load_processed_urls")
    s, e = _func_range(f_load)
    edits.append((s - 1, e, NEW_LOAD_PROCESSED.split("\n")))
    notes.append("_load_processed_urls を差し替え（batch_code 引数を追加。補助関数 _job_ids_for_batch / _batch_result_paths / _load_sent_urls_for_batch を直前に追加）")

    f_unp = _find_func(tree, "_unprocessed_rows")
    s, e = _func_range(f_unp)
    edits.append((s - 1, e, NEW_UNPROCESSED.split("\n")))
    notes.append("_unprocessed_rows を差し替え（batch_code 引数を追加。未指定ならリストから自動判定）")

    # --- 1行置換: _start_job ---
    f_start = _find_func(tree, "_start_job")
    idx = _single_line_in(lines, f_start, LINE_EDITS[0][1], "_unprocessed_rows の呼び出し")
    ind = _indent_of(lines[idx])
    edits.append((idx, idx + 1, [ind + t for t in LINE_EDITS[0][2]]))
    notes.append("_start_job: _unprocessed_rows の呼び出しにバッチコードを渡すよう変更")

    idx = _prefix_line_in(lines, f_start, START_JOB_LOG_ANCHOR_PREFIX, "「前回までの処理済み」ログ")
    ind = _indent_of(lines[idx])
    old_line = lines[idx].rstrip("\r\n")
    edits.append((idx, idx + 1, [old_line] + [ind + t for t in START_JOB_NEW_LOG]))
    notes.append("_start_job: 「前回までの処理済み…」ログの直後に「[バッチ単位] …」ログを追加")

    # --- 1行置換: _run_job ---
    f_run = _find_func(tree, "_run_job")
    idx = _single_line_in(lines, f_run, RUN_JOB_OLD, "sent_urls の代入")
    ind = _indent_of(lines[idx])
    edits.append((idx, idx + 1, [ind + t if t else t for t in RUN_JOB_NEW]))
    notes.append("_run_job: 重複送信防止の sent_urls を、バッチ付き＋DoNotDuplicateSend ON のとき同バッチの成功結果だけにする")

    # 範囲の重なりチェック
    edits.sort(key=lambda t: t[0])
    for a, b in zip(edits, edits[1:]):
        if a[1] > b[0]:
            raise PatchError("置換範囲が重なっています（想定外のソース構造）")

    # 後ろから適用して添字のずれを避ける
    for start, end, new_lines in sorted(edits, key=lambda t: t[0], reverse=True):
        lines[start:end] = [t + eol for t in new_lines]
    new_src = "".join(lines)

    # 構文チェック（OKでなければ書き込まない）
    try:
        compile(new_src, "main.py", "exec")
    except SyntaxError as exc:
        raise PatchError(f"書き換え後のソースが構文エラーになりました: {exc}")
    # 新関数が実際に入っていることも確認
    new_tree = ast.parse(new_src)
    for name in (MARKER_FUNC, "_batch_result_paths", "_load_sent_urls_for_batch"):
        _find_func(new_tree, name)
    return new_src, notes


def main(argv):
    if len(argv) != 2:
        print("使い方: python3 apply_batch_patch.py /opt/eigyo-form-sender/main.py")
        return 2
    path = argv[1]
    try:
        with open(path, encoding="utf-8", newline="") as f:
            src = f.read()
    except OSError as exc:
        print(f"エラー: {path} を読み込めません: {exc}")
        return 1

    try:
        new_src, notes = build_patched(src)
    except (PatchError, SyntaxError) as exc:
        print(f"エラー: {exc}")
        print("何も書き換えていません。")
        return 1

    if new_src is None:
        print("既にバッチ単位の判定が適用済みです（_job_ids_for_batch が存在）。何も変更しません。")
        return 0

    stamp = datetime.datetime.now().strftime("%Y%m%d_%H%M%S")
    backup = f"{path}.bak_batch_{stamp}"
    shutil.copy2(path, backup)

    tmp = f"{path}.tmp_batch_{stamp}"
    with open(tmp, "w", encoding="utf-8", newline="") as f:
        f.write(new_src)
    shutil.copymode(path, tmp)
    os.replace(tmp, path)

    print(f"バックアップを作成しました: {backup}")
    print("次の変更を適用しました:")
    for n in notes:
        print(f"  - {n}")
    print("サービスを再起動すると反映されます。")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
