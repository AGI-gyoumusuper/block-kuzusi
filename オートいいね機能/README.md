# オートいいね機能 — フォルダ1（スキ獲得・フォロワー獲得）＋ 共通層

note の対象者選定と「最新記事へのスキ」を、かみなり教材の条件どおりに再現し、3アカウント共通の台帳・履歴・実行管理で運用するツールです。
本リポジトリのこのフォルダをそのまま `C:\Users\taker\OneDrive\デスクトップ\オートいいね機能` に置いて使います。

今回の依頼範囲は「開発・ローカル検証まで」です。実アカウントでの送信と定期実行は初期OFFで、利用者が画面で明示的に開始したときだけ送ります。

## 1. 配置

```
オートいいね機能/
  1/                 フォルダ1: スキ獲得モード・フォロワー獲得モード（起動入口 start.cmd / start.sh）
    src/app.js       アプリ層（共通層を束ねる）
    src/server.js    操作画面のローカルサーバー（127.0.0.1 のみ）
    src/cli.js       コマンド入口（serve / status / collect / plan / run / export / verify-session / outcomes / probe）
    src/public/      操作画面
  2/                 フォルダ2（フォロー返し・残数回復）: 要件書未受領のため未実装。共通層の接続点を README に記載
  shared/            共通層（1 と 2 が同じ台帳・実行管理を使う）
    db.js            SQLite（node:sqlite）。単一の共有DB、WAL、BEGIN IMMEDIATE
    ledger.js        共有台帳: 人物（userId 優先）・出所・評価・担当・状態機械・試行・成果・実行ロック
    limits.js        実行管理: 外部制限 / 内部残数と20分回復 / 日次（JST） / 時間 / 最小間隔
    rules.js         選定規則（純粋関数）
    collect.js       候補収集・統合・評価・担当割当
    runner.js        実行器: 予約 → 再確認 → 送信開始 → 結果確認
    seeds.js         起点の登録と本人確認
    criteria.js      選定条件と出典（画面表示用）
    accounts.js      3アカウント定義とログインID照合
    outcomes.js      成果（スキ返し・フォロー増加）の一致記録
    export.js        CSV / JSON 出力
    adapters/mock.js         モック（実 note に接続しない）
    adapters/note-browser.js 実 note（既存 Chrome へ CDP 接続。API 項目・セレクタは未検証）
  config/accounts.json       3アカウント（依頼書の表のとおり）
  config/config.example.json 設定例（config.json にコピーして使う）
  fixtures/mock-world.json   モック世界（境界ケースを網羅）
  test/                      受入検証（実スキを送らない）
  exports/                   CSV / JSON の出力先
```

共有DB の既定パス: Windows では `C:\Users\taker\Documents\Codex\note-engagement\data\state.sqlite3`（OneDrive 同期領域の外）。`config.json` の `dbPath`、環境変数 `NOTE_TOOL_DB`、`--db=` で変更できます。

## 2. 前提

- Node.js 22.13 以上（`node:sqlite` を使うため。ネイティブ依存はありません）
- 実 note へ接続する場合のみ `npm install playwright`（モックとテストでは不要。テストの画面検証は playwright があれば実行、無ければ skip）
- 実 note へ接続する場合、各アカウントの専用 Chrome を remote debugging 付きで起動しておく（既存の `.lnk`）。ポートは `config/accounts.json` のとおり 9271 / 9273 / 9272

## 3. 起動

```
cd オートいいね機能\1
start.cmd                       ← モック + ドライラン（既定）。http://127.0.0.1:3747/
start.cmd --adapter=note        ← 実 note（既存 Chrome に接続）。それでも実アクションは OFF のまま
start.cmd --port=3800 --db=D:\path\state.sqlite3
```

コマンド例（`1` フォルダで）:

```
node src\cli.js status
node src\cli.js collect --account=karasu --mode=follower
node src\cli.js plan --account=karasu --mode=follower
node src\cli.js run  --account=karasu --mode=follower            ← ドライラン
node src\cli.js run  --account=karasu --mode=follower --real     ← 実送信（config の enableRealActions が true のときだけ開始）
node src\cli.js export
node src\cli.js verify-session --adapter=note --account=karasu   ← 接続先のログインIDを照合
node src\cli.js probe creator urlname=bold_cobra8451 --adapter=note  ← 実 API の生応答を確認
```

テスト: `npm test`（`node --test test/*.test.js`）。

## 4. 初期状態と安全側の既定

| 項目 | 既定 | 変更方法 |
|---|---|---|
| 実アクション（実アカウントでの送信） | OFF | 画面の「実アクションを有効にする」（確認あり）。さらに開始時に「ドライラン」を外した場合のみ送信 |
| 定期実行 | OFF（実装しない。手動開始のみ） | — |
| 結果不明が出たら実行を止める | ON | 画面の設定 |
| 3アカウントの外部操作 | 順番（単一の実行ロック） | `config.sequentialAcrossAccounts` |
| 一人につきスキ | プロジェクト全体で1件（追加要件） | `config.oneLikePerPersonProjectWide` |

パスワード・Cookie・認証トークンは台帳にもログにも保存しません。実 note アダプタは既存 Chrome のセッションを CDP 経由で使うだけで、Cookie を読み出しません。接続を切っても利用者の Chrome は閉じません。

## 5. 選定条件と出典（画面の「選定条件と出典」と同じ）

| 条件 | 区分 | 出典 |
|---|---|---|
| スキ獲得: 起点の記事の「スキした人一覧」から候補 | 教材に明記 | 教材 1748〜1831行 |
| フォロワー獲得: 起点のフォロワー一覧から候補 | 教材に明記 | 教材 91〜181行、1533〜1625行 |
| 相手の条件: フォロー数 > フォロワー数（厳密。同数不採用、不明は保留） | 教材に明記 | 同上 |
| 活動条件: 0 <= 現在 − 最新公開日時 < 14日 | 教材に明記（フォロワー獲得） | 同上 |
| 同条件をスキ獲得にも適用 | 利用者の追加要件 | フォルダ1要件 A |
| 起点は「フォロー数十・フォロワー数千」 | 教材の例示（必須条件にしない。範囲は設定値、未設定なら判定しない） | 教材 / フォルダ1要件 B |
| 固定記事が150スキを超えたら次を固定 | 教材の推奨（提案表示のみ） | 教材 2468〜2470行 |
| 自分から相手をフォローしない（押すのはスキのみ） | 教材に明記 | 教材 2388〜2404行 |
| 3アカウント間の重複防止、担当は一つ、一人スキ1件 | 利用者の追加要件 | 親文書 §2, §4 |
| 20分ごとの内部残数回復 | 利用者の追加要件 | 親文書 §2 |
| 日次 200 / 時間 50 | 教材の参考値（公式の保証値ではない） | 親文書 §6 |
| 内部残数の上限 50、回復量 10 | 実装上の初期値（フォルダ2要件が未受領のため暫定） | — |
| 「最近の反応の証拠必須」 | 利用者設定（既定OFF） | フォルダ1要件 A |

## 6. 共有台帳の状態

対象ごと・操作種別ごと（`like` / `follow_back`）に一つの状態を持ちます。

`candidate → reserved → sending → succeeded | skipped | failed_before_send | unknown | blocked`

- `reserved` は実行直前に `BEGIN IMMEDIATE` で原子的に取る。同時起動でも同じ対象を二つの実行器が取れない
- `sending` は予約期限が切れても他へ渡さない。実行器が落ちたら起動時に `unknown` にする
- `unknown` は自動再送しない。画面の「サイト状態を照合して確定」でサイト上の既スキ状態を実際に見てから `succeeded` か `candidate` に戻す
- `succeeded` は日付変更・モード変更・再収集で再対象化しない
- `skipped` / `failed_before_send` / `blocked` は再収集で条件を満たせば候補に戻る

## 7. 実行管理

`canExecute` は 外部制限 → 未設定 → 内部残数 → 日次（JST） → 時間（直近60分） → 最小間隔 の順で判定します。外部制限（スキの一時ロック、認証要求）は内部残数より優先し、利用者が「解除を確認した」を押すまで止まります。上限が未設定のアカウントは実行しません（既定値で黙って補完しない）。使用履歴と残数はモード切替・日付変更・再起動で初期化しません。

## 8. 検証結果

### 8.1 実装した機能
フォルダ1要件 A〜E と親文書 §1〜§7 の全項目（フォルダ2の個別要件を除く）。

### 8.2 モックで確認したこと（`npm test`、57件すべて合格。実スキは一切送らない）

| 依頼書の項目 | テスト |
|---|---|
| E.1 出所（スキ一覧／フォロワー一覧） | collect: E.1 |
| E.2 フォロー数と フォロワー数の判定 | rules: E.2、collect: E.3/E.2 |
| E.3 13日23時間 / 14日ちょうど / 15日 / 日時不明 | rules: E.3、collect: E.3/E.2 |
| E.4 固定記事が古い場合 | rules: E.4、collect: E.4 |
| E.5 反応日時不明を捏造しない | rules: E.5、collect: E.5 |
| E.6 同一候補が3アカウント・両モード → 担当一つ・スキ1件 | runner: E.6/7.1 |
| E.7 記事0件 → Aモード停止・Bモード可 | collect: E.7、runner: E.7 |
| E.8 代替操作で埋めない | runner: E.8/7.3 |
| 7.2 中断時の二重計上・再送防止 | runner: 7.2（2件）、ledger: 再起動復旧 |
| 7.3 条件未達・日時不明・本人不一致を通さない | runner: 実行直前の再確認（2件）、collect |
| 7.4 モード切替・再起動・日付変更で初期化しない | app: 7.4/D、app: 再起動、limits: JST |
| 7.5 20分回復・日次/時間・外部制限が独立 | limits: 7.5（3件） |
| 7.6 初期状態で実アクション・定期実行OFF | app: 7.6、runner: 7.6/E、ui.e2e |
| 同時起動での予約の原子性・実行ロック | ledger: 同時起動 |
| 画面（アカウント・モード・起点確認・収集・予定・ドライラン・CSV） | ui.e2e（Playwright） |

### 8.3 実 note では未確認のこと（この環境から note.com へ接続できないため）

- `shared/adapters/note-browser.js` の API 経路（`/api/v2/creators/...` 等）、応答の項目名（`publishAt`、`followingCount`、`isLiked` 等）、日時の書式
- スキ一覧の反応日時が API から取得できるか（取得できなければ「反応日時不明」として扱う設計）
- 記事本文・スキボタンのセレクタ（`config.browser.*`）、押下後の状態確認、ロック・認証要求の表示文言
- CDP 接続（`chromium.connectOverCDP('http://127.0.0.1:<port>')`）が既存の専用 Chrome で動くこと
- 上記は `node src\cli.js probe ...` と `verify-session` で実際の応答を確認し、`config.json` の `noteApi.endpoints` / `browser` を調整してから使ってください

## 9. 未受領の資料と注意

- `2\Fable開発要件.md`（フォロー返し・残数回復）と教材原文 `aaaaaa.txt` は受領していません。教材の内容は依頼書に書かれた要約と行番号だけを根拠にしています
- 回復量・内部残数の上限は暫定の初期値です。フォルダ2の要件に合わせて `config.limits.defaults` を更新してください
- note の利用規約・ヘルプ（スキの一時ロック、スパム判定）に関わる運用です。自動化で成果が保証されるものではなく、「200件なら安全」とも言えません。制限を IP・VPN・プロファイル変更で回避する機能はありません
