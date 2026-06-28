import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

/** Generate a unique-ish id for aria-labelledby, stable across renders. */
let modalTitleIdCounter = 0
function useModalTitleId(): string {
  const ref = useRef<number>(0)
  if (ref.current === 0) {
    modalTitleIdCounter += 1
    ref.current = modalTitleIdCounter
  }
  return `modal-title-${ref.current}`
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
