import katex from 'katex';

interface LatexPreviewProps {
  latex?: string;
  fallbackText?: string;
  className?: string;
}

export function LatexPreview({ latex, fallbackText, className }: LatexPreviewProps) {
  let html = '';
  if (latex) {
    try {
      html = katex.renderToString(latex, { throwOnError: false, displayMode: false });
    } catch {
      html = '';
    }
  }

  return (
    <div className={className ?? 'latex-preview'}>
      {html ? <div dangerouslySetInnerHTML={{ __html: html }} /> : <span className="latex-preview__fallback">{fallbackText ?? ''}</span>}
    </div>
  );
}
