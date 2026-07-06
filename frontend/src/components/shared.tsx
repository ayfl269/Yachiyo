import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/**
 * Generate a unique-ish id for aria-labelledby, stable across renders.
 */
let modalTitleIdCounter = 0
function useModalTitleId(): string {
  const ref = useRef<number>(0)
  if (ref.current === 0) {
    modalTitleIdCounter += 1
    ref.current = modalTitleIdCounter
  }
  return `modal-title-${ref.current}`
}

/**
 * Run an async effect with automatic AbortController cleanup.
 *
 * The effect receives an `AbortSignal` that is aborted when the component
 * unmounts or deps change. Pass this signal to `apiFetch(url, { signal })`
 * so in-flight requests are cancelled, preventing:
 *   - State updates on unmounted components ("Can't perform a React state
 *     update on an unmounted component" warnings)
 *   - Wasted bandwidth / API quota on requests whose results are no longer
 *     needed
 *
 * Usage:
 *   useAsyncEffect(async (signal) => {
 *     const res = await apiFetch('/api/data', { signal })
 *     if (signal.aborted) return
 *     const data = await res.json()
 *     setData(data)
 *   }, [])
 */
export function useAsyncEffect(
  effect: (signal: AbortSignal) => Promise<void> | void,
  deps: React.DependencyList,
): void {
  useEffect(() => {
    const controller = new AbortController()
    const promise = effect(controller.signal)
    if (promise) {
      promise.catch(() => {
        // AbortError is expected when the component unmounts; swallow it
        // so it doesn't surface as an unhandled rejection.
      })
    }
    return () => controller.abort()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

export type ToastColor = 'success' | 'error' | 'info'

interface ToastState {
  show: boolean
  message: string
  color: ToastColor
}

/**
 * Shared toast hook — mirrors the Vue `toast = ref({...})` + `showMessage()` pattern.
 * Auto-hides after 3s and cleans up the timer on unmount (fixes the leak noted in
 * PROJECT_AUDIT_REPORT.md §9 for ProviderManager/PersonaManager/SkillManager).
 */
export function useToast() {
  const [toast, setToast] = useState<ToastState>({ show: false, message: '', color: 'success' })
  const timerRef = useRef<number | null>(null)

  const showMessage = useCallback((message: string, color: ToastColor = 'success') => {
    setToast({ show: true, message, color })
    if (timerRef.current) clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => {
      setToast((t) => ({ ...t, show: false }))
    }, 3000)
  }, [])

  useEffect(() => {
    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [])

  return { toast, showMessage }
}

/**
 * Shared Toast renderer — portaled to body, matches the original `.toast` CSS.
 */
export function ToastPortal({ toast }: { toast: ToastState }) {
  if (!toast.show) return null
  return createPortal(
    <div className={`toast ${toast.color}`}>{toast.message}</div>,
    document.body
  )
}

interface ModalProps {
  open: boolean
  onClose: () => void
  title: string
  children: React.ReactNode
  footer?: React.ReactNode
  size?: 'sm' | 'md' | 'lg'
}

/**
 * Shared Modal component — replaces Vue `<Teleport to="body">` + modal-backdrop.
 * Uses the same CSS classes (.modal-backdrop / .modal-content / .modal-header / …)
 * that the original components relied on.
 */
export function Modal({ open, onClose, title, children, footer, size = 'md' }: ModalProps) {
  const titleId = useModalTitleId()
  const contentRef = useRef<HTMLDivElement>(null)
  const onCloseRef = useRef(onClose)
  onCloseRef.current = onClose

  // Close on Escape and move focus into the dialog when it opens.
  // Only depends on `open` so typing in inputs (which re-renders the parent
  // and creates a new onClose ref) doesn't re-focus and break IME composition.
  useEffect(() => {
    if (!open) return
    const handleKeyDown = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onCloseRef.current()
      }
    }
    document.addEventListener('keydown', handleKeyDown)
    // Move focus into the modal so keyboard users can interact immediately.
    contentRef.current?.focus()
    return () => document.removeEventListener('keydown', handleKeyDown)
  }, [open])

  if (!open) return null

  const sizeClass = size === 'lg' ? 'modal-lg' : size === 'sm' ? 'modal-sm' : ''

  return createPortal(
    <div className="modal-backdrop" onClick={onClose}>
      <div
        className={`modal-content ${sizeClass}`}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={contentRef}
        tabIndex={-1}
      >
        <div className="modal-header">
          <h3 id={titleId}>{title}</h3>
          <button className="close-btn" onClick={onClose} aria-label="关闭对话框">×</button>
        </div>
        <div className="modal-body">{children}</div>
        {footer && <div className="modal-footer">{footer}</div>}
      </div>
    </div>,
    document.body
  )
}
