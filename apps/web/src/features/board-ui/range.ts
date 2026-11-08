// レス範囲 URL の解釈（open2ch の read.cgi 作法をクエリに写像 / DESIGN §A-2）。
// `?r=l50` | `1-100` | `n` | `3,4,8` | `images`

export type RangeSpec =
  | { kind: "last"; count: number }
  | { kind: "range"; from: number; to: number }
  | { kind: "nums"; nums: number[] }
  | { kind: "images" };

const MAX_COUNT = 1000;

export function parseRange(raw: string | null | undefined): RangeSpec {
  if (!raw) {
    return { kind: "last", count: 50 };
  }
  const value = raw.trim();
  if (value === "images") {
    return { kind: "images" };
  }
  if (value === "n" || value === "all") {
    return { kind: "last", count: MAX_COUNT };
  }
  const last = value.match(/^l(\d+)$/);
  if (last) {
    const count = Math.min(MAX_COUNT, Math.max(1, Number(last[1])));
    return { kind: "last", count };
  }
  const range = value.match(/^(\d+)-(\d*)$/);
  if (range) {
    const from = Math.max(1, Number(range[1]));
    const to = range[2] ? Math.max(from, Number(range[2])) : from + 99;
    return { kind: "range", from, to: Math.min(to, from + MAX_COUNT - 1) };
  }
  const single = value.match(/^(\d+)$/);
  if (single) {
    const num = Math.max(1, Number(single[1]));
    return { kind: "range", from: num, to: num };
  }
  if (/^\d+(,\d+)+$/.test(value)) {
    const nums = value
      .split(",")
      .map((part) => Number(part))
      .filter((num) => Number.isFinite(num) && num > 0)
      .slice(0, 100);
    if (nums.length > 0) {
      return { kind: "nums", nums };
    }
  }
  return { kind: "last", count: 50 };
}

/** API の `?r=` に渡す文字列。 */
export function rangeQuery(spec: RangeSpec): string {
  switch (spec.kind) {
    case "last":
      return `l${spec.count}`;
    case "range":
      return spec.from === spec.to ? `${spec.from}` : `${spec.from}-${spec.to}`;
    case "nums":
      return spec.nums.join(",");
    case "images":
      return "images";
  }
}

export function rangeLabel(spec: RangeSpec): string {
  switch (spec.kind) {
    case "last":
      return spec.count >= MAX_COUNT ? "全部" : `最新${spec.count}`;
    case "range":
      return spec.from === spec.to ? `${spec.from}` : `${spec.from}-${spec.to}`;
    case "nums":
      return spec.nums.join(",");
    case "images":
      return "画像一覧";
  }
}

/** 100 レス刻みのページ送りリンク（現在位置を考慮）。 */
export function pageLinks(total: number, spec: RangeSpec): { label: string; r: string }[] {
  const perPage = 100;
  const pages = Math.max(1, Math.min(20, Math.ceil(total / perPage)));
  const currentFrom = spec.kind === "range" ? spec.from : Infinity;
  const links: { label: string; r: string }[] = [];
  for (let index = 0; index < pages; index += 1) {
    const from = index * perPage + 1;
    const to = Math.min(total, from + perPage - 1);
    const active = currentFrom >= from && currentFrom <= to;
    links.push({ label: active ? `[${from}-]` : `${from}-`, r: `${from}-${to}` });
  }
  return links;
}