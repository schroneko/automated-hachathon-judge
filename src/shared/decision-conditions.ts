import type { CriterionKey } from "./types";

export const CONDITION_PROBABILITY_THRESHOLD = 0.8;

export const SOURCE_EVIDENCE = "提示された固定ソースだけで独立に判定する。実装されたテスト・利用例や実行経路につながる宣言的登録も根拠にできる。README・設定・文書の主張だけでは満たさず、実行の観測や外部調査は要求しない。";

export const DECISION_CONDITIONS = [
  {
    name: "technical_level_2",
    key: "technical",
    level: 2,
    question: "Does the product source implement an actual call, trial stub, or connected declarative integration for a new feature in the trusted reference, beyond merely naming or configuring it or using Codex only during development? Completed integrations also satisfy this minimum.",
    description: `${SOURCE_EVIDENCE}信頼済み一覧の対象新機能を製品で使うための実呼び出し（試験的な呼び出しを含む）、スタブ、または実行経路に接続された宣言的な統合が実装されている。完成した実呼び出しもこの最低条件を満たす。名前の記載、設定だけ、開発時だけのCodex利用は該当しない。`
  },
  {
    name: "technical_level_4",
    key: "technical",
    level: 4,
    question: "Does source show the product purpose of an actual new-feature call or declarative registration and at least one connected step, either from main-flow input to that feature or from that feature to a product result?",
    description: `${SOURCE_EVIDENCE}信頼済み一覧の対象新機能の実呼び出しまたは宣言的登録について、製品での利用目的と、主導線の入力から機能利用、または機能利用から結果への少なくとも一方の接続を追える。`
  },
  {
    name: "technical_level_6",
    key: "technical",
    level: 6,
    question: "Can the product's main flow be traced from input through a new feature in the trusted reference to a useful output, with that feature serving an appropriate role in the task?",
    description: `${SOURCE_EVIDENCE}信頼済み一覧の対象新機能への入力、機能を使う処理、有用な出力までを製品の主導線で追え、その機能が利用目的に合う役割を担っている。`
  },
  {
    name: "technical_level_8",
    key: "technical",
    level: 8,
    question: "Does the implementation handle a constraint or failure relevant to its actual use of a new feature in the trusted reference? Consider handling appropriate to this task, without demanding unrelated timeouts, retries, or quota controls.",
    description: `${SOURCE_EVIDENCE}信頼済み一覧の対象新機能の実際の用途に関係する制約や失敗に対して、適切な対処が実装されている。タイムアウト、再試行、クォータ対策を一律に要求せず、用途に無関係な対策は要求しない。`
  },
  {
    name: "technical_level_10",
    key: "technical",
    level: 10,
    question: "Does an implemented comparison or reproducible verification scenario demonstrate a concrete improvement in the user's task caused by the new feature's capability? API connectivity, response-format validation, input-dependent outputs, usage instructions, and fixed mock handoffs alone do not demonstrate that improvement.",
    description: `${SOURCE_EVIDENCE}単純な方法との比較例または再現可能な検証例から、信頼済み一覧の対象新機能の能力に由来する具体的な作業改善を確認できる。API接続、応答形式、異なる入力に対する出力の変化、固定モックの受け渡しだけの確認では満たさない。新機能の数は問わない。`,
    guidance: "Require an implemented comparison or reproducible verification scenario demonstrating a concrete improvement in the user's TASK caused by the new feature's capability. The feature implementation itself, a usage guide, an API request, answer validation, input-dependent output, or fixed mock plumbing is not such a verification scenario. If only integration code and usage instructions exist, this extra requirement is not met."
  },
  {
    name: "ux_level_2",
    key: "ux",
    level: 2,
    question: "Does source implement at least one user-accessible or automatically triggered entrypoint, such as a UI action, command, public function, HTTP route, browser content script, or registered event handler? Declarative registrations connected to executable handlers count. GUI, CLI, library, API, and automatic entrypoints all qualify.",
    description: `${SOURCE_EVIDENCE}利用者の操作やページ表示などをきっかけに使われる実装済みの入口または呼び出し口がある。実行処理につながる宣言的な登録やイベントハンドラーも認める。GUI、CLI、ライブラリ、API、自動実行を同等に扱い、GUIは要求しない。`
  },
  {
    name: "ux_level_4",
    key: "ux",
    level: 4,
    question: "Does the primary entrypoint actually perform its promised basic task rather than always throw NotImplemented or return a nonprocessing placeholder? Results returned by functions, commands, or APIs count equally with GUI results.",
    description: `${SOURCE_EVIDENCE}実装された入口または呼び出し口から基本の作業が成立する。主要操作が常に未実装エラーを返すだけ、または実際の処理をしない仮の結果を返すだけでは満たさない。GUI、CLI、ライブラリ、APIを同等に扱い、戻り値も結果として認める。`
  },
  {
    name: "ux_level_6",
    key: "ux",
    level: 6,
    question: "Does the implementation guide its target user through the inputs and actions for at least one complete path of the product's core task, with source processing those inputs into the intended result? Judge actual implemented paths; unfinished alternative integrations do not erase a complete implemented path. GUI, CLI, library, and API paths count equally.",
    description: `${SOURCE_EVIDENCE}対象利用者に合った前提条件、開始方法、必要入力が明確で、製品の対象作業について少なくとも1つの実装済み主導線を入力から実際に解く出力まで追える。案内は実コードとの対応を確認して使う。別方式の統合が未完成であることだけでは、完成した主導線を否定しない。常に未実装エラーや処理しない仮の結果を返す入口では満たさない。GUI、CLI、ライブラリ、APIを同等に扱い、戻り値も出力として認める。`
  },
  {
    name: "ux_level_8",
    key: "ux",
    level: 8,
    question: "On the product's implemented main task path, does source reduce trial and error through task-appropriate handling of representative failures, input validation, recovery paths, and suitable defaults where needed? Exceptions, rejected calls, and error results count for libraries and APIs; a GUI, visual progress, and unrelated safeguards are not required.",
    description: `${SOURCE_EVIDENCE}対象作業の代表的な失敗への対処、入力検証、復旧方法、妥当な既定値が、それぞれ用途に必要な範囲で実装され、試行錯誤を減らしている。APIやライブラリの例外、reject、エラー結果も対処として認め、GUI、視覚的な進行表示、無関係な失敗対策は要求しない。`
  },
  {
    name: "ux_level_10",
    key: "ux",
    level: 10,
    question: "Can the same target user complete the main task and recover from representative failures using implemented guidance and actions, with friction-reducing mechanisms beyond ordinary forms, arguments, or error messages demonstrated in at least two concrete situations? Examples include avoiding repeated input, preventing mistakes, and easy correction or cancellation. Developer or administrative tools count only when they are the product's actual target task; equivalent library and API simplifications also qualify.",
    description: `${SOURCE_EVIDENCE}同じ対象利用者の主要作業について、開始から完了と代表的な失敗からの復旧を、案内と対応する実装で一貫して追える。その主導線に、通常のフォーム、引数、エラー表示を超えて作業の摩擦を減らす仕組みがあり、反復入力の省略、誤操作の事前防止、修正・取消の容易さなどの効果を2つ以上の具体的な利用場面で確認できる。ライブラリやAPIの呼び出し簡略化や誤用防止も認める。開発・管理の補助機能は、それ自体が製品の対象作業である場合に数える。`
  },
  {
    name: "impact_level_2",
    key: "impact",
    level: 2,
    question: "Does source implement executable input processing, response generation, or another behavior that demonstrates a functioning mechanism? A working demo, starter, or hello-world is sufficient for this minimum.",
    description: `${SOURCE_EVIDENCE}実行可能な入力処理や応答生成など、仕組みを実演できる処理が実装されている。デモ、ひな形、hello-worldでも満たす。`
  },
  {
    name: "impact_level_4",
    key: "impact",
    level: 4,
    question: "Does the implemented behavior solve at least part of a concrete user's task beyond demonstrating that a framework or mechanism runs? A small task-specific convenience qualifies; a constant hello-world greeting or unchanged tutorial scaffold alone does not.",
    description: `${SOURCE_EVIDENCE}具体的な利用者の作業の少なくとも一部を解く有用な処理が実装されている。小さな利便性、狭い用途、範囲の限られた部分作業の解決でも満たす。hello-worldの固定挨拶やひな形の動作実演だけでは満たさない。`,
    guidance: "A concrete user's task is solved at least in part, beyond demonstrating that the framework or mechanism runs. A constant greeting, tutorial starter, or unchanged scaffold is only a mechanism demonstration and does not meet this condition. A small but actual task-specific convenience qualifies."
  },
  {
    name: "impact_level_6",
    key: "impact",
    level: 6,
    question: "Does an implemented input-to-useful-output flow substantially help a concrete user's task, with source showing how it reduces time, effort, or judgment burden beyond a small convenience? Numerical benchmarks are not required.",
    description: `${SOURCE_EVIDENCE}具体的な利用者の仕事を実質的に助ける入力から有用な出力までが実装され、時間、労力、判断負担のどれをどう減らすかを、処理との因果関係で確認できる。単に実行できることや小さな便利さだけでは満たさない。数値ベンチマークは要求しない。`
  },
  {
    name: "impact_level_8",
    key: "impact",
    level: 8,
    question: "Does source implement practical aggregation or automation of multiple tasks, a mechanism substantially reducing repeated effort or mistakes, or a concrete mechanism reusable across different situations? Merely calling the same endpoint repeatedly is insufficient. Tests, production hardening, documentation, and commercial metrics are not prerequisites when the implementation and task establish the benefit.",
    description: `${SOURCE_EVIDENCE}実用的な複数処理の集約・自動化、反復時の負担や誤りを大きく減らす仕組み、または複数の利用場面で再利用する具体的な仕組みが実装されている。同じエンドポイントを繰り返し呼べるだけでは満たさない。実装と具体的な利用作業で支持できれば、テスト、README、本番向け堅牢化、商業指標は必須にしない。`
  },
  {
    name: "impact_level_10",
    key: "impact",
    level: 10,
    question: "Does source establish an exceptional improvement to a concrete user's workflow, such as making a previously impractical task possible or eliminating a large part of its steps or effort, while making the scope and limitations clear? Ordinary multi-step automation alone is insufficient; commercial metrics, numeric benchmarks, and observed adoption are not required.",
    description: `${SOURCE_EVIDENCE}従来は困難だった作業の実現や大幅な手順・労力の削減など、突出した作業改善を実装から検証でき、その適用範囲と限界も把握できる。導入実績、収益、外部ベンチマーク、数値による計測は要求しない。`,
    guidance: "Identify the concrete user workflow before and after this implementation and an exceptional improvement beyond ordinary aggregation, automation, or reusable helpers. Source must support making a previously impractical task possible or eliminating a large part of the workflow, along with its scope and limits. Ordinary multi-step automation alone meets the previous requirement, not automatically this additional one. No commercial metrics or numeric benchmark is required."
  },
  {
    name: "idea_level_2",
    key: "idea",
    level: 2,
    question: "Does source implement at least one product behavior that processes an input, user action, event, or data value according to a rule and produces a result, response, artifact, or state change? Conventional and novel solutions both qualify; prose, names, settings, unconditional NotImplemented errors, and nonprocessing placeholders alone do not.",
    description: `${SOURCE_EVIDENCE}入力、利用者の操作、イベント、データのいずれかを規則で処理して、結果、応答、成果物、状態変化のいずれかを生む実装がある。独自性や品質は問わず、慣例的な方法も独自の方法も満たす。未実装エラーや処理しない仮の結果だけでは満たさない。`,
    guidance: "At least one product behavior is implemented: an input, user action, event, or data value is processed by a rule and produces a result, response, artifact, or state change. Conventional AND novel solutions qualify. Test existence of implemented behavior only, not originality, quality, or whether the work deserves exactly 2 points. Prose, names, settings, unconditional NotImplemented errors and nonprocessing placeholders alone do not qualify."
  },
  {
    name: "idea_level_4",
    key: "idea",
    level: 4,
    question: "Does source implement a processing choice specific to its target task, such as interpreting inputs, updating task data or state, sequencing actions, applying domain rules, or constructing useful task results beyond an unchanged generic scaffold? A design built from scratch qualifies without a prior version, modification history, baseline, or novelty. Names and visual styling alone are insufficient.",
    description: `${SOURCE_EVIDENCE}対象作業に合わせた入力の解釈、データや状態の管理、処理順序、規則、結果の構築などが、単なる汎用デモや変更のないひな形を超えて実装されている。ゼロから設計した仕組みも満たし、旧版から変更した履歴や独自性は要求しない。名称や見た目だけでは満たさない。`,
    guidance: "There is at least one processing choice specific to the target task, such as interpreting input, updating task data or state, sequencing actions, applying domain rules, or constructing useful task results beyond an unchanged generic scaffold. A design built from scratch qualifies. No prior version, modification history, baseline or novelty is required. Names, themes and visual styling alone do not qualify."
  },
  {
    name: "idea_level_6",
    key: "idea",
    level: 6,
    question: "Does the core implementation contain a distinctive viewpoint, mechanism, or combination whose design choice can be connected to a benefit for its target user? Global uniqueness, world-first claims, and external searches are not required.",
    description: `${SOURCE_EVIDENCE}独自の着眼点、仕組み、組み合わせのいずれかを中核の実装で確認でき、その採用理由を利用者の便益に結びつけて説明できる。世界初であることや外部の類似例調査は要求しない。`
  },
  {
    name: "idea_level_8",
    key: "idea",
    level: 8,
    question: "Does the implementation use a design choice that addresses a concrete limitation of a simpler approach to this task? The simpler approach and its limitation may be inferred from clear code or examples; no previous version or global uniqueness proof is required.",
    description: `${SOURCE_EVIDENCE}より単純な方法が持つ具体的な限界と、それを解く設計上の選択を説明でき、その選択した仕組みが実装されている。外部の独自性調査は要求しない。`
  },
  {
    name: "idea_level_10",
    key: "idea",
    level: 10,
    question: "Does an implemented representative example or verification demonstrate a user benefit caused by the distinctive mechanism that resolves a simpler approach's limitation? Merely showing working code, routine request-response tests, or usefulness claims is insufficient. World-first status, external comparisons, numeric metrics, and live execution by the judge are not required.",
    description: `${SOURCE_EVIDENCE}実装された代表例または検証例から、独自の仕組みが原因となって生まれる利用者の便益を確認できる。宣伝文句や世界初の主張だけでは満たさず、世界初の証明や外部調査は要求しない。`,
    guidance: "Require a concrete implemented example or verification that demonstrates the user benefit caused by the distinctive mechanism resolving the simpler method's limitation. Merely describing working code, routine request/response tests, or stating that a feature is useful does not demonstrate this causal benefit. No world-first claim, external comparison, numeric metric or live execution by the judge is required."
  }
] as const satisfies ReadonlyArray<{
  name: `${CriterionKey}_level_${2 | 4 | 6 | 8 | 10}`;
  key: CriterionKey;
  level: 2 | 4 | 6 | 8 | 10;
  question: string;
  description: string;
  guidance?: string;
}>;

export function deriveConditionScores(conditions: Record<string, boolean>): {
  scores: Record<CriterionKey, number>;
  reviewRequired: boolean;
} {
  if (conditions === null || typeof conditions !== "object" || Array.isArray(conditions)) {
    throw new TypeError("Conditions must be an object containing exactly the 20 known boolean conditions.");
  }

  const ownKeys = Reflect.ownKeys(conditions);
  const knownNames = new Set<string>(DECISION_CONDITIONS.map(({ name }) => name));
  if (
    ownKeys.length !== DECISION_CONDITIONS.length ||
    ownKeys.some((key) => typeof key !== "string" || !knownNames.has(key)) ||
    DECISION_CONDITIONS.some(({ name }) =>
      !Object.prototype.hasOwnProperty.call(conditions, name) || typeof conditions[name] !== "boolean"
    )
  ) {
    throw new TypeError("Conditions must contain exactly the 20 known own keys with boolean values.");
  }

  const scores: Record<CriterionKey, number> = { technical: 0, ux: 0, impact: 0, idea: 0 };
  const failed: Record<CriterionKey, boolean> = { technical: false, ux: false, impact: false, idea: false };
  let reviewRequired = false;

  for (const { name, key, level } of DECISION_CONDITIONS) {
    if (!conditions[name]) {
      failed[key] = true;
    } else if (failed[key]) {
      reviewRequired = true;
    } else {
      scores[key] = level;
    }
  }

  return { scores, reviewRequired };
}
