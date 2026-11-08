"use client";

// お絵かきエディタ（Canvas）。open2ch の 490×490 上限に合わせる。
// 描いた画像はアップローダ（WP4 の契約）経由で添付する。Cloudflare には保存しない。

import { useCallback, useEffect, useRef, useState } from "react";
import { Modal, Button } from "@/components/ui";
import type { AttachmentRef } from "./types";
import type { UploaderHandle } from "./uploader-mount";

const SIZE = 490;
const COLORS = [
  "#000000",
  "#ffffff",
  "#e53935",
  "#fb8c00",
  "#fdd835",
  "#43a047",
  "#1e88e5",
  "#8e24aa",
  "#6d4c41",
  "#90a4ae",
];

export function OekakiEditor({
  open,
  onClose,
  uploader,
  onUploaded,
}: {
  open: boolean;
  onClose: () => void;
  uploader: React.RefObject<UploaderHandle | null>;
  onUploaded: (ref: AttachmentRef) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const undoStack = useRef<ImageData[]>([]);
  const drawing = useRef(false);
  const [color, setColor] = useState("#000000");
  const [width, setWidth] = useState(3);
  const [eraser, setEraser] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const paintBackground = useCallback(() => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    context.fillStyle = "#ffffff";
    context.fillRect(0, 0, canvas.width, canvas.height);
  }, []);

  useEffect(() => {
    if (!open) return;
    const canvas = canvasRef.current;
    if (!canvas) return;
    const context = canvas.getContext("2d");
    if (!context) return;
    paintBackground();
    context.lineCap = "round";
    context.lineJoin = "round";
    undoStack.current = [];
    setEraser(false);
    setError(null);
  }, [open, paintBackground]);

  const pushUndo = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    undoStack.current.push(context.getImageData(0, 0, canvas.width, canvas.height));
    if (undoStack.current.length > 10) {
      undoStack.current.shift();
    }
  };

  const point = (event: React.PointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current;
    if (!canvas) return { x: 0, y: 0 };
    const rect = canvas.getBoundingClientRect();
    return {
      x: ((event.clientX - rect.left) / rect.width) * canvas.width,
      y: ((event.clientY - rect.top) / rect.height) * canvas.height,
    };
  };

  const stroke = (event: React.PointerEvent<HTMLCanvasElement>, down: boolean) => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    if (!canvas || !context) return;
    const { x, y } = point(event);
    if (down) {
      pushUndo();
      drawing.current = true;
      context.beginPath();
      context.moveTo(x, y);
      context.strokeStyle = eraser ? "#ffffff" : color;
      context.lineWidth = eraser ? width * 3 : width;
      canvas.setPointerCapture(event.pointerId);
      context.lineTo(x + 0.01, y);
      context.stroke();
      return;
    }
    if (!drawing.current) return;
    context.strokeStyle = eraser ? "#ffffff" : color;
    context.lineWidth = eraser ? width * 3 : width;
    context.lineTo(x, y);
    context.stroke();
  };

  const undo = () => {
    const canvas = canvasRef.current;
    const context = canvas?.getContext("2d");
    const image = undoStack.current.pop();
    if (canvas && context && image) {
      context.putImageData(image, 0, 0);
    }
  };

  const submit = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setBusy(true);
    setError(null);
    canvas.toBlob(async (blob) => {
      if (!blob) {
        setBusy(false);
        setError("画像の生成に失敗しました");
        return;
      }
      try {
        const uploaded = await uploader.current?.uploadBlob(blob, `oekaki-${Date.now()}.png`);
        if (!uploaded) {
          setError("アップロードに失敗しました（アップローダ API の状態を確認してください）");
        } else {
          onUploaded(uploaded);
          onClose();
        }
      } catch (cause) {
        setError(cause instanceof Error ? cause.message : "アップロードに失敗しました");
      } finally {
        setBusy(false);
      }
    }, "image/png");
  };

  return (
    <Modal
      open={open}
      title="お絵かき"
      onClose={onClose}
      width={820}
      footer={
        <>
          <Button onClick={onClose} disabled={busy}>
            キャンセル
          </Button>
          <Button variant="primary" onClick={submit} disabled={busy}>
            {busy ? "送信中…" : "この絵を添付する"}
          </Button>
        </>
      }
    >
      <div className="oc-oekaki-wrap">
        <canvas
          ref={canvasRef}
          width={SIZE}
          height={SIZE}
          className="oc-oekaki-canvas"
          onPointerDown={(event) => stroke(event, true)}
          onPointerMove={(event) => stroke(event, false)}
          onPointerUp={() => {
            drawing.current = false;
          }}
          onPointerLeave={() => {
            drawing.current = false;
          }}
        />
        <div className="oc-oekaki-tools">
          <div className="oc-label">色</div>
          <div className="oc-swatches">
            {COLORS.map((value) => (
              <button
                key={value}
                type="button"
                aria-label={`色 ${value}`}
                className={`oc-swatch${color === value && !eraser ? " active" : ""}`}
                style={{ background: value }}
                onClick={() => {
                  setColor(value);
                  setEraser(false);
                }}
              />
            ))}
          </div>
          <input type="color" value={color} onChange={(event) => setColor(event.target.value)} aria-label="自由色" />
          <label className="oc-field">
            <span className="oc-label">太さ: {width}px</span>
            <input
              type="range"
              min={1}
              max={24}
              value={width}
              onChange={(event) => setWidth(Number(event.target.value))}
            />
          </label>
          <div className="oc-row">
            <Button size="sm" onClick={() => setEraser((value) => !value)}>
              {eraser ? "消しゴム ON" : "消しゴム"}
            </Button>
            <Button size="sm" onClick={undo}>
              元に戻す
            </Button>
          </div>
          <Button
            size="sm"
            onClick={() => {
              pushUndo();
              paintBackground();
            }}
          >
            全消去
          </Button>
          <p className="oc-note">490×490 PNG としてアップロードされ、本文に添付されます。</p>
          {error ? (
            <div className="oc-error" role="alert">
              {error}
            </div>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}