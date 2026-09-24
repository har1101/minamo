# minamo

[English](./README.md)

> **水面（みなも）**: 水の面。下で何が動いていても、上は静か。

[AWS Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html) で AI エージェントのループを durable にする、依存ゼロの小さなコアです。

エージェントのループは、普通の TypeScript で書きます。minamo は、モデル呼び出しとツール呼び出しを 1 回ずつ durable なオペレーションとして記録します。そのため、クラッシュしても、再デプロイしても、人の承認を 1 週間待っても、最初からやり直さずに最後に完了した呼び出しから再開します。同じトークンに二重に払うこともありません。

> [!WARNING]
> 実験段階の alpha 版（`0.1.0-alpha.0`）です。API は変わります。

- **依存ゼロ**: コアは Web 標準の API だけを使います。`node:` の import、`Buffer`、`AsyncLocalStorage` は使いません。minify 後で 2 KB 未満、gzip 後で約 1 KB です。
- **ループとモデルは自分で持つ**: minamo はメッセージの形式を決めません。モデルのストリームが返すものを、そのまま記録します。
- **エンジンはアダプター**: コアは 3 つのオペレーションだけの `Durable` インターフェースを使います。`@minamojs/lambda-df` は、Lambda の durable execution SDK でこれを実装します。2 つ目のエンジンの候補は Cloudflare Workflows です。

## インストール

```bash
npm install @minamojs/minamo@alpha @minamojs/lambda-df@alpha @aws/durable-execution-sdk-js
```

Node.js 22 以上が必要です。

| パッケージ | 内容 |
| --- | --- |
| `@minamojs/minamo` | コア（`Durable`、`model`、`runTools`、`Retry`、コーデック）と、テスト用のエンジン `@minamojs/minamo/memory`。依存はありません |
| `@minamojs/lambda-df` | AWS Lambda durable functions のエンジン。peer dependency は `@aws/durable-execution-sdk-js` 2.x です |

## 例

```ts
import { withDurableExecution } from "@aws/durable-execution-sdk-js";
import { model, RetryableError, runTools, type Durable, type Tool } from "@minamojs/minamo";
import { lambda } from "@minamojs/lambda-df";

const tools: Record<string, Tool> = {
  weather: {
    run: async ({ city }: { city: string }) => {
      const response = await getWeather(city);
      if (response.status === 503) throw new RetryableError("weather API unavailable"); // リトライされる
      return response.forecast; // ほかの例外は、エラーの結果としてモデルに返る
    },
  },
  refund: {
    // workflow ツールは durable なオペレーションを使えます。ここでは人の回答を（計算コストなしで）待ちます。
    workflow: async ({ orderId }: { orderId: string }, { durable, idempotencyKey }) => {
      const { approved } = await durable.signal<{ approved: boolean }>("approval", token => notifyReviewer(orderId, token));
      if (!approved) return { status: "rejected" };
      return durable.step("refund", () => payments.refund(orderId, { idempotencyKey }));
    },
  },
};

async function agent(durable: Durable, prompt: string) {
  const messages: Message[] = [{ role: "user", content: prompt }];
  for (let turn = 1; turn <= 10; turn++) {
    // モデル呼び出し 1 回が 1 step。リプレイでは、記録済みのイベントが返り、モデルは呼ばれません。
    const events = await model(durable, `model-${turn}`, () => provider.stream(messages));
    const calls = events.flatMap(event => event.type === "tool_call" ? [event.call] : []);
    messages.push({ role: "assistant", content: events });
    if (calls.length === 0) return events;
    // ツール呼び出しは並列に実行し、1 つずつ記録します。
    messages.push({ role: "tool", content: await runTools(durable, `tools-${turn}`, calls, tools) });
  }
  throw new Error("Too many turns");
}

export const handler = withDurableExecution(async (event: { prompt: string }, context) => agent(lambda(context), event.prompt));
```

`provider`、`Message`、`getWeather`、`notifyReviewer`、`payments` は利用者のコードです。この例は [`test/readme-example.ts`](./test/readme-example.ts) で型チェックしています。

Amazon Bedrock の Converse を使い、そのままデプロイできる完全な例は [examples/lambda-bedrock](./examples/lambda-bedrock) にあります。

## API

### `Durable`

エンジンのインターフェースです。アダプターが実装し、利用者はこれを受け渡します。

| メンバー | 意味 |
| --- | --- |
| `step(name, fn, { retry }?)` | `fn` を実行し、結果を記録します。`retry` がなければ 1 回だけ実行します。`retry` があれば、`retry.when` が受け入れたエラーのときに再実行します。リプレイでは `fn` を実行せず、記録した結果を返します。`fn` の中で durable なオペレーションを使ってはいけません。 |
| `scope(name, fn)` | durable なオペレーションを使える子の `Durable` を渡して、`fn` を実行します。完了したスコープは、記録した結果を返します。 |
| `signal(name, publish, { timeout }?)` | `publish` が受け取ったトークンを誰かが完了させるまで、サスペンドします。Lambda では `waitForCallback` です。待っている間、関数は動きません。 |
| `executionId` | リプレイや再開をまたいで変わりません。 |

名前は、スコープの中で一意かつ決定的にしてください。入力と記録済みの結果から作り、時刻や乱数は使いません。

### `model(durable, name, call, options?)`

モデル呼び出し 1 回を 1 つの step として実行します。`call` はイベント（JSON にできる任意の型）の async iterable を返します。step はすべてのイベントを記録し、関数はその配列を返します。既定では、スロットリング、service unavailable と internal server のエラー、タイムアウト、接続の切断のときに、最大 4 回まで試行します。ほかのエラーは、すぐに失敗します。`options.onEvent` は、UI へのストリーミング用に、step の実行中にイベントを受け取ります。このイベントは暫定です。リトライした試行では、もう一度流れます。

### `runTools(durable, turn, calls, tools)`

1 ターン分のツール呼び出しを並列に実行し、結果を呼び出し順に返します。どのツールも始まる前に、呼び出しごとのスコープ（`<turn>:<call id>`）を呼び出し順に開きます。そのため、ツールの完了順が変わっても、ジャーナルは変わりません。

- `run` を持つツールは、普通のツールです。1 つの step になります。
- `workflow` を持つツールは、自分用の `Durable` を受け取り、step、scope、signal を使えます。承認やサブエージェントに使います。
- 普通のツールで `RetryableError` を投げると、その step をリトライします（既定では指数バックオフで 3 回まで）。ほかのエラーは、1 回だけエラーの結果として記録し、モデルに見せます。変えたいときは、ツールに `retry` を設定します。
- 存在しないツール、リトライを使い切ったツール、失敗した workflow も、エラーの結果になります。モデルはそれを見て対応できます。
- どのツールも `idempotencyKey`（`<executionId>#<call id>`）を受け取ります。リトライ、リプレイ、再開のどれでも同じ値です。外部の API に渡してください。

### 値

記録する値は、JSON と `Uint8Array` です。`Uint8Array` は base64 で保存します。エンジンは、step、scope、signal のすべてに同じコーデックを使います。

## エンジン

| import | エンジン | 状態 |
| --- | --- | --- |
| `@minamojs/lambda-df` | AWS Lambda durable functions（`@aws/durable-execution-sdk-js` 2.x） | デプロイした Lambda と `LocalDurableTestRunner` で動作確認済み |
| `@minamojs/minamo/memory` | テスト用のメモリ上のエンジン | 動作確認済み |
| — | Cloudflare Workflows | 候補 |

## AWS なしでテストする

`MemoryEngine` は、本物のエンジンと同じようにリプレイします。呼び出しのたびにハンドラーを最初から実行し、記録済みの結果を返します。`crash` を使うと、オペレーションを記録した直後に呼び出しを止められるので、あらゆる地点からの復旧をテストできます。

```ts
import { MemoryEngine } from "@minamojs/minamo/memory";

const engine = new MemoryEngine({ crash: () => true }); // 記録のたびにクラッシュさせる
const running = engine.run((durable, prompt: string) => agent(durable, prompt), "hello");
engine.complete(token, { approved: true }); // signal に答える。token は publish が受け取った値
const result = await running;
```

## 保証と制限

- **at-least-once**: 副作用の後、結果を記録する前にプロセスが止まると、ツールがもう一度実行されることがあります。外部の API には `idempotencyKey` を使ってください。
- **決定性**: step の外のコードは、リプレイのたびにもう一度実行されます。同じ durable な呼び出しを同じ順序で行う必要があります。
- **Lambda のクォータ**: 1 つの実行で使えるのは、オペレーション 3,000 個、チェックポイントは累計 100 MB までです。長い会話は複数の実行に分けます。リプレイで同じコードが動くように、公開したバージョンかエイリアスを呼び出します。

## 設計

[docs/design.ja.md](./docs/design.ja.md) を参照してください。

## ライセンス

[MIT](./LICENSE)
