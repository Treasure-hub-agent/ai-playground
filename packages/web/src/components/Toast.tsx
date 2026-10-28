export interface ToastState {
  id: number;
  text: string;
  tone: 'info' | 'error' | 'success';
}

const TONE_ICON: Record<ToastState['tone'], string> = {
  info: '💡',
  error: '⚠️',
  success: '🎉',
};

export function Toast({ toast }: { toast: ToastState | null }) {
  if (!toast) return null;
  return (
    <div key={toast.id} className={`toast toast-${toast.tone}`} role="status">
      <span className="toast-icon" aria-hidden="true">
        {TONE_ICON[toast.tone]}
      </span>
      <span>{toast.text}</span>
    </div>
  );
}
