<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/icon.png">
    <img src="assets/icon-onlight.webp" width="120" alt="">
  </picture>
</p>

<h1 align="center">Piem</h1>

<p align="center">
  <b>ずっと後回しにしている保管庫の雑用を、任せてしまおう。</b>
</p>

<p align="center">
  Obsidian のサイドパネルに住み、実際にあなたのノートを編集する AI コーディングエージェント。<br>
  テキストを返して貼り付けさせるだけのチャット欄ではありません。
</p>

<p align="center">
  <img alt="バージョン" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FYoungSx%2Fpiem%2Fmaster%2Fmanifest.json&query=%24.version&label=version&color=7c3aed">
  <img alt="最低 Obsidian バージョン" src="https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2FYoungSx%2Fpiem%2Fmaster%2Fmanifest.json&query=%24.minAppVersion&label=Obsidian&prefix=%E2%89%A5&color=7c3aed">
  <img alt="モバイルは一級市民" src="https://img.shields.io/badge/mobile-first%20class-7c3aed">
  <img alt="ライセンス" src="https://img.shields.io/github/license/YoungSx/piem?color=7c3aed">
</p>

<p align="center">
  <a href="README.md">English</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · 日本語
</p>

<p align="center">
  <img src="assets/screenshots/errand-desktop.webp" alt="左に例のノート、右に Piem を開いた Obsidian。ハードウェア表、購入アドバイス、初心者向けの手順を表示。">
</p>

<p align="center">
  <sub>あなたのノートは左、エージェントは右。デモは旧来の実演を再構成したもので、ファイル操作は実際のプラグインが実行。UI は簡体字中国語で表示。</sub>
</p>

---

## ▶️ ひとつの用事を、最初から最後まで

切り抜いた記事を開いています。数か月前に保存して、そのまま手つかず。サイドパネルにこう打ち込みます:

> **このノートを踏まえて、初心者向けのハードウェア一覧と購入アドバイスを提案して。**

<p align="center">
  <img src="assets/screenshots/errand-trace.webp" width="620" alt="Piem の対話ログ: 展開された 2 つのグループが 3 回の思考を読み取り・書き込み・編集ツールのレシートとまとめ、編集は +4 −0 の差分を示し、続いて返信。">
</p>

*現在の UI は独立した Obsidian のデモ保管庫で撮影。会話文はスクリプトによる演出で、プラグインの読み取り・書き込み・編集ツールは実際に動作しました。*

Piem はそのノートを読み、隣に新しいノートを 1 つ書きました——ハードウェア表、購入アドバイス、初心者向けの手順まで。それから元のノートに戻り、新しいノートを指す `[[ウィキリンク]]` を足して、グラフに両者が仲間だと分かるようにしました。

触れたファイルは 2 つ: **ハードウェア一覧を保存し、バックリンクを 1 本追加（元ノートは +4 −0）。** 思考とツール呼び出しは折りたたまれたグループを共有し、開けば各ステップが見えます。返信は変更したノートの名前を挙げます。

あなたはファイルを 1 つも開いていません。レシートを読んで、自分の一日に戻っただけです。

これがすべての発想です。Piem には手があり——[二十数個の保管庫ツール](docs/tools.ja.md)——それを実際に使います。

## ☕ 午後をまるごと 1 つ節約できたなら

Piem は無料、MIT ライセンス、これからもそのままです。一人の夜と週末のプロジェクトです。ずっと気が重かった 1 時間分の作業をたった今片付けたのなら、コーヒー 1 杯はフェアな取引でしょう。

<p align="center">
  <a href="https://ko-fi.com/shangxin"><img src="https://ko-fi.com/img/githubbutton_sm.svg" alt="Ko-fi で作者を支援する"></a>
</p>

<p align="center"><sub>疯狂星期四，V 我 50。🍗</sub></p>

## 🧰 手元にある残りの道具

|  |  |
| --- | --- |
| **二十数個の保管庫ツール** | 読む、検索、書く、編集、移動、ゴミ箱へ、リンクをたどる、frontmatter を書き換える、タスクを一掃、エディタを操作 —— [すべて見る](docs/tools.ja.md) |
| **サブエージェント、並列で** | 自己完結したタスクを委譲；対話ログは互いに隔離され、階層はチェックではなく構造上 3 段でキャップ —— [仕組み](docs/tools.ja.md#サブエージェント) |
| **MCP サーバー** | リモートツールがエージェント自身のツールセットに、名前空間付きで統合される。だからどの対話ログもツールの出どころについて嘘をつかない —— [接続する](docs/extending.ja.md#mcp-サーバー) |
| **スキル** | 再利用可能な指示。内蔵、あなたの保管庫、あるいはすでに pi で使っている `~/.pi` フォルダから。<kbd>/</kbd> と打つだけ —— [書く](docs/extending.ja.md#スキル) |
| **ついてくるコンテキスト** | いま開いているノート——パスと本文——が毎ターン一緒に送られ、ウィンドウが埋まると会話は自らを圧縮する |
| **必要な場所にアクション** | 空のパネルは開いているノートに合わせた最初の一手を差し出し、どの返信にもコピー・カーソル位置に挿入・ノートに追記・その場で聞き直す、が並ぶ |
| **あなたのエンドポイント、あなたのキー** | OpenAI 互換または Anthropic-messages のあらゆる base URL、16 のプリセットから始められ、能力欄は自動入力 —— [設定する](docs/settings.ja.md#models) |
| **画像** | コンポーザーに貼り付けるかドロップすれば一緒に送られる |
| **英語と簡体字中国語** | Obsidian 自身の言語に従い、違う言語にしたいときは手動で上書きできる |

## ⏱️ 5 分で使い始める

**1. インストール。** 一番簡単なのは [BRAT](https://github.com/TfTHacker/obsidian42-brat): Obsidian のコミュニティプラグインから BRAT を入れ、**Add beta plugin** → `YoungSx/piem`。更新は BRAT が面倒を見てくれます。

手動が好み？ [最新リリース](https://github.com/YoungSx/piem/releases/latest) から `main.js`、`manifest.json`、`styles.css` を取り、`<保管庫>/.obsidian/plugins/piem/` に置いて、Obsidian をリロードし、**設定 → コミュニティプラグイン** で **Piem** を有効化します。

**2. 頭脳を与える。** **設定 → Piem → Models** を開き、サービスと API キーを追加します。既定の提案は DeepSeek；OpenAI 互換または Anthropic-messages なら何でも動き、**Test** ボタンはあなたのチャットが実際に使うのと同じトランスポートでエンドポイントを確かめます。

**3. 何か頼む。** コマンドパレット → **Piem: Open chat**。それから、ずっと避けてきたことを言ってみましょう。<kbd>Ctrl</kbd>/<kbd>⌘</kbd>+<kbd>Enter</kbd> で送信——または **General** でただの <kbd>Enter</kbd> に切り替えられます。

ソースからビルドしますか？ [CONTRIBUTING.md](CONTRIBUTING.md) に 5 つのコマンドがあります。

## 📱 あなたの電話も一台の本物のコンピュータ

<p align="center">
  <img src="assets/screenshots/mobile-empty.webp" width="290" alt="Obsidian 公式のスマホエミュレーションでの送信前の下書き: スキルカードとノート参照が同じ入力枠内に。">
  &nbsp;&nbsp;&nbsp;&nbsp;
  <img src="assets/screenshots/mobile-done.webp" width="290" alt="Obsidian 公式のスマホエミュレーションでの再構成デモ: 保存されたハードウェア一覧とバックリンク。">
</p>

<p align="center">
  <sub>送信前と完了後: 左は入力枠内のスキルとノート参照、右は完成した例。どちらも Obsidian 公式のスマホエミュレーションを使用。</sub>
</p>

Piem は `isDesktopOnly: false` で出荷され、それを本気で意味しています。ツール、サブエージェント、スキル、画像——すべてスマホで動きます。ストリーミングも、オンにすれば動きます。

その約束には代償があり、それが何かを知る価値があります。

**MCP サーバーはリモート専用。** stdio トランスポートは子プロセスを生みますが、スマホにはできません。モバイルで存在しえない能力は、デスクトップ限定の不意打ちとして出荷するより、全員に対して断ります。

**トークン単位のストリーミングは既定でオフ。** Obsidian の `requestUrl` はどのプラットフォームでも CORS に縛られない唯一のリクエスト経路ですが、逐次読み取りが一切ありません——返信は完了したときに丸ごと届きます。本物のストリーミングはブラウザ自身の `fetch` を意味し、たいていのエンドポイントはこれを受け入れます；設定ひとつで切り替えられます（Models → Network → Network transport）。それが使えるかどうかは私たちではなくエンドポイント次第で、ローカルにホストしたモデルはたいてい明示的に許可させる必要があるため、既定のままにしていません。

## 🔓 入れる前に: 確認なしで編集します

**`write` や `edit` の前に確認ステップはありません。** ダイアログも、承認する差分もなし。あなたが頼めば、ノートは変わります。

これは意図的で、これがこの取引の条件です: 12 回も許可を求めるエージェントは、使うのをやめるエージェントです。その代わりに求めるものは:

- 変更されてもよく、そして**あなたのモデルサービスに送られてもよい**保管庫に向けること——検索がファイルに触れれば、そのファイルは送られます；
- あとで対話ログを読むこと。あらゆる変更はツール呼び出しから生まれ、あらゆるツール呼び出しはそこに、隠さず並んでいます；
- 保管庫をバージョン管理に置くか、Obsidian 自身のファイル復元に頼ること。`trash_note` は Obsidian のゴミ箱を通すので、削除は普通のやり方で戻せます。

API キーはデスクトップでは OS のキーチェーンで封印され、モバイルでは平文で保存されます——そこには封印に使えるものが何もなく、そう言う方がごまかすよりましだからです。リリースビルドは[署名付きの来歴](https://github.com/YoungSx/piem/attestations)を持ち、ダウンロードしたバイト列はこのリポジトリまで辿れます。

エラー報告と性能データは既定で Piem のメンテナーに送られます；**Extensions** で共有をオフにできます。本文キャプチャはオフですが、エラーメッセージにノート本文が含まれることはあります。何が送られるかは[セキュリティとプライバシー](docs/security.ja.md)で説明しています。

## 📚 さらに深く

| | |
| --- | --- |
| [**エージェントのツール**](docs/tools.ja.md) | すべてのツール、できないこと、そしてサブエージェントの仕組み |
| [**Piem を拡張する**](docs/extending.ja.md) | スキル、プロンプトテンプレート、MCP サーバー |
| [**設定**](docs/settings.ja.md) | サービスとモデル、チャットの挙動、コマンド、セッションの保存場所 |
| [**セキュリティとプライバシー**](docs/security.ja.md) | 保管庫から何が出ていくか、キーはどこにあるか、Obsidian の審査が指摘する能力 |

貢献しますか？ ワークフローは [CONTRIBUTING.md](CONTRIBUTING.md)、規約は [AGENTS.md](AGENTS.md) を。

## 🙏 巨人の肩の上に

Piem は [`@earendil-works/pi-agent-core`](https://github.com/earendil-works/pi-mono)——pi エージェントのランタイム——の上で動きます。だからあなたが pi のために書いたスキルは、ここでもそのまま動きます。

これは [`lhr0909/pi-obsidian`](https://github.com/lhr0909/pi-obsidian) から育ちました。その出発点に感謝します。

MIT ライセンス。第三者通知は [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) に。
