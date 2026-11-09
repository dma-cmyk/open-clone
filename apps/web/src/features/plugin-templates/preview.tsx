"use client";

// 生成物のプレビュー（報告書 27 §4.4 / 決定 8）。
//
// render 系: スレ画面（board-ui/post-body.tsx）と**同じ Worker 実行経路**（requestRenderSegments）で
// サンプルレスを変換して表示する。`applyPostRenderRules`（メインスレッド実行。既知の制約 M-5）は使わない。
// slot 系: 既存の `PluginPreview`（sandbox iframe）をそのまま使う。

import { useEffect, useState } from "react";
import type { PluginManifest, PluginPostRenderRule, PluginTemplateDefinition } from "shared";
import { PostBody } from "@/features/board-ui/post-body";
import { PluginPreview, PluginRenderStyles } from "@/features/plugin-host";
import { MAX_RENDER_TEXT_CHARS, type PostRenderSegment } from "@/features/plugin-host/render-rules";
import { requestRenderSegments, resetThreadRenderBudget } from "@/features/plugin-host/render-worker-client";
import { Badge } from "@/app/plugins/_shared";
import type { RenderSample } from "./samples";

type SampleState = "pending" | "transformed" | "plain" | "tooLong" | "unavailable";

function sampleState(body: string, segments: PostRenderSegment[] | null): SampleState {
  if (body.length > MAX_RENDER_TEXT_CHARS) return "tooLong";
  if (segments === null) return "unavailable";
  return segments.some((segment) => segment.type === "rule") ? "transformed" : "plain";
}

const SAMPLE_BADGE: Record<SampleState, { tone: "ok" | "warn" | "neutral"; label: string }> = {
  pending: { tone: "neutral", label: "変換中…" },
  transformed: { tone: "ok", label: "変換されました" },
  plain: { tone: "neutral", label: "変換されません" },
  tooLong: { tone: "warn", label: "2,048 字超のため対象外" },
  unavailable: { tone: "warn", label: "プレビューを実行できません" },
};

/** render 系: 3 種のサンプルを Worker 経由で変換して見せる。 */
export function RenderRulePreview(props: {
  rules: readonly PluginPostRenderRule[];
  samples: readonly RenderSample[];
  runId: number;
}) {
  const { rules, samples, runId } = props;
  const rulesKey = JSON.stringify(rules);
  const samplesKey = samples.map((sample) => `${sample.key}:${sample.body}`).join("\u0000");
  const [states, setStates] = useState<Record<string, SampleState>>({});

  useEffect(() => {
    let cancelled = false;
    // スレ表示と同じく、プレビュー単位で合計予算をリセットする（描画のたびに以前の消費を引きずらない）。
    resetThreadRenderBudget();
    const initial: Record<string, SampleState> = {};
    for (const sample of samples) initial[sample.key] = "pending";
    setStates(initial);
    for (const sample of samples) {
      void requestRenderSegments(sample.body, rules).then((segments) => {
        if (cancelled) return;
        setStates((previous) => ({ ...previous, [sample.key]: sampleState(sample.body, segments) }));
      });
    }
    return () => {
      cancelled = true;
    };
    // rulesKey / samplesKey は内容の同一性キー（配列の参照は毎回変わる）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rulesKey, samplesKey, runId]);

  return (
    <div>
      <PluginRenderStyles />
      <p className="oc-note">
        スレ画面と同じ実行経路（Web Worker）で変換しています。長文サンプルは既知の制約（2,048 字超は対象外）を
        確認するためのものです。
      </p>
      {samples.map((sample) => {
        const state = states[sample.key] ?? "pending";
        const badge = SAMPLE_BADGE[state];
        return (
          <div key={sample.key} style={{ marginTop: 8 }} data-sample={sample.key}>
            <div className="oc-row-between">
              <span className="oc-label">{sample.label}</span>
              <Badge tone={badge.tone}>{badge.label}</Badge>
            </div>
            <div
              style={{
                background: "var(--oc-surface)",
                border: "1px solid var(--oc-border)",
                borderRadius: "var(--oc-radius)",
                padding: "4px 8px",
                marginTop: 3,
                maxHeight: 180,
                overflow: "auto",
              }}
            >
              <PostBody
                body={sample.body}
                aa={false}
                showImages={false}
                onAnchor={() => {}}
                renderRules={rules}
              />
            </div>
            {sample.note ? <p className="oc-note">{sample.note}</p> : null}
          </div>
        );
      })}
    </div>
  );
}

/** slot 系: 既存の sandbox プレビュー（PluginPreview）。 */
export function SlotTemplatePreview(props: {
  manifest: PluginManifest;
  code: string;
  runId: number;
}) {
  const slot = props.manifest.slots[0] ?? "thread-post-inline";
  const data =
    slot === "thread-head"
      ? { threadId: 1001, boardId: 1, boardSlug: "demo" }
      : {
          post: {
            id: 2,
            num: 2,
            name: "名無しさん",
            body: "プレビュー用のレスです。",
            createdAt: 1760000060,
          },
        };
  return (
    <PluginPreview
      manifest={props.manifest}
      code={props.code}
      runId={props.runId}
      slot={slot}
      data={data}
      minHeight={64}
    />
  );
}

/** テンプレート種別に応じたプレビュー。 */
export function TemplatePreview(props: {
  template: PluginTemplateDefinition;
  manifest: PluginManifest;
  code: string;
  samples: readonly RenderSample[];
  runId: number;
}) {
  if (props.template.kind === "render") {
    return (
      <RenderRulePreview
        rules={props.manifest.render?.post ?? []}
        samples={props.samples}
        runId={props.runId}
      />
    );
  }
  return (
    <div>
      <SlotTemplatePreview manifest={props.manifest} code={props.code} runId={props.runId} />
      {props.template.id === "quick-reply" ? (
        <p className="oc-note">
          プレビューでは実際に投稿されません（ボタンと確認画面のみ動作します）。
        </p>
      ) : null}
    </div>
  );
}