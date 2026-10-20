# minamo

[English](./README.md)

> **水面（みなも）**: 水の面。下で何が動いていても、上は静か。

[AWS Lambda durable functions](https://docs.aws.amazon.com/lambda/latest/dg/durable-functions.html) で動く、依存ゼロの小さな durable エージェントランナーです。

エージェントとツールを宣言すると、minamo がモデルとツールのループを回し、モデル呼び出しとツール呼び出しを 1 回ずつ durable なオペレーションとして記録します。そのため、クラッシュしても、再デプロイしても、人の承認を 1 週間待っても、最初からやり直さずに最後に完了した呼び出しから再開します。同じトークンに二重に払うこともありません。人の承認はツールに 1 行書くだけで、答える側にも DB は要りません。何を待っているかは、実行そのものが知っています。

> [!WARNING]
> 実験段階の alpha 版です。API は変わります。

- **コアは依存ゼロ**: Web 標準の API だけを使います。`node:` の import、`Buffer`、`AsyncLocalStorage` は使いません。minify 後で約 10 KB、gzip 後で約 4 KB です。
- **いつもの schema を使う**: ツールの入力と構造化出力には [Standard Schema](https://standardschema.dev) を渡します（zod 4.2 以降、ArkType。ほかは JSON Schema を並べて渡す）。モデルの入力の検証と、モデルに渡す JSON Schema の生成を minamo が行います。
- **リプレイの都合を業務のコードに漏らさない**: オペレーションの名前、冪等性キー、リプレイで変わらない履歴は minamo が持ちます。利用者はツールを書くだけです。
- **アダプターで差し替える**: コアは 3 つのオペレーションだけの `Durable` インターフェースを使います。`@minamojs/lambda-df` が Lambda でこれを実装します。モデルは小さな `Model` の契約でつなぎます。

## インストール

```bash
npm install @minamojs/minamo@alpha @minamojs/lambda-df@alpha @minamojs/bedrock@alpha @aws/durable-execution-sdk-js @aws-sdk/client-bedrock-runtime zod
```

Node.js 22 以上が必要です。

| パッケージ | 内容 |
| --- | --- |
| `@minamojs/minamo` | `agent()`、`tool()`、メッセージ、`Model` と `HistoryStore` の契約、低水準の `Durable`、`model()`、`runTools()`。`/memory` はテスト用のエンジン、`/testing` は `fakeModel()`。依存はありません |
| `@minamojs/lambda-df` | Lambda durable functions のエンジンと `handle()`。`/callbacks` は `requestId` で人への依頼に答えます（任意の peer: `@aws-sdk/client-lambda`） |
| `@minamojs/bedrock` | `bedrock(modelId)`。Amazon Bedrock Converse のストリーミング。peer: `@aws-sdk/client-bedrock-runtime` |
| `@minamojs/dynamodb` | `dynamoHistory()`。DynamoDB のテーブル 1 つに会話の履歴を保存します。peer: `@aws-sdk/client-dynamodb`。任意 |

## 例

```ts
import { agent, RetryableError, tool } from "@minamojs/minamo";
import { bedrock } from "@minamojs/bedrock";
import { handle } from "@minamojs/lambda-df";
import { z } from "zod";

const support = agent({
  name: "support",
  model: bedrock("us.anthropic.claude-haiku-4-5-20251001-v1:0"),
  instructions: "You are a customer support agent for an online shop.",
  tools: {
    get_weather: tool({
      description: "Weather forecast for a city, used to plan a redelivery.",
      input: z.object({ city: z.string() }),
      run: async ({ city }) => {
        const response = await weather.forecast(city);
        if (response.status === 503) throw new RetryableError("weather API unavailable"); // リトライされる
        return response.body; // ほかの例外は、エラーの結果としてモデルに返る
      },
    }),
    issue_refund: tool({
      description: "Refunds an order after a human approves it.",
      input: z.object({ orderId: z.string(), amountYen: z.number().positive() }),
      approval: { when: ({ amountYen }) => amountYen >= 10_000, timeout: { hours: 1 } },
      run: async (input, { idempotencyKey }) => payments.refund({ ...input, idempotencyKey }),
    }),
  },
});

export const handler = handle(support, {
  prompt: (event: { prompt: string }) => event.prompt,
  onHumanRequest: request => slack.notify(request.summary), // requestId と表示用の情報だけ。トークンはサーバーから出さない
});
```

承認する側は、どの HTTP フレームワークでも次のように書けます。

```ts
import { callbacks } from "@minamojs/lambda-df/callbacks";

const answers = callbacks();
await answers.pending(executionArn);                       // いま答えられる [{ requestId, summary }]
await answers.approve(requestId, { reason: "looks fine" }); // { status: "sent" | "closed" | "unknown" }
```

`weather`、`payments`、`slack` は利用者のコードです。この例は [`test/readme-example.ts`](./test/readme-example.ts) で型チェックしています。スモークテスト付きでそのままデプロイできる例は [examples/lambda-bedrock](./examples/lambda-bedrock) にあります。

## エージェント

`agent({ name, model, instructions?, tools?, output?, maxTurns? = 10 })` はエージェントを返します。`handle(agent, options)` は、durable 実行 1 つにつき 1 回、`agent.name` を run のキーにして実行します。組み合わせるときは、`handle(async (event, durable) => ...)` の中で自分で呼びます。

```ts
const result = await support.run(durable, { key: "support", prompt, history }, { onHumanRequest, onEvent });
// { output, messages, newMessages, turns, finish: { reason, usage? }, historyUpTo? }
```

- `key` は run のスコープの名前です。実行の中で一意にし、時刻や乱数から作らないでください。
- `history`（それまでの `Message`）か、`conversation: { id, store }`（`HistoryStore`。後述）を渡します。`newMessages` は、そのまま次の run の `history` に渡せます。
- `output` は構造化出力の Standard Schema です。minamo が `final_result` ツールを足します。モデルがほかのツールと一緒に呼んだ場合は、ほかのツールを実行し、`final_result` はもう一度呼んでもらいます。
- オペレーションの木: `<key>` のスコープ → `model-<turn>` の step と `tools-<turn>:<callId>` のスコープ（呼び出し順に開く）→ `run` の step、または workflow のオペレーション。

## ツール

`tool({ description, input, approval?, retry?, run })` または `tool({ description, input, approval?, workflow })`。

- `input` の検証は step の外で行うので、refine や transform は純粋でなければなりません。不正な入力は、エラーの結果としてモデルに返ります。
- `run(input, { idempotencyKey, call, attempt })` は 1 つの step です。`RetryableError` を投げるとリトライします（既定は 3 回まで）。ほかのエラーは、1 回だけエラーの結果として記録します。
- `workflow(input, { durable, ask, idempotencyKey, call })` は呼び出しのスコープの中で動き、durable なオペレーションと `ask(name, { request?, schema?, timeout? })` を使えます。`$` で始まる名前は予約されています。
- `idempotencyKey` は `executionId/runKey/turn/callId` です。リトライ、リプレイ、再開のどれでも同じ値です。外部の API に渡してください。

## 人の判断を挟む（HITL）

`approval: true | { when?, timeout?, request? }` は `run` の前に人に尋ねます。`ask()` は workflow の中で尋ねます。どちらも `$human:<name>` のスコープになり、その中に `request` の step（公開してよい要約）と `wait` の signal が入ります。待っている間、関数は動きません。

- `onHumanRequest(request)` は `{ requestId, kind, tool, request, expiresAt?, summary, token, ... }` を依頼ごとに 1 回受け取ります（クラッシュをまたぐと at-least-once なので、`requestId` で重複を除きます）。ブラウザーやチャットには `summary` だけを送ってください。
- 承認になるのは `{ approved: true }`（真偽値）だけです。却下、期限切れ、不正な答え、通知の失敗は、それぞれ別のエラーの結果としてモデルに返り、ツールは実行されません。
- `callbacks().pending(executionArn)` は実行の記録を読み、いま答えられる依頼を返します。`approve`、`reject`、`answer` は `requestId` に対応するまだ終わっていないコールバックを探して答えを送ります。`closed` は期限切れ、答え済み、実行の終了のどれかです。`unknown` は、答えが届いたかどうか分からないことを表します。従う決まりは [`packages/lambda-df/src/callbacks.ts`](./packages/lambda-df/src/callbacks.ts) にあります。
- 呼ぶ前に認可してください。その実行が呼び出した人のものか、その人が答えてよいかです。`requestId` は秘密ではありません。
- `GetDurableExecutionHistory` は、アカウントごとに毎秒 15 回まで（記録の 1 ページにつき 1 回）です。通知は `onHumanRequest` で行い、`pending` は画面の表示や更新のときだけ呼び、ポーリングには使わないでください。多くの実行をまたいだ受信箱が要るときは、`requestId` と `summary` を自分で保存し（トークンは保存しない）、答えるときは同じく `approve(requestId)` を使います。

## 会話の履歴

```ts
interface HistoryStore {
  head(conversationId: string): Promise<number>;
  read(conversationId: string, upTo: number): Promise<Message[]>;
  append(conversationId: string, seq: number, messages: Message[], writeId: string): Promise<void>;
}
```

`conversation: { id, store }` を渡すと、run は履歴の位置だけを記録し（`history-head`）、1 から `upTo` までの run を step の外で読み、自分のメッセージを `upTo + 1` 番目の run として冪等な `writeId` で追記します（`history-append`）。同じ `seq` に追記した 2 つ目の run は `HistoryConflictError` になります。その run の副作用は取り消されないので、1 つの会話で同時に走る run は 1 つにしてください。`memoryHistory()` はコアに、`dynamoHistory({ client, table })` は `@minamojs/dynamodb` にあります。

## AWS なしでテストする

```ts
import { fakeModel, MemoryEngine } from "@minamojs/minamo/testing";

const engine = new MemoryEngine({ crash: () => true }); // 任意: 記録のたびにクラッシュさせる
const running = engine.run(d => support.run(d, { key: "t", prompt: "refund A-1" }, { onHumanRequest: async () => {} }), null);
const [request] = await engine.pending(); // 答えを待っている signal
engine.complete(request.token, { approved: true }); // または engine.expire(request.token)
const result = await running;
```

`MemoryEngine` は、本物のエンジンと同じようにリプレイします。呼び出しのたびにハンドラーを最初から実行し、記録済みの結果を返します。`fakeModel([...])` は、実際のモデル呼び出し 1 回ごとに、台本の応答を 1 つ返します。Lambda でのタイムアウトや大きなスコープの結果は、SDK の `LocalDurableTestRunner` でテストします。

## 低水準の API

エージェントランナーは、次の 3 つの部品でできています。直接使うこともできます。

- `Durable`: `step(name, fn, { retry }?)`、`scope(name, fn)`、`signal(name, publish, { timeout }?)`（期限切れで `SignalTimeoutError`）、`executionId`。名前はスコープの中で一意かつ決定的にします。
- `model(durable, name, call, options?)`: モデル呼び出し 1 回を、ストリームのイベントをすべて記録する 1 つの step として実行します（既定のリトライは `defaultModelRetry`）。
- `runTools(durable, turn, calls, tools)`: 1 ターン分のツール呼び出しを、それぞれ 1 つのスコープで並列に実行します。

記録する値は、JSON と `Uint8Array`（base64 で保存）です。

## 保証と制限

- **at-least-once**: 副作用の後、結果を記録する前にプロセスが止まると、ツールがもう一度実行されることがあります。`idempotencyKey` を使ってください。`onHumanRequest` と `onEvent` も at-least-once です。
- **決定性**: step の外のコードは、リプレイのたびにもう一度実行されます。schema の検証、`approval.when`、`approval.request`、`output` の検証は純粋でなければなりません。
- **Lambda のクォータ**: 1 つの実行でオペレーション 30,000 個、チェックポイントは累計 100 MB、1 オペレーションあたり 1 MB までです。これを超える step は、`@minamojs/lambda-df` が名前を示すエラーで失敗させます。ツールの結果は小さくし、大きなデータは外に置いて参照を返してください。リプレイで同じコードが動くように、公開したバージョンかエイリアスを呼び出します。

## 設計

[docs/agent-api.ja.md](./docs/agent-api.ja.md) と [docs/design.ja.md](./docs/design.ja.md) を参照してください。

## ライセンス

[MIT](./LICENSE)
