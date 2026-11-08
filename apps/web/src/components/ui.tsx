"use client";

// 共有 UI 部品（管理画面からも import 可）。
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { Link } from "@/app/_shell/router";

type ButtonVariant = "normal" | "primary" | "danger";
type ButtonSize = "sm" | "md" | "block" | "sm-block";

export function Button({
  variant = "normal",
  size = "md",
  className,
  type = "button",
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: ButtonVariant; size?: ButtonSize }) {
  const classes = ["oc-btn"];
  if (variant === "primary") classes.push("oc-btn-primary");
  if (variant === "danger") classes.push("oc-btn-danger");
  if (size === "sm" || size === "sm-block") classes.push("oc-btn-sm");
  if (size === "block" || size === "sm-block") classes.push("oc-btn-block");
  if (className) classes.push(className);
  return <button type={type} className={classes.join(" ")} {...rest} />;
}

export function Spinner({ label = "読み込み中…" }: { label?: string }) {
  return <div className="oc-loading">{label}</div>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="oc-empty">{children}</div>;
}

export function Notice({
  kind,
  children,
  onRetry,
}: {
  kind: "error" | "ok" | "warn";
  children: ReactNode;
  onRetry?: () => void;
}) {
  const className = kind === "error" ? "oc-error" : kind === "ok" ? "oc-ok" : "oc-warn-box";
  return (
    <div className={className} role={kind === "error" ? "alert" : undefined}>
      <div className="oc-row-between">
        <span>{children}</span>
        {onRetry ? (
          <Button size="sm" onClick={onRetry}>
            再試行
          </Button>
        ) : null}
      </div>
    </div>
  );
}

export function Modal({
  open,
  title,
  onClose,
  children,
  footer,
  width,
}: {
  open: boolean;
  title: ReactNode;
  onClose: () => void;
  children: ReactNode;
  footer?: ReactNode;
  width?: number;
}) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    const previous = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.removeEventListener("keydown", onKey);
      document.body.style.overflow = previous;
    };
  }, [open, onClose]);

  if (!open || !mounted) return null;
  return createPortal(
    <div className="oc-modal-backdrop" onClick={onClose} role="presentation">
      <div
        className="oc-modal"
        style={width ? { width: `min(${width}px, 96vw)` } : undefined}
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
      >
        <div className="oc-modal-head">
          <span>{title}</span>
          <Button size="sm" onClick={onClose} aria-label="閉じる">
            ✕
          </Button>
        </div>
        <div className="oc-modal-body">{children}</div>
        {footer ? <div className="oc-modal-foot">{footer}</div> : null}
      </div>
    </div>,
    document.body,
  );
}

interface Toast {
  id: number;
  message: string;
}

const ToastContext = createContext<{ show: (message: string) => void; clear: () => void }>({
  show: () => undefined,
  clear: () => undefined,
});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextId = useRef(1);

  const show = useCallback((message: string) => {
    const id = nextId.current;
    nextId.current += 1;
    setToasts((prev) => [...prev, { id, message }]);
    window.setTimeout(() => {
      setToasts((prev) => prev.filter((toast) => toast.id !== id));
    }, 3800);
  }, []);

  /** 表示中のトーストを即座に消す（新しい操作を始めたとき、前の成功表示と矛盾しないように）。 */
  const clear = useCallback(() => setToasts([]), []);

  const value = useMemo(() => ({ show, clear }), [show, clear]);

  return (
    <ToastContext.Provider value={value}>
      {children}
      <div className="oc-toasts" aria-live="polite">
        {toasts.map((toast) => (
          <div key={toast.id} className="oc-toast">
            {toast.message}
          </div>
        ))}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  return useContext(ToastContext);
}

export function PageLink({ href, children }: { href: string; children: ReactNode }) {
  return <Link href={href}>{children}</Link>;
}

export function Tabs<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { value: T; label: string }[];
  active: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="oc-tabs" role="tablist">
      {tabs.map((tab) => (
        <button
          key={tab.value}
          type="button"
          role="tab"
          aria-selected={active === tab.value}
          className={active === tab.value ? "active" : undefined}
          onClick={() => onChange(tab.value)}
        >
          {tab.label}
        </button>
      ))}
    </div>
  );
}