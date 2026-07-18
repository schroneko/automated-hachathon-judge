import type { RepoEvidenceFile } from "./types";

const SIGNALS: Array<{ points: number; patterns: RegExp[] }> = [
  {
    points: 50,
    patterns: [
      /\b(?:ignore|disregard|forget|override)\b.{0,80}\b(?:previous|prior|above|system|developer)\b.{0,40}\b(?:instruction|message|prompt)s?\b/is,
      /\b(?:previous|prior|above|system|developer)\b.{0,40}\b(?:instruction|message|prompt)s?\b.{0,80}\b(?:ignore|disregard|forget|override)\b/is,
      /(?:以前|これまで|上記|システム|開発者).{0,40}(?:指示|命令|プロンプト).{0,40}(?:無視|忘れ|上書き)/su
    ]
  },
  {
    points: 35,
    patterns: [
      /\b(?:give|award|assign|set)\b.{0,100}(?:perfect\s+score|full\s+points?|maximum\s+score|max\s+score|10\s*\/\s*10|40\s*\/\s*40|100\s*\/\s*100)/is,
      /(?:満点|10\s*点|40\s*点|100\s*点).{0,60}(?:付け|与え|評価|採点|スコア)/su,
      /(?:スコア|点数|評価|採点).{0,60}(?:満点|最大|10\s*点|40\s*点|100\s*点)/su
    ]
  },
  {
    points: 20,
    patterns: [
      /(?:<system>|\[system\]|system\s+message|developer\s+message)/i,
      /\byou\s+are\s+now\b.{0,80}\b(?:judge|grader|assistant|system)\b/is,
      /あなたは.{0,60}(?:ジャッジ|審査員|採点者|システム)/su
    ]
  },
  {
    points: 30,
    patterns: [
      /\b(?:reveal|show|print|expose|leak)\b.{0,100}\b(?:system\s+prompt|secret|environment\s+variable|api\s+key|token)\b/is,
      /(?:システムプロンプト|秘密|環境変数|APIキー|トークン).{0,60}(?:表示|出力|公開|送信|漏洩)/su
    ]
  },
  {
    points: 25,
    patterns: [
      /\b(?:decode|decrypt)\b.{0,60}\b(?:base64|hex)\b.{0,80}\b(?:follow|execute|obey|instruction)s?\b/is,
      /(?:base64|hex).{0,60}(?:デコード|復号).{0,60}(?:従え|実行|指示)/isu
    ]
  }
];

export function calculateNukoScore(files: RepoEvidenceFile[]): number {
  const content = files.map((file) => file.content).join("\n").normalize("NFKC");
  const score = SIGNALS.reduce(
    (total, signal) => total + (signal.patterns.some((pattern) => pattern.test(content)) ? signal.points : 0),
    0
  );
  return Math.min(100, score);
}

export function visibleNukoScore(score: number): number | null {
  return score >= 80 ? score : null;
}
