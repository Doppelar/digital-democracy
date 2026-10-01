# デジタルまちづくり議会

市長1人と議員3人が、それぞれのスマホから参加して、3年間まちの予算を決めるゲームです。
1年目は公民館での対面だけ、2年目からデジタル、3年目はハイブリッド。
**参加者はアカウント不要**。QRコードを読むだけで参加できます。

- 4人用（足りない席はNPCが担当）・9さいから・30〜40分
- 観戦用URLを会場のスクリーンに映せます
- 1台で試せる「練習モード」つき（設定なしで動きます）

---

## 準備のながれ（はじめての人向け・約20分）

使うもの：パソコン1台、メールアドレス。どちらのサービスも無料プランで動きます。

### 1. Supabase（データの同期）をつくる

1. <https://supabase.com> を開き、「Start your project」からアカウントをつくる（GitHubアカウントでも登録できます）。
2. 「New project」を押す。
   > 無料プランのプロジェクトは2つまでです。もう2つ使っているときは、**今あるプロジェクトを使ってOK**です。このゲームのテーブルや関数はすべて `machi_` で始まるので、ほかのアプリのデータとは混ざりません。その場合は手順4へ進んでください。

   - Name：`machi`（なんでもOK）
   - Database Password：自動で作られたものでOK（ゲームでは使いません）
   - Region：**Northeast Asia (Tokyo)**
3. プロジェクトができるまで1〜2分待つ。
4. 左のメニューの **SQL Editor** を開き、「New query」を押す。
5. このフォルダの **`supabase.sql` の中身を全部コピーして貼りつけ**、右下の **Run** を押す。
   「Success. No rows returned」と出ればOK。
6. 左下の歯車 **Project Settings → API**（または「Data API」）を開き、次の2つを控える。
   - **Project URL**（`https://xxxx.supabase.co`）
   - **anon public** キー（`eyJ...` で始まる長い文字）

> ⚠️ `service_role` キーは使いません。絶対に貼らないでください。

### 2. GitHub（ゲームの画面）に置く

1. <https://github.com> でアカウントをつくる。
2. 右上の「＋」→「New repository」。
   - Repository name：`machi`（これがURLの一部になります）
   - **Public** を選ぶ（無料プランでGitHub Pagesを使うため）
   - 「Create repository」を押す。
3. 次の画面の「uploading an existing file」を押し、このフォルダの中身を**全部**ドラッグする。
   `index.html` `config.js` `backend.js` `supabase.sql` `README.md` と、`vendor` フォルダ（中のファイルごと）。
   「Commit changes」を押す。
4. リポジトリの一覧で **`config.js`** を開き、右上の鉛筆（Edit）を押す。
   1.で控えた URL とキーを、`'...'` の中に貼りつける。

   ```js
   window.MACHI_CONFIG = {
     SUPABASE_URL: 'https://xxxx.supabase.co',
     SUPABASE_ANON_KEY: 'eyJ...',
   };
   ```
   「Commit changes」を押す。
5. リポジトリの **Settings → Pages** を開く。
   - Source：**Deploy from a branch**
   - Branch：**main**、フォルダ **/(root)** → **Save**
6. 1〜2分待つと、上に `https://（ユーザー名）.github.io/machi/` と表示されます。これがゲームのURLです。

### 3. 動作チェック

1. スマホでゲームのURLを開き、ニックネームを入れて「部屋をつくる（市長になる）」。
2. 表示されたQRコードを、別のスマホのカメラで読む → 議員の席をえらぶ。
3. 市長の画面に名前が出れば成功です。

うまくいかないときは、画面に出る理由を見てください。
- 「オンラインの設定がまだです」→ `config.js` の書きかえを確認
- 「Supabase につながりませんでした」→ `supabase.sql` を Run したか、URL とキーのコピーまちがいを確認

---

## イベント当日のコツ

- **前日までに一度ためす**。Supabase の無料プランは、1週間使われないとプロジェクトが一時停止します。停止していたら Supabase の画面で「Restore」を押せば戻ります（数分かかります）。
- **会場のスクリーン**には、ロビーに出る「観戦用」URL（`?watch=部屋コード`）を開いておくと、進行・議場の声・まちの様子が大きく見えます。
- **人数が足りないとき**は、市長の画面で空いている席に「NPCを入れる」。途中でぬけた人の席も「席の管理」からNPCに交代できます。
- **同じスマホでもう一度**遊ぶときは、右上の「終了」→「最初の画面へ」。
- スマホはWi-Fiでもモバイル回線でもOK。インターネットにつながっている必要があります。

## 知っておいてほしいこと

- URLを知っている人はだれでも参加・観戦できます。ニックネームには本名を使わないよう案内してください。
- 子ども向けのイベントゲームなので、ずるをしようと思えばできるしくみです（成績や個人情報は扱っていません）。
- 部屋は最後の操作から6時間たつと、同じ部屋コードが別の部屋に使われることがあります。
- 古いデータを消したいときは、Supabase の SQL Editor で次を実行します。

  ```sql
  delete from machi_rooms where updated_at < now() - interval '1 day';
  ```

## ファイルの中身

| ファイル | 役割 |
|---|---|
| `index.html` | ゲーム本体 |
| `config.js` | Supabase の設定（ここだけ書きかえる） |
| `backend.js` | Supabase とのやりとり |
| `supabase.sql` | Supabase に貼るデータベースの設定 |
| `vendor/` | Supabase と QRコードのプログラム（MITライセンス） |

ゲームの考え方は、Christian Fuchs「What is digital democracy?」（*Journal of Information Technology & Politics*, 2026）の6つのデジタル民主主義モデルをもとにしています。
