import type { ReactNode } from "react";
import { motion } from "framer-motion";
import { Check, X } from "lucide-react";

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

// Mismo lenguaje visual que la variante `notification` (toasts de pago):
// superficie de card con token, borde hairline e icono semántico suave.
// Así todos los toasts del marketplace se ven iguales.
const CARD_THEME =
  "bg-[var(--color-brand-surface)] text-[var(--color-brand-navy)] border border-black/[0.06]";

const VARIANT_STYLES: Record<ToastVariant, VariantStyle> = {
  success: {
    layout: "flex items-center gap-2.5 px-4 py-3",
    theme: CARD_THEME,
  },
  error: {
    layout: "flex items-center gap-2.5 px-4 py-3",
    theme: CARD_THEME,
  },
  blank: {
    layout: "flex items-center gap-2.5 px-4 py-3",
    theme: CARD_THEME,
  },
  loading: {
    layout: "flex items-center gap-2.5 px-4 py-3",
    theme: CARD_THEME,
  },
  notification: {
    layout: "flex items-start gap-3 p-3 text-left",
    // Lenguaje visual del marketplace: superficie de card (token, nunca
    // blanco hardcodeado) + borde hairline de card (rgba(0,0,0,0.06)).
    theme: CARD_THEME,
  },
};

// ── Icono de estado (éxito / error) ─────────────────────────────────────────

/**
 * Icono semántico compartido por todos los toasts del marketplace — el
 * mismo lenguaje de los toasts de pago:
 *
 *   - éxito   → check sobre `--color-trust-bg`;
 *   - error   → X sobre `--color-danger-bg`.
 *
 * Contenedor pill de 32px (como los badges), Lucide stroke 1.75 y tamaño
 * 16px del sistema. El terracota de marca queda reservado para acciones.
 */
export function ToastStatusIcon({ tone }: { tone: "trust" | "danger" }) {
  const danger = tone === "danger";
  return (
    <span
      className={
        danger
          ? "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-danger-bg)] text-[var(--color-danger)]"
          : "flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-[var(--color-trust-bg)] text-[var(--color-trust)]"
      }
    >
      {danger ? (
        <X className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      ) : (
        <Check className="h-4 w-4" strokeWidth={1.75} aria-hidden="true" />
      )}
    </span>
  );
}

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
