import { describe, expect, it } from "vitest";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { decodeEntities, findHelpSection, htmlToText, matchesHelp, parseHelpSections } from "./help-source";

/** `Section` 部品が作る形（help-view.tsx）を写した最小の HTML。 */
const SECTION_HTML = [
  '<div class="oc-stack">',
  '<section id="basics" class="oc-panel" style="scroll-margin-top:56px">',
  '<h2 class="oc-panel-title" style="margin:0"><span>掲示板の基本（板・スレ・レス）</span></h2>',
  '<div class="oc-panel-inner oc-stack" style="gap:6px">',
  "<p>板は話題の分野ごとの集まり（URL は <code>/b/板スラッグ</code>）です。<br>スレは板の中の話題1つ。</p>",
  "<ul><li>レス番号は 1 から</li><li>&amp;lt;b&amp;gt; は文字として出る</li></ul>",
  "</div>",
  "</section>",
  '<section id="pet" class="oc-panel">',
  "<h2 class=\"oc-panel-title\"><span>AI ペット（あとから足された節）</span></h2>",
  "<p>右下のペットから使い方を聞けます。</p>",
  "</section>",
  "</div>",
].join("");

describe("htmlToText", () => {
  it("段落・箇条書きを読みやすい文字にする", () => {
    expect(htmlToText("<p>あ<br>い</p><ul><li>う</li><li>え</li></ul>")).toBe("あ\nい\n・う\n・え");
  });

  it("style の中身は捨てる（TourList の CSS が混ざらない）", () => {
    expect(htmlToText('<style>.x{color:red}</style><p>本文</p>')).toBe("本文");
  });
});

describe("decodeEntities", () => {
  it("名前付き・数値の実体参照を戻す", () => {
    expect(decodeEntities("&lt;b&gt; &amp; &#39;x&#39; &#x3042;&nbsp;")).toBe("<b> & 'x' あ ");
  });
});

describe("parseHelpSections", () => {
  const sections = parseHelpSections(SECTION_HTML);

  it("section ごとに id・見出し・本文を取り出す", () => {
    expect(sections.map((section) => section.id)).toEqual(["basics", "pet"]);
    expect(sections[0]?.title).toBe("掲示板の基本（板・スレ・レス）");
    expect(sections[0]?.text).toContain("板は話題の分野ごとの集まり");
    expect(sections[0]?.text).not.toContain("掲示板の基本（板・スレ・レス）");
    expect(sections[0]?.text).not.toContain("<p>");
  });

  it("あとから足された節（#pet）もそのまま拾う（help-view が正本）", () => {
    const pet = sections.find((section) => section.id === "pet");
    expect(pet?.title).toBe("AI ペット（あとから足された節）");
    expect(pet?.text).toBe("右下のペットから使い方を聞けます。");
  });
});

describe("findHelpSection / matchesHelp", () => {
  const sections = parseHelpSections(SECTION_HTML);

  it("ID・見出しの完全一致・部分一致の順に探す", () => {
    expect(findHelpSection(sections, "pet")?.id).toBe("pet");
    expect(findHelpSection(sections, "AI ペット（あとから足された節）")?.id).toBe("pet");
    expect(findHelpSection(sections, "掲示板の基本")?.id).toBe("basics");
    expect(findHelpSection(sections, "存在しない節")).toBeNull();
  });

  it("検索語は見出しと本文の両方に当たる", () => {
    const basics = sections[0];
    if (!basics) throw new Error("basics が無い");
    expect(matchesHelp(basics, "レス番号")).toBe(true);
    expect(matchesHelp(basics, "掲示板")).toBe(true);
    expect(matchesHelp(basics, "ペット")).toBe(false);
  });
});

describe("help-view.tsx との対応", () => {
  it("help-view.tsx が持つ節の id を、Section の形からすべて拾える", async () => {
    // 正本（help-view.tsx）の `<Section id="..." title="...">` を読む。
    const sourcePath = fileURLToPath(new URL("../../../app/_shell/views/help-view.tsx", import.meta.url));
    const source = await readFile(sourcePath, "utf8");
    const declared = [...source.matchAll(/<Section\s+id="([^"]+)"\s+title="([^"]*)"/g)].map((matched) => ({
      id: matched[1] ?? "",
      title: matched[2] ?? "",
    }));
    expect(declared.length).toBeGreaterThan(5);
    // Section 部品と同じ形の HTML を作り、parser が全部の節を拾えることを確かめる。
    // （DSPetUI が `#pet` を足しても、ここは自動で増える）
    const markup = declared
      .map((section) => `<section id="${section.id}"><h2><span>${section.title}</span></h2><p>本文</p></section>`)
      .join("");
    expect(parseHelpSections(markup).map((section) => section.id)).toEqual(declared.map((section) => section.id));
    expect(parseHelpSections(markup)[0]?.title).toBe(declared[0]?.title);
  });
});