import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";

// ── Variant ────────────────────────────────────────────────────────────────

export type ToastVariant =
  | "success"
  | "error"
  | "blank"
  | "loading"
  | "notification";

// ── Animation constants ────────────────────────────────────────────────────

const TOAST_TRANSITION = { type: "spring" as const, stiffness: 420, damping: 30 };
const TOAST_ENTER_OFFSET = 24;
const TOAST_ENTER_SCALE = 0.96;
const TOAST_MAX_WIDTH = 360;

// ── Variant config (data-driven, no conditionals) ──────────────────────────

interface VariantStyle {
  layout: string;
  theme: string;
}

const VARIANT_STYLES: Record<ToastVariant, VariantStyle> = {
  success: {
    layout: "flex items-center gap-2.5 px-4 py-3",
    theme: "bg-[var(--color-brand-navy)] text-[var(--color-brand-surface)]",
  },
  error: {
    layout: "flex items-center gap-2.5 px-4 py-3",
    theme: "bg-[var(--color-brand-navy)] text-[var(--color-brand-surface)]",
  },
  blank: {
    layout: "flex items-center gap-2.5 px-4 py-3",
    theme: "bg-[var(--color-brand-navy)] text-[var(--color-brand-surface)]",
  },
  loading: {
    layout: "flex items-center gap-2.5 px-4 py-3",
    theme: "bg-[var(--color-brand-navy)] text-[var(--color-brand-surface)]",
  },
  notification: {
    layout: "flex items-start gap-3 p-3 text-left",
    theme: "bg-white text-[var(--color-brand-navy)]",
  },
};

// ── Shared base classes (hover, radius, shadow, transition) ────────────────

const BASE_CLASSES =
  "rounded-xl shadow-lg transition-all duration-200 hover:-translate-y-0.5 hover:shadow-lg";

// ── Animation style ────────────────────────────────────────────────────────

function toastVisibility(visible: boolean) {
  return visible
    ? { opacity: 1, x: 0, scale: 1 }
    : {
        opacity: 0,
        x: TOAST_ENTER_OFFSET,
        scale: TOAST_ENTER_SCALE,
      };
}

// ── Props ──────────────────────────────────────────────────────────────────

interface BaseToastProps {
  variant: ToastVariant;
  visible: boolean;
  icon?: ReactNode;
  onClick?: () => void;
  onDismiss?: () => void;
  children: ReactNode;
}

function DismissButton({ onDismiss }: { onDismiss: () => void }) {
  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onDismiss();
      }}
      aria-label="Cerrar notificación"
      className="shrink-0 p-1 rounded-lg text-[var(--color-brand-muted)] hover:text-[var(--color-brand-navy)] hover:bg-[#f1f5f9] transition-colors"
    >
      <X className="w-4 h-4" strokeWidth={1.75} />
    </button>
  );
}

// ── Component ──────────────────────────────────────────────────────────────

export function BaseToast({
  variant,
  visible,
  icon,
  onClick,
  onDismiss,
  children,
}: BaseToastProps) {
  const cfg = VARIANT_STYLES[variant];
  // Framer Motion anima la entrada (spring) y la salida cuando `visible`
  // pasa a false (el proveedor lo mantiene montado durante removeDelay).
  const motionProps = {
    initial: { opacity: 0, x: TOAST_ENTER_OFFSET, scale: TOAST_ENTER_SCALE },
    animate: toastVisibility(visible),
    transition: TOAST_TRANSITION,
    style: { maxWidth: TOAST_MAX_WIDTH },
  } as const;

  if (onDismiss) {
    return (
      <motion.div className={`${BASE_CLASSES} ${cfg.layout} ${cfg.theme}`} {...motionProps}>
        {onClick ? (
          <button
            type="button"
            onClick={onClick}
            className="flex items-start gap-3 flex-1 min-w-0 text-left bg-transparent border-0 p-0 cursor-pointer"
          >
            {icon && <span className="shrink-0">{icon}</span>}
            <span className="flex-1 min-w-0">{children}</span>
          </button>
        ) : (
          <>
            {icon && <span className="shrink-0">{icon}</span>}
            <span className="flex-1 min-w-0">{children}</span>
          </>
        )}
        <DismissButton onDismiss={onDismiss} />
      </motion.div>
    );
  }

  if (onClick) {
    return (
      <motion.button
        type="button"
        onClick={onClick}
        className={`${BASE_CLASSES} ${cfg.layout} ${cfg.theme} cursor-pointer`}
        {...motionProps}
      >
        {icon && <span className="shrink-0">{icon}</span>}
        <span className="flex-1 min-w-0">{children}</span>
      </motion.button>
    );
  }

  return (
    <motion.div
      className={`${BASE_CLASSES} ${cfg.layout} ${cfg.theme}`}
      {...motionProps}
    >
      {icon && <span className="shrink-0">{icon}</span>}
      <span className="flex-1 min-w-0">{children}</span>
    </motion.div>
  );
}
