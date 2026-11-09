// 宣言的レンダー規則（manifest.render.post）の正規表現の安全性判定（ReDoS 対策）。
// 公開申請・審査の静的検査（API）と、閲覧者のブラウザで実行するホスト（web）の両方が
// この 1 実装を使う。判定は「実行して時間を測る」のではなく、正規表現ソースを構文解析して
// 破滅的バックトラックを起こす形（入れ子の量指定子・重なる選択肢の繰り返し・後方参照・
// 過大な長さ・過大な繰り返し回数）を静的に検出する。ブラウザのメインスレッドを
// ブロックする前に拒否できるため、判定自体が攻撃面にならない。

/** 受理する正規表現ソースの最大文字数。 */
export const REGEX_PATTERN_MAX_LENGTH = 200;

/** `{m,n}` の上限（これを超える回数指定は拒否する）。 */
export const REGEX_MAX_REPEAT_BOUND = 1000;

export interface RegexSafetyResult {
  safe: boolean;
  /** safe=false のときの理由（利用者向けメッセージ）。 */
  reason?: string;
}

type AtomKind = "literal" | "class" | "dot" | "shorthand" | "anchor" | "backref";

interface Quantifier {
  min: number;
  /** null = 上限なし（`*` / `+` / `{m,}`）。 */
  max: number | null;
}

type Node =
  | { type: "seq"; items: Node[] }
  | { type: "alt"; options: Node[] }
  | { type: "group"; body: Node; quantifier: Quantifier | null; kind: "capture" | "noncapture" | "lookaround" }
  | { type: "atom"; atom: AtomKind; value: string; quantifier: Quantifier | null };

const SHORTHAND: Record<string, true> = { d: true, D: true, w: true, W: true, s: true, S: true };

/** 正規表現ソースの簡易パーサ。グループ・選択・文字クラス・量指定子だけを扱う。 */
class RegexParser {
  private index = 0;

  constructor(private readonly source: string) {}

  parse(): Node {
    const node = this.parseAlternation();
    if (this.index < this.source.length) {
      // 閉じ括弧の対応が取れていない等。安全側に倒す。
      throw new Error("unexpected token");
    }
    return node;
  }

  private peek(offset = 0): string | undefined {
    return this.source[this.index + offset];
  }

  private parseAlternation(): Node {
    const options: Node[] = [this.parseSequence()];
    while (this.peek() === "|") {
      this.index += 1;
      options.push(this.parseSequence());
    }
    return options.length === 1 ? options[0]! : { type: "alt", options };
  }

  private parseSequence(): Node {
    const items: Node[] = [];
    while (this.index < this.source.length) {
      const char = this.peek();
      if (char === "|" || char === ")") break;
      items.push(this.parseAtom());
    }
    return { type: "seq", items };
  }

  private parseAtom(): Node {
    const char = this.peek();
    if (char === undefined) throw new Error("unexpected end");

    // グループ
    if (char === "(") {
      this.index += 1;
      let kind: "capture" | "noncapture" | "lookaround" = "capture";
      if (this.peek() === "?") {
        this.index += 1;
        const marker = this.peek();
        if (marker === ":") {
          kind = "noncapture";
          this.index += 1;
        } else if (marker === "=" || marker === "!") {
          kind = "lookaround";
          this.index += 1;
        } else if (marker === "<") {
          this.index += 1;
          const after = this.peek();
          if (after === "=" || after === "!") {
            kind = "lookaround";
            this.index += 1;
          } else {
            // 名前付きキャプチャ `(?<name>...)`。名前は読み飛ばす。
            while (this.index < this.source.length && this.peek() !== ">") this.index += 1;
            if (this.peek() === ">") this.index += 1;
          }
        }
        // その他の `(?...)` は本文として読み進める（未対応の拡張は安全側で解析継続）。
      }
      const body = this.parseAlternation();
      if (this.peek() === ")") this.index += 1;
      const quantifier = this.parseQuantifier();
      return { type: "group", body, quantifier, kind };
    }

    // 文字クラス
    if (char === "[") {
      this.index += 1;
      let value = "[";
      if (this.peek() === "^") {
        value += "^";
        this.index += 1;
      }
      if (this.peek() === "]") {
        // `[]` は空クラス（JS では一致しない）。最初の `]` はリテラル扱い。
        value += "]";
        this.index += 1;
      }
      while (this.index < this.source.length) {
        const current = this.peek()!;
        if (current === "\\") {
          value += current + (this.peek(1) ?? "");
          this.index += 2;
          continue;
        }
        value += current;
        this.index += 1;
        if (current === "]") break;
      }
      return { type: "atom", atom: "class", value, quantifier: this.parseQuantifier() };
    }

    // エスケープ
    if (char === "\\") {
      this.index += 1;
      const escaped = this.peek();
      if (escaped === undefined) {
        return { type: "atom", atom: "literal", value: "\\", quantifier: this.parseQuantifier() };
      }
      if (escaped >= "1" && escaped <= "9") {
        this.index += 1;
        return { type: "atom", atom: "backref", value: `\\${escaped}`, quantifier: this.parseQuantifier() };
      }
      if (escaped === "k" && this.peek(1) === "<") {
        this.index += 2;
        while (this.index < this.source.length && this.peek() !== ">") this.index += 1;
        if (this.peek() === ">") this.index += 1;
        return { type: "atom", atom: "backref", value: "\\k", quantifier: this.parseQuantifier() };
      }
      this.index += 1;
      if (escaped === "b" || escaped === "B") {
        return { type: "atom", atom: "anchor", value: `\\${escaped}`, quantifier: this.parseQuantifier() };
      }
      if (SHORTHAND[escaped]) {
        return { type: "atom", atom: "shorthand", value: `\\${escaped}`, quantifier: this.parseQuantifier() };
      }
      return { type: "atom", atom: "literal", value: escaped, quantifier: this.parseQuantifier() };
    }

    // 位置指定子・任意文字
    if (char === "^" || char === "$") {
      this.index += 1;
      return { type: "atom", atom: "anchor", value: char, quantifier: null };
    }
    if (char === ".") {
      this.index += 1;
      return { type: "atom", atom: "dot", value: ".", quantifier: this.parseQuantifier() };
    }

    // 上記以外は 1 文字リテラル（`{` `}` `]` `*` `+` `?` の孤立した出現も含む）。
    this.index += 1;
    return { type: "atom", atom: "literal", value: char, quantifier: this.parseQuantifier() };
  }

  private parseQuantifier(): Quantifier | null {
    const char = this.peek();
    if (char === "*") {
      this.index += 1;
      this.consumeLazy();
      return { min: 0, max: null };
    }
    if (char === "+") {
      this.index += 1;
      this.consumeLazy();
      return { min: 1, max: null };
    }
    if (char === "?") {
      this.index += 1;
      this.consumeLazy();
      return { min: 0, max: 1 };
    }
    if (char === "{") {
      const match = /^\{(\d+)(?:,(\d*))?\}/.exec(this.source.slice(this.index));
      if (!match) return null;
      this.index += match[0].length;
      this.consumeLazy();
      const min = Number(match[1]);
      const max = match[2] === undefined ? min : match[2] === "" ? null : Number(match[2]);
      return { min, max };
    }
    return null;
  }

  private consumeLazy(): void {
    if (this.peek() === "?") this.index += 1;
  }
}

function isVariable(quantifier: Quantifier | null): boolean {
  return quantifier !== null && quantifier.max !== quantifier.min;
}

function isRepeated(quantifier: Quantifier | null): boolean {
  return quantifier !== null && (quantifier.max === null || quantifier.max > 1);
}

/** 空文字列に一致し得るか（nullable）。 */
function nullable(node: Node): boolean {
  switch (node.type) {
    case "seq":
      return node.items.every(nullable);
    case "alt":
      return node.options.some(nullable);
    case "group":
      return node.quantifier?.min === 0 || nullable(node.body);
    case "atom":
      if (node.atom === "anchor") return true;
      if (node.atom === "backref") return true;
      return node.quantifier !== null && node.quantifier.min === 0;
  }
}

/** 文字を消費しないノード（位置指定子・先読み/後読み）。 */
function isZeroWidth(node: Node): boolean {
  return (node.type === "atom" && node.atom === "anchor") || (node.type === "group" && node.kind === "lookaround");
}

/**
 * ノード（シーケンス）が可変長の要素で終わるか。
 * 例: `a+` → true、`(a+)` → true、`\.` → false、`(a|b)` → false。
 */
function endsWithVariable(node: Node): boolean {
  switch (node.type) {
    case "alt":
      return node.options.some(endsWithVariable);
    case "group":
      return isVariable(node.quantifier) || endsWithVariable(node.body);
    case "atom":
      return node.atom !== "anchor" && isVariable(node.quantifier);
    case "seq": {
      for (let i = node.items.length - 1; i >= 0; i -= 1) {
        const item = node.items[i]!;
        // 位置指定子・先読みは文字を消費しないので読み飛ばす。
        if (isZeroWidth(item)) continue;
        return endsWithVariable(item);
      }
      return false;
    }
  }
}


/** 長さが固定でない（可変長の）要素か。 */
function canVaryLength(node: Node): boolean {
  switch (node.type) {
    case "atom":
      return node.atom !== "anchor" && isVariable(node.quantifier);
    case "group":
      if (node.kind === "lookaround") return false;
      return isVariable(node.quantifier) || canVaryLength(node.body);
    case "alt":
      return node.options.some(canVaryLength);
    case "seq":
      return node.items.some(canVaryLength);
  }
}

/** 量指定子の無い透過的なグループ・1 要素の並びを剥がして実体を見る。 */
function unwrapSingle(node: Node): Node {
  if (node.type === "seq" && node.items.length === 1) return unwrapSingle(node.items[0]!);
  if (node.type === "group" && node.quantifier === null && node.kind !== "lookaround") return unwrapSingle(node.body);
  return node;
}

/**
 * 繰り返されるグループの本体が「2 要素以上の並び」で、そのいずれかが可変長か。
 * `(a+[ab])+` のように、量指定子と重なり得る文字の並びが繰り返される形は
 * 破滅的バックトラックになる（固定長だけの `(abc)+` は許可する）。
 */
function hasVariableInMultiElementSequence(node: Node): boolean {
  const target = unwrapSingle(node);
  if (target.type === "alt") return target.options.some(hasVariableInMultiElementSequence);
  if (target.type !== "seq") return false;
  const consuming = target.items.filter((item) => !isZeroWidth(item));
  return consuming.length >= 2 && consuming.some(canVaryLength);
}

/** 選択肢の先頭から決定的に読めるトークン列（判定できない部分は null）。 */
function prefixTokens(node: Node): string[] | null {
  switch (node.type) {
    case "atom": {
      if (node.atom === "anchor") return [];
      if (node.atom === "backref") return null;
      return [atomToken(node)];
    }
    case "group": {
      if (node.kind === "lookaround") return [];
      return prefixTokens(node.body);
    }
    case "alt":
      return null;
    case "seq": {
      const tokens: string[] = [];
      for (const item of node.items) {
        const part = prefixTokens(item);
        if (part === null) return tokens.length > 0 ? tokens : null;
        tokens.push(...part);
        if (item.type === "atom" && isVariable(item.quantifier)) break;
        if (item.type === "group" && isVariable(item.quantifier)) break;
      }
      return tokens;
    }
  }
}

function atomToken(node: Extract<Node, { type: "atom" }>): string {
  switch (node.atom) {
    case "literal":
      return `l:${node.value}`;
    case "shorthand":
      return `s:${node.value}`;
    case "class":
      return `c:${node.value}`;
    case "dot":
      return "d:.";
    default:
      return "z:";
  }
}

/** 量指定子付きの繰り返しグループで、選択肢が重なる（同じ文字列を複数の経路で受理できる）か。 */
function overlappingAlternation(options: readonly Node[]): boolean {
  if (options.length < 2) return false;
  const sigs = options.map(prefixTokens);
  for (let i = 0; i < sigs.length; i += 1) {
    const left = sigs[i];
    if (!left) continue;
    for (let j = i + 1; j < sigs.length; j += 1) {
      const right = sigs[j];
      if (!right) continue;
      if (left.length === 0 || right.length === 0) return true; // 空に一致する選択肢
      if (left.join("\u0000") === right.join("\u0000")) return true;
      const shorter = left.length <= right.length ? left : right;
      const longer = left.length <= right.length ? right : left;
      if (shorter.every((token, index) => token === longer[index])) return true;
      const leftKind = left[0]!.slice(0, 2);
      const rightKind = right[0]!.slice(0, 2);
      if (leftKind === "d:" || rightKind === "d:") return true;
      if ((leftKind === "c:" || leftKind === "s:") && (rightKind === "c:" || rightKind === "s:")) return true;
    }
  }
  return false;
}

function checkRepeatBound(quantifier: Quantifier | null): boolean {
  if (!quantifier) return true;
  if (quantifier.min > REGEX_MAX_REPEAT_BOUND) return false;
  if (quantifier.max !== null && quantifier.max > REGEX_MAX_REPEAT_BOUND) return false;
  return true;
}

/** ノード木を検査し、危険な形があれば理由を返す。 */
function checkNode(node: Node): string | null {
  switch (node.type) {
    case "seq": {
      for (const item of node.items) {
        const reason = checkNode(item);
        if (reason) return reason;
      }
      return null;
    }
    case "alt": {
      for (const option of node.options) {
        const reason = checkNode(option);
        if (reason) return reason;
      }
      return null;
    }
    case "atom": {
      if (node.atom === "backref") return "後方参照（\\1 や \\k<name>）は使用できません";
      if (!checkRepeatBound(node.quantifier)) return `繰り返し回数が上限（${REGEX_MAX_REPEAT_BOUND}）を超えています`;
      return null;
    }
    case "group": {
      if (!checkRepeatBound(node.quantifier)) return `繰り返し回数が上限（${REGEX_MAX_REPEAT_BOUND}）を超えています`;
      if (isRepeated(node.quantifier)) {
        if (nullable(node.body)) {
          return "空文字に一致し得るグループの繰り返し（例: (a*)+）は使用できません";
        }
        if (node.body.type === "alt" && overlappingAlternation(node.body.options)) {
          return "重なる選択肢の繰り返し（例: (a|aa)+）は使用できません";
        }
        if (endsWithVariable(node.body)) {
          return "入れ子の量指定子（例: (a+)+）は使用できません";
        }
        if (hasVariableInMultiElementSequence(node.body)) {
          return "可変長の要素を含む並びの繰り返し（例: (a+[ab])+）は使用できません";
        }
      }
      return checkNode(node.body);
    }
  }
}

/**
 * 正規表現ソースが破滅的バックトラックを起こし得るかを判定する。
 * 安全側（疑わしきは拒否）に倒す。公式サンプル（spoiler の
 * `\[spoiler\]([\s\S]*?)\[/spoiler\]` 等）は通る。
 */
export function analyzeRegexPattern(pattern: string): RegexSafetyResult {
  if (typeof pattern !== "string" || pattern.length === 0) {
    return { safe: false, reason: "正規表現が空です" };
  }
  if (pattern.length > REGEX_PATTERN_MAX_LENGTH) {
    return { safe: false, reason: `正規表現が長すぎます（${REGEX_PATTERN_MAX_LENGTH} 文字まで）` };
  }

  let ast: Node;
  try {
    ast = new RegexParser(pattern).parse();
  } catch {
    return { safe: false, reason: "正規表現を解析できませんでした（括弧の対応などを見直してください）" };
  }

  const reason = checkNode(ast);
  return reason ? { safe: false, reason } : { safe: true };
}