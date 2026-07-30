import { useEffect } from "react";

interface ConfirmDialogProps {
  open: boolean;
  title?: string;
  message: string;
  confirmText?: string;
  cancelText?: string;
  danger?: boolean;
  busy?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}

/**
 * 应用内统一风格的确认弹窗（替代原生 window.confirm）。
 * - 固定全屏遮罩，层级高于设置页；点击遮罩或按 Esc 取消（执行中不可取消）。
 * - message 支持 \n 换行（CSS white-space: pre-line）。
 * - danger 时确认按钮变红，用于删除/清除/重启等破坏性操作。
 */
export function ConfirmDialog({
  open,
  title,
  message,
  confirmText = "确定",
  cancelText = "取消",
  danger = false,
  busy = false,
  onConfirm,
  onCancel
}: ConfirmDialogProps) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, busy, onCancel]);

  if (!open) return null;

  return (
    <div
      className="confirm-overlay"
      role="dialog"
      aria-modal="true"
      onClick={() => {
        if (!busy) onCancel();
      }}
    >
      <div className="confirm-card" onClick={(e) => e.stopPropagation()}>
        {title ? <h3 className="confirm-title">{title}</h3> : null}
        <p className="confirm-msg">{message}</p>
        <div className="confirm-actions">
          <button type="button" className="ghost-btn" disabled={busy} onClick={onCancel}>
            {cancelText}
          </button>
          <button
            type="button"
            className={`settings-primary-btn${danger ? " danger" : ""}`}
            disabled={busy}
            onClick={onConfirm}
          >
            {busy ? "处理中..." : confirmText}
          </button>
        </div>
      </div>
    </div>
  );
}
