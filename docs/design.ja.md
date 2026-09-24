# minamo の設計

最終更新: 2026-09-24。状態: 実験段階（`0.1.0-alpha.0`）。

## 1. 何を作るか

AI エージェントのループを durable にするための、依存ゼロの小さなコアです。モデル呼び出しとツール実行を durable にする部分だけを持ちます。

- **対象のエンジン**: 最優先は AWS Lambda durable functions です。2 つ目の候補は Cloudflare Workflows です。それ以外のエンジンは、今のところ対象にしません。
- **依存**: `@minamojs/minamo` は npm の依存も `node:` の API も使いません。エンジンは別のパッケージ（`@minamojs/lambda-df`）で、そのエンジンの SDK を peer dependency として参照するだけです。Lambda の利用者はもともと SDK を入れているので、minamo が依存を増やすことにはなりません。
- **パッケージ**: npm の org `@minamojs` の下に置きます。`@minamojs/minamo`（コアと、テスト用のエンジン `@minamojs/minamo/memory`）と、エンジンごとのパッケージ（`@minamojs/lambda-df`。後で `@minamojs/cloudflare`）に分けます。
  - 名前の短い `minamo` は、npm が「既存の `minami`、`minio` と似すぎている」として 403 で拒否しました。
  - `@minamo` のスコープは、別のユーザーが使っていました。
  - メインパッケージは、プロダクト名がそのまま伝わる `@minamojs/minamo` に決めました。エンジンは別パッケージのままです。
- **フレームワーク**: AI SDK や Strands などのアダプターは作りません。エージェントのループは利用者のコードで 15 行ほどで書けます（README の例）。フレームワークとの組み合わせ方が必要になったら、例として示します。
- **名前**: 水面（みなも）。ローマ字でも英語でも同じように読めます。「下で何が動いていても、上は静か」というイメージです。

Hono との対応:

| Hono | minamo |
| --- | --- |
| Web 標準の `Request`/`Response` | `Durable` インターフェース（`step`、`scope`、`signal`）と、JSON + `Uint8Array` のコーデック |
| ランタイムのアダプター（`hono/aws-lambda` など） | エンジンのパッケージ（`@minamojs/lambda-df`、`@minamojs/minamo/memory`） |
| 依存ゼロの小さなコア | 依存ゼロで、`node:` の API を使わない。コアは minify 後 2 KB 未満（gzip 後で約 1 KB） |
| `app.request()` でサーバーなしにテストできる | `@minamojs/minamo/memory` で AWS なしにテストでき、任意の地点でクラッシュさせられる |

### 既存のものとの違い（2026-09-24 時点）

- AWS の durable execution の統合として公開されているのは Pydantic AI（Python）だけです。TypeScript 向けの統合は見つかりませんでした。
- DBOS、Restate、Temporal、Inngest、Vercel Workflow の AI 統合は、それぞれ自社の実行基盤専用です。
- Vercel Workflow は移植性をうたっていますが、`"use workflow"` のコンパイラと独自のランタイムが前提です。Lambda durable functions の上には載りません。

「既存の durable 基盤の上に、エージェントのループだけを薄く載せる」ものは空いている、という判断です（網羅的な確認ではありません）。

## 2. 構成

| ファイル | 内容 |
| --- | --- |
| `packages/core/src/index.ts` | `@minamojs/minamo`: `Durable`、`Retry`、コーデック（`stringify`、`parse`）、`model()`、`runTools()`、`RetryableError` |
| `packages/core/src/memory.ts` | `@minamojs/minamo/memory`: `MemoryEngine`。テスト用のエンジンで、名前をキーにしてリプレイし、クラッシュを注入でき、signal にも答えられます |
| `packages/lambda-df/src/index.ts` | `@minamojs/lambda-df`: `lambda(context)`。Lambda の `DurableContext` を `Durable` に変換します |
| `examples/lambda-bedrock` | Lambda と Bedrock Converse を使う、デプロイできる例です |
| `test/engines.test.ts` | 同じエージェントを `memory` と Lambda（`LocalDurableTestRunner`）で動かします |
| `test/agent.ts` | テスト用のエージェントのループと、台本どおりに動くモデル |
| `test/readme-example.ts` | README の例の型チェック |

## 3. 設計の原則

1. **オペレーションの同一性は「一意で決定的な名前」と「固定した開始順」の両方で決まるようにします。** Cloudflare Workflows は名前で、Lambda は呼び出し順で、記録済みの結果を対応付けます。`runTools()` は、ツール呼び出しごとのスコープを `<turn>:<toolCallId>` という名前で、呼び出し順に同期的に開きます。ツールの完了順が変わっても、同一性は変わりません。Lambda の SDK は、オペレーションを呼んだ時点で ID を決めて実行を始めます（`await` を待ちません）。そのため、呼び出し順を保つのは、コアがオペレーションを決まった順序で同期的に呼ぶことです。アダプターの `Promise.resolve` は、SDK の `DurablePromise`（thenable）を普通の `Promise` に変えるだけです。
2. **コーデックはエンジンの境界に置きます。** エンジンが保存するすべての値（step、scope、signal）を同じコーデックに通します。最初はモデルとツールの関数の中で変換していましたが、スコープの戻り値を通るときに `Uint8Array` が `{"0":1,...}` に壊れました。大きな値の S3 への退避（オフロード）を作るときも、このコーデックを包む serdes にします。Lambda のアダプターは step の結果を step の中でシリアライズし、STEP の記録の上限（256 KB）を超えたらその step を失敗させます。SDK は step の記録の大きさを検査しないため、そのままではチェックポイントの呼び出しが失敗するからです。
3. **`AsyncLocalStorage` を使わず、コンテキストは引数で渡します。** ツールは `idempotencyKey`、`call`、`attempt`、`durable` を引数で受け取ります。こうすると Web 標準の API だけで書けます。Bun でも動くことを確認しました。LLRT で動くかは未確認です。
4. **業務エラーとインフラのリトライを分けます。** ツールの例外は step の中で捕まえ、結果として記録します。リトライするのは、`Retry.when` が真を返すエラー（ツールの既定では `RetryableError`）だけです。`Retry` は宣言的な形（`maxAttempts`、`initialDelay`、`maxDelay`、`backoffRate`、`when`）なので、どのエンジンの設定にも変換できます。
5. **リトライの既定値はエンジンに任せません。** `step` は、`retry` がなければ 1 回だけ実行します。`signal` の `publish` も 1 回だけ実行します（Lambda では SDK が `publish` を step として実行するため、ここでも SDK の既定のリトライを無効にしています）。Lambda の SDK の既定のリトライには頼りません。エンジンによって振る舞いが変わらないようにするためです。`model()` の既定は、一時的なエラー（スロットリング、service unavailable、internal server、タイムアウト、接続の切断）だけを最大 4 回まで試行します。`5xx` や `429` のような数字では判定しません。「520 tokens」のような検証エラーの文言に誤って一致するからです。
6. **Human-in-the-loop は、`workflow` ツールの中で `signal` を使って書きます。** コアにフレームワーク固有の割り込み（interrupt）は入れません。
7. **exactly-once は約束しません。** `memory` エンジンで「すべての記録の直後にクラッシュ」させると、途中で切れたツールはもう一度実行されます。その場合も、同じ `idempotencyKey` が渡ることをテストで確認しています。

## 4. 確認済みのこと

- `memory` エンジン: 承認待ちでサスペンドしてから再開できること。すべての記録の直後にクラッシュさせても、同じ結果に収束すること。ツールのリトライの分類。モデルの一時的なエラーだけをリトライすること。
- Lambda（`LocalDurableTestRunner`）: 同じエージェントがコールバックでサスペンドし、再開時にリプレイされること。モデルとツールが再実行されないこと。スコープが呼び出し順に並ぶこと。
- Bun: クラッシュからのリプレイと、`Uint8Array` の復元。

- デプロイした Lambda（us-east-1、2026-09-24）: `examples/lambda-bedrock` を Bedrock の Claude Haiku 4.5 で実行しました。承認した場合も却下した場合も `SUCCEEDED` になりました。モデル呼び出しは 2 回とも 1 回ずつしか実行されず、呼び出し（invocation）は 3 回でした。1 回目の実行、天気ツールのリトライ待ち、承認後の再開の 3 回です。ツールのスコープは呼び出し順に開き、`RetryableError` を投げた天気ツールは 2 回目の試行で成功しました。

## 5. ロードマップ

1. npm の Trusted Publishing に切り替えます。最初の `0.1.0-alpha.0` は手動で公開し、以降は `release.yml` でタグの push から公開します。
2. 必要になったら、大きな値の S3 への退避（`@minamojs/s3` など）を追加します。
3. 余力があれば、Cloudflare Workflows のアダプターを作ります。

## 6. 未決事項

- **Lambda のオペレーション名の長さの上限**: Bedrock の `toolUseId`（`tooluse_` と 22 文字）を含む `tools-1:tooluse_...` は、デプロイした Lambda で問題なく動きました。上限の値そのものは未確認です。
- **ツールの入力の検証**: 今はツールごとに自分で検証します。Standard Schema（zod、valibot、arktype のどれでも使える型のみの仕様）に対応するかどうか。
- **`strands-lambda-durable-functions` との関係**: 今は別のライブラリとして残します。minamo にはフレームワークのアダプターを作らないので、置き換えはしません。

## 7. 名前を決めた経緯

- ローマ字でも英語でも言いやすく、日本語として意味があり、プロダクトの機能に縛られすぎない名前を探しました。
- 名前の候補が npm で空いているかは、2026-09-24 に registry で確認しました。ただし、公開時の類似名チェックで `minamo` は拒否されたため、パッケージは org のスコープの下に置いています（1 章）。
- 見送った候補:
  - `tsugu`（継ぐ）: 意図が伝わりにくく、覚えにくいため。
  - `shiori`（栞）: 星 11,651 の go-shiori が有名で、npm の名前も使われているため。
  - `sumika`（住処）: 日本ではバンド名の印象が強いため。
  - `hiro`: npm で使われていて、意味が 1 つに定まらないため。
  - `kohaku`（琥珀）: 同じ名前の AI エージェントのフレームワークがあるため。
  - `tasuki`、`tsumugi`: 同じ領域の OSS が使っているため。
