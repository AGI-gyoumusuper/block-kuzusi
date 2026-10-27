# フォルダ2（フォロー返し／残数回復）— 今回の依頼では未実装

`2\Fable開発要件.md` は受領していないため、本フォルダの機能（フォロー返し、残数回復の管理）は実装していません。
ただし親文書（Fableへの開発依頼）が求める「1 と 2 が同じ管理層を使う」構成に合わせ、共通層（`../shared`）に接続点を用意しています。

## 共通層が既に提供しているもの（フォルダ2 から利用できる）

| 項目 | 場所 | 内容 |
|---|---|---|
| 共有台帳 | `shared/ledger.js` | 対象者・担当・状態機械・履歴。履歴キーは `(person_id, op_type)` で、`op_type = 'follow_back'` を使えばスキと区別して記録できる（`OP.FOLLOW_BACK`） |
| 担当の共有 | `shared/ledger.js` `assignBalanced()` / `assignedTo()` | フォロー返しもスキと同じ担当を守る。担当外のアカウントをフォローしている相手は `recordAssignmentConflict()` で競合として表示する |
| 残数回復 | `shared/limits.js` `applyRecovery()` | `recovery_interval_min`（追加要件: 20分）ごとに `recovery_amount` 回復。`status()`/`canExecute()` 呼び出し時に自動適用 |
| 日次/時間上限・外部制限 | `shared/limits.js` | `canExecute()` が外部制限 → 未設定 → 内部残数 → 日次 → 時間 → 最小間隔の順で判定 |
| 単一の実行ロック | `shared/ledger.js` `acquireExecutorLock()` | 3アカウントの外部操作を順番に行うためのロック。フォロー返しの実行器も同じロックを取る |
| 初期OFF | `shared/config.js` `enableRealActions`, `scheduler.enabled` | 実アクション・定期実行は初期OFF |

## フォルダ2 を実装する際の約束

- 独立した履歴ファイル・DB を作らない。`shared/db.js` の `openDb(config.dbPath)` を使う
- フォロー返しの状態遷移は `ledger.ensureCandidate → reserve → markSending → finish` を `op_type='follow_back'` で使う
- 送信後の結果不明は `unknown` にし自動再送しない。再試行前に相手のフォロー状態を照合する
- 回復のパラメータ（量・上限）は `2\Fable開発要件.md` の指定に合わせて `config.limits.defaults` を更新し、区分（教材に明記／例示／追加要件／実装上の初期値）を `labels` に記す
