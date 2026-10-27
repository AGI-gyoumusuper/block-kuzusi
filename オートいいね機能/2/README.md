# フォルダ2（任意フォロー返し・内部credits回復）

要件: `2/Fable開発要件.md`。共通仕様は `../Fableへの開発依頼.md`。実装は `2/完成品2/`、共通層は `../shared/`（フォルダ1と同じ台帳・履歴・実行管理を使う。独立した履歴は作らない）。

## 起動

```
cd オートいいね機能\2\完成品2
start.cmd                   ← モック + ドライラン。フォロー返し OFF、実アクション OFF。http://127.0.0.1:3748/
start.cmd --adapter=note    ← 実 note（既存 Chrome へ CDP 接続）。それでも両方 OFF のまま
node src\cli2.js status | collect | plan | run [--real] | export | verify-session  [--account=karasu|koisi|pengi]
```

## 動作（要件との対応）

| 要件 | 実装 |
|---|---|
| §1 初期OFF。ON まで候補の確認だけ | 設定 `followBackEnabled`（画面のチェック、初期 false）。OFF では収集・一覧・理由表示のみ。開始（ドライラン含む）は `follow_back_disabled` で拒否 |
| §1 採用条件（現在フォローされている／未フォロー／14日未満／共通除外・owner・履歴・予約） | `shared/rules.js evaluateFollowBack`。関係は `adapter.getRelationship` で現在の一覧から取得。取れなければ理由付きで保留（通知で推定しない） |
| §1 userId と owner。別 owner は競合、自動移管禁止。同 owner なら like と follow は別 action で各1回 | `shared/follow.js`。競合は `assignments.conflict_json` に記録し画面に表示。評価は `liked_before` を情報として残すだけで排除しない |
| §1 follow の上限は like から流用しない。未設定なら開始不可 | `limit_pools(account_id, op_type)`。follow_back は初期値 null。`limits_unset` で開始不可 |
| §2 20分で +1（設定可能）、容量上限、不正設定で開始しない | `shared/limits.js`。`recovery_interval_min`/`recovery_amount`/`capacity`。`validity()` |
| §2 アカウント×action の枠。2モードは同じ like 枠 | `limit_pools` の主キー。usage も op_type 付き |
| §2 正→0 で empty_since / last_refill。画面更新・再起動で起点を動かさない。引当込みの残数、二重予約しない | `consume()` で遷移時に設定。`applyRefill()` は区間単位でしか進めない。`reserveWithCredit()` が引当（reserved 行）込みで判定 |
| §2 整数区間の回復、容量で打ち切り、繰り越し禁止、一つのトランザクション、再起動・二重起動・時計巻き戻り | `applyRefill()`（`BEGIN IMMEDIATE`）。巻き戻りは起点を置き直して記録 |
| §2 有効残数 = min(内部, 日次 JST, 時間)。内部が戻っても他が 0 なら実行しない。リセットしない | `status().effective`、`canExecute()` |
| §2 72件/日の説明、満タンに戻さない、初期値・容量・補充方式の明示、200/50 は参考値 | 画面の注記と区分表示（`config.limits.labels`、`refillNote`） |
| §3 送信前に共有予約を原子的に取得し owner・履歴・全残数を再確認。記録項目。結果不明の保持と再送禁止 | `FollowRunner._processReserved`、`targets`/`attempts`（action ID・userId・owner・種別・記事key・状態・時刻・消費枠） |
| §4 外部制限・認証切れ・結果不明・内部不足を別状態。429 は外部制限、403 は不明なら停止。内部回復で解除しない | `account_blocks(kind = external_limit / auth / permission_unknown)`。`canExecute()` はブロックを最優先 |
| §4 画面: action 種別ごとの残数・回復予定・停止理由。開始不可の原因を分ける | `App2.state().accounts[].pools / startReasons` |
| §5 受入試験 | `test/f2-followback.test.js`、`test/f2-ui.e2e.test.js`、`test/limits.test.js` |

## 実 note では未確認のこと

- フォロワー一覧・フォロー中一覧の API 経路と項目名（`config.noteApi.endpoints.followers / following`）
- フォローボタンのセレクタと「フォロー中」表示（`config.browser.followButtonSelector / followingButtonText`）
- 429・403・ログイン画面の実際の応答と表示文言

確認手順は `../引継ぎ.md` の「フォルダ2」節を参照。
