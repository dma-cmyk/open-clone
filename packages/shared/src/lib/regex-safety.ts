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

/** 固定回数の量指定子（`{n}` / `{n,n}`）か。 */
function isFixedCount(quantifier: Quantifier): boolean {
  return quantifier.max !== null && quantifier.min === quantifier.max;
}

/**
 * 繰り返されるグループの本体に置けない要素を探す（報告書 24 第3回 M-3）。
 * - lookaround（先読み・後読み）は一切置けない（中に可変長を隠せるため）
 * - `{n}` の固定回数以外の量指定子（`*`・`+`・`?`・`{n,}`・`{n,m}`）は一切置けない
 * 入れ子の深さに関係なく本体全体を走査する。固定長の `(abc)+`・`(?:\d{2}:)+` は通る。
 */
function findForbiddenInRepeatedBody(node: Node): string | null {
  switch (node.type) {
    case "atom":
      if (node.quantifier && !isFixedCount(node.quantifier)) {
        return "繰り返すグループの本体に可変長の量指定子（*・+・?・{n,}・{n,m}）は使用できません";
      }
      return null;
    case "group": {
      if (node.kind === "lookaround") {
        return "繰り返すグループの本体に先読み・後読み（lookaround）は使用できません";
      }
      if (node.quantifier && !isFixedCount(node.quantifier)) {
        return "繰り返すグループの本体に可変長の量指定子（*・+・?・{n,}・{n,m}）は使用できません";
      }
      return findForbiddenInRepeatedBody(node.body);
    }
    case "alt":
    case "seq": {
      const items = node.type === "alt" ? node.options : node.items;
      for (const item of items) {
        const reason = findForbiddenInRepeatedBody(item);
        if (reason) return reason;
      }
      return null;
    }
  }
}

/**
 * 先頭 1 文字の集合。`chars` は ASCII の代表文字（Universe）で判定し、
 * `any` は「Universe 外の文字にも一致し得る」ことを表す（交差判定では保守的に扱う）。
 */
interface FirstChars {
  any: boolean;
  chars: Set<string>;
}

const DIGIT_CHARS = "0123456789";
const WORD_CHARS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789_";
const SPACE_CHARS = " \t\n\r\f\v";

/** 交差判定に使う代表文字（ASCII の印字可能文字 + 空白）。 */
const UNIVERSE = new Set<string>([
  ...Array.from({ length: 95 }, (_, index) => String.fromCharCode(32 + index)),
  "\t",
  "\n",
  "\r",
  "\f",
  "\v",
]);

function anyFirstChars(): FirstChars {
  return { any: true, chars: new Set(UNIVERSE) };
}

function onlyChars(chars: Iterable<string>): FirstChars {
  return { any: false, chars: new Set(chars) };
}

/** 補集合（`\D`・`\W`・`\S`・否定クラス）。Universe 外にも一致し得るので any=true。 */
function complementChars(chars: ReadonlySet<string>): FirstChars {
  const result = new Set<string>();
  for (const char of UNIVERSE) {
    if (!chars.has(char)) result.add(char);
  }
  return { any: true, chars: result };
}

function unionFirstChars(left: FirstChars, right: FirstChars): FirstChars {
  const chars = new Set(left.chars);
  for (const char of right.chars) chars.add(char);
  return { any: left.any || right.any, chars };
}

function shorthandFirstChars(shorthand: string): FirstChars {
  if (shorthand === "d") return onlyChars(DIGIT_CHARS);
  if (shorthand === "w") return onlyChars(WORD_CHARS);
  if (shorthand === "s") return onlyChars(SPACE_CHARS);
  if (shorthand === "D") return complementChars(new Set(DIGIT_CHARS));
  if (shorthand === "W") return complementChars(new Set(WORD_CHARS));
  if (shorthand === "S") return complementChars(new Set(SPACE_CHARS));
  return anyFirstChars();
}

/** 文字クラス `[...]` の先頭 1 文字集合を求める（判定不能なら any）。 */
function parseClassFirstChars(raw: string): FirstChars {
  const negated = raw.startsWith("[^");
  const inner = raw.slice(negated ? 2 : 1, raw.endsWith("]") ? -1 : undefined);
  let result = onlyChars([]);
  let unknown = false;
  let index = 0;

  const addChars = (chars: Iterable<string>): void => {
    result = unionFirstChars(result, onlyChars(chars));
  };

  while (index < inner.length) {
    const char = inner[index]!;
    if (char === "\\") {
      const next = inner[index + 1];
      if (next === undefined) return anyFirstChars();
      if (next === "d" || next === "w" || next === "s") {
        addChars(shorthandFirstChars(next).chars);
        index += 2;
        continue;
      }
      if (next === "D" || next === "W" || next === "S") {
        result = unionFirstChars(result, shorthandFirstChars(next));
        index += 2;
        continue;
      }
      if (next === "t") {
        addChars(["\t"]);
        index += 2;
        continue;
      }
      if (next === "n") {
        addChars(["\n"]);
        index += 2;
        continue;
      }
      if (next === "r") {
        addChars(["\r"]);
        index += 2;
        continue;
      }
      if (next === "f") {
        addChars(["\f"]);
        index += 2;
        continue;
      }
      if (next === "v") {
        addChars(["\v"]);
        index += 2;
        continue;
      }
      if (next === "b" || next === "x" || next === "u" || next === "p" || next === "P" || next === "0") {
        unknown = true;
        break;
      }
      addChars([next]);
      index += 2;
      continue;
    }

    const next = inner[index + 1];
    const rangeEnd = inner[index + 2];
    if (next === "-" && rangeEnd !== undefined && rangeEnd !== "]") {
      const startCode = char.codePointAt(0)!;
      const endCode = rangeEnd.codePointAt(0)!;
      if (endCode < startCode || endCode - startCode > 128) {
        unknown = true;
        break;
      }
      const range: string[] = [];
      for (let code = startCode; code <= endCode; code += 1) range.push(String.fromCodePoint(code));
      addChars(range);
      index += 3;
      continue;
    }

    addChars([char]);
    index += 1;
  }

  if (unknown) return anyFirstChars();
  return negated ? complementChars(result.chars) : result;
}

/** ノードが最初に消費し得る 1 文字の集合。 */
function firstCharsOf(node: Node): FirstChars {
  switch (node.type) {
    case "atom":
      switch (node.atom) {
        case "anchor":
          return onlyChars([]);
        case "backref":
        case "dot":
          return anyFirstChars();
        case "shorthand":
          return shorthandFirstChars(node.value[1] ?? "");
        case "class":
          return parseClassFirstChars(node.value);
        case "literal":
          return node.value.length === 1 ? onlyChars(node.value) : anyFirstChars();
      }
    case "group":
      return firstCharsOf(node.body);
    case "alt": {
      let result = onlyChars([]);
      for (const option of node.options) result = unionFirstChars(result, firstCharsOf(option));
      return result;
    }
    case "seq": {
      let result = onlyChars([]);
      for (const item of node.items) {
        if (isZeroWidth(item)) continue;
        result = unionFirstChars(result, firstCharsOf(item));
        if (!nullable(item)) break;
      }
      return result;
    }
  }
}

/**
 * 2 つの先頭文字集合が交差するか。`ignoreCase`（`i` フラグ）のときは大文字小文字を
 * 同一視する（`a` と `A` が重なる）。
 */
function firstCharsOverlap(left: FirstChars, right: FirstChars, ignoreCase = false): boolean {
  const hasOutside = (chars: ReadonlySet<string>): boolean => {
    for (const char of chars) {
      if (!UNIVERSE.has(char)) return true;
    }
    return false;
  };

  if (left.any && right.any) return true;
  // any 側は Universe 外の全文字に一致し得る。相手が Universe 外の文字を持つなら交差する。
  if (left.any && hasOutside(right.chars)) return true;
  if (right.any && hasOutside(left.chars)) return true;
  for (const char of left.chars) {
    if (right.chars.has(char)) return true;
    if (ignoreCase) {
      const lower = char.toLowerCase();
      const upper = char.toUpperCase();
      if (right.chars.has(lower) || right.chars.has(upper)) return true;
    }
  }
  return false;
}

/** 文字を消費しないノード（位置指定子・先読み/後読み）。 */
function isZeroWidth(node: Node): boolean {
  return (node.type === "atom" && node.atom === "anchor") || (node.type === "group" && node.kind === "lookaround");
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

/**
 * 同じ並びに可変長の要素が 2 つ以上あり、境界が曖昧でないか（第3回 M-3）。
 * 例: `\w+[a-z]+`・`a+a+`・`.*\s*` は曖昧。`\d+\.\d+`・`\w+\s+\w+` は
 * 間に「どちらとも重ならない」要素があるため境界が決まる（許可）。
 */
function hasAmbiguousVariableSequence(items: readonly Node[], ignoreCase = false): boolean {
  const consuming = items.filter((item) => !isZeroWidth(item));
  const variables: { index: number; first: FirstChars }[] = [];
  consuming.forEach((item, index) => {
    if (canVaryLength(item)) variables.push({ index, first: firstCharsOf(item) });
  });

  for (let i = 0; i < variables.length; i += 1) {
    for (let j = i + 1; j < variables.length; j += 1) {
      const left = variables[i]!;
      const right = variables[j]!;
      if (!firstCharsOverlap(left.first, right.first, ignoreCase)) continue;
      let separated = false;
      for (let k = left.index + 1; k < right.index; k += 1) {
        const between = consuming[k]!;
        if (nullable(between)) continue;
        const first = firstCharsOf(between);
        if (
          !firstCharsOverlap(first, left.first, ignoreCase) &&
          !firstCharsOverlap(first, right.first, ignoreCase)
        ) {
          separated = true;
          break;
        }
      }
      if (!separated) return true;
    }
  }
  return false;
}

/** 本体に固定回数以外の量指定子があれば理由を返す（lookaround 用）。 */
function findVariableQuantifier(node: Node): string | null {
  switch (node.type) {
    case "atom":
      return node.quantifier && !isFixedCount(node.quantifier)
        ? "lookaround の本体に可変長の量指定子（*・+・?・{n,}・{n,m}）は使用できません"
        : null;
    case "group": {
      if (node.quantifier && !isFixedCount(node.quantifier)) {
        return "lookaround の本体に可変長の量指定子（*・+・?・{n,}・{n,m}）は使用できません";
      }
      return findVariableQuantifier(node.body);
    }
    case "alt":
    case "seq": {
      const items = node.type === "alt" ? node.options : node.items;
      for (const item of items) {
        const reason = findVariableQuantifier(item);
        if (reason) return reason;
      }
      return null;
    }
  }
}

/**
 * 選択肢の先頭に来うる文字集合が交差するか（報告書 24 第4回 M-4）。
 * 1 組でも交差すれば「重なる選択肢」とみなす（安全側）。
 */
function overlappingAlternation(options: readonly Node[], ignoreCase = false): boolean {
  const sets = options.map(firstCharsOf);
  for (let i = 0; i < sets.length; i += 1) {
    for (let j = i + 1; j < sets.length; j += 1) {
      if (firstCharsOverlap(sets[i]!, sets[j]!, ignoreCase)) return true;
    }
  }
  return false;
}

/** 繰り返すグループの本体に、先頭文字集合が交差する選択肢 `|` があるか。 */
function hasOverlappingAlternation(node: Node, ignoreCase = false): boolean {
  switch (node.type) {
    case "alt":
      return (
        overlappingAlternation(node.options, ignoreCase) ||
        node.options.some((option) => hasOverlappingAlternation(option, ignoreCase))
      );
    case "seq":
      return node.items.some((item) => hasOverlappingAlternation(item, ignoreCase));
    case "group":
      return hasOverlappingAlternation(node.body, ignoreCase);
    case "atom":
      return false;
  }
}

function checkRepeatBound(quantifier: Quantifier | null): boolean {
  if (!quantifier) return true;
  if (quantifier.min > REGEX_MAX_REPEAT_BOUND) return false;
  if (quantifier.max !== null && quantifier.max > REGEX_MAX_REPEAT_BOUND) return false;
  return true;
}

/** ノード木を検査し、危険な形があれば理由を返す（`ignoreCase` は `i` フラグ）。 */
function checkNode(node: Node, ignoreCase = false): string | null {
  switch (node.type) {
    case "seq": {
      for (const item of node.items) {
        const reason = checkNode(item, ignoreCase);
        if (reason) return reason;
      }
      if (hasAmbiguousVariableSequence(node.items, ignoreCase)) {
        return "可変長の量指定子の並びが曖昧です（例: \\w+[a-z]+）";
      }
      return null;
    }
    case "alt": {
      for (const option of node.options) {
        const reason = checkNode(option, ignoreCase);
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
      if (node.kind === "lookaround") {
        // 可変長の lookaround は外側のバックトラックで繰り返し評価され得る（第3回 M-3）。
        const reason = findVariableQuantifier(node.body);
        if (reason) return reason;
      }
      if (isRepeated(node.quantifier)) {
        // 種類ごとの禁止（第3回 M-3）: 本体に lookaround と固定回数以外の量指定子を置けない。
        const forbidden = findForbiddenInRepeatedBody(node.body);
        if (forbidden) return forbidden;
        if (nullable(node.body)) {
          return "空文字に一致し得るグループの繰り返し（例: (a*)+）は使用できません";
        }
        if (hasOverlappingAlternation(node.body, ignoreCase)) {
          return "重なる選択肢の繰り返し（例: (a|aa)+）は使用できません";
        }
      }
      return checkNode(node.body, ignoreCase);
    }
  }
}

/**
 * 正規表現ソースが破滅的バックトラックを起こし得るかを判定する。
 * 安全側（疑わしきは拒否）に倒す。公式サンプル（spoiler の
 * `\[spoiler\]([\s\S]*?)\[/spoiler\]` 等）は通る。
 */
export function analyzeRegexPattern(pattern: string, flags = ""): RegexSafetyResult {
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

  const reason = checkNode(ast, flags.includes("i"));
  return reason ? { safe: false, reason } : { safe: true };
}