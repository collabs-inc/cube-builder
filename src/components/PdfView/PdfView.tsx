import { useEffect, useRef, useState } from 'react';
import { getDocument, GlobalWorkerOptions, type PDFDocumentProxy } from 'pdfjs-dist';
import workerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { services } from '../../web/services/http';
GlobalWorkerOptions.workerSrc = workerUrl;
export default function PdfView({ itemId }: { itemId: string }) {
  const [document, setDocument] = useState<PDFDocumentProxy | null>(null), [page, setPage] = useState(1), [error, setError] = useState(''), [width, setWidth] = useState(600);
  const canvas = useRef<HTMLCanvasElement>(null), container = useRef<HTMLDivElement>(null);
  useEffect(() => { const el = container.current; if (!el) return; const observer = new ResizeObserver(([entry]) => { if (entry) setWidth(Math.max(100, entry.contentRect.width - 24)); }); observer.observe(el); return () => observer.disconnect(); }, []);
  useEffect(() => { let canceled = false; let task: ReturnType<typeof getDocument> | undefined;
    void services.call('previews.create', { itemId }).then(({ url }) => { if (canceled) return; task = getDocument({ url }); return task.promise.then(doc => { if (!canceled) setDocument(doc); }); }).catch(error => { if (!canceled) setError(String(error)); });
    return () => { canceled = true; void task?.destroy(); };
  }, [itemId]);
  useEffect(() => { if (!document || !canvas.current) return; let canceled = false; let render: ReturnType<Awaited<ReturnType<PDFDocumentProxy['getPage']>>['render']> | undefined;
    void document.getPage(page).then(pdfPage => { if (canceled || !canvas.current) return; const base = pdfPage.getViewport({ scale: 1 }), ratio = Math.min(devicePixelRatio || 1, 2); const viewport = pdfPage.getViewport({ scale: width / base.width * ratio }); const el = canvas.current; el.width = viewport.width; el.height = viewport.height; el.style.width = `${viewport.width / ratio}px`; el.style.height = `${viewport.height / ratio}px`; render = pdfPage.render({ canvas: el, viewport }); return render.promise; }).catch(error => { if (!canceled) setError(String(error)); });
    return () => { canceled = true; render?.cancel(); };
  }, [document, page, width]);
  return <div className="pdf-view" ref={container}><nav><button disabled={page <= 1} onClick={() => setPage(n => n - 1)}>Previous</button><span>Page {page} of {document?.numPages ?? '…'}</span><button disabled={!document || page >= document.numPages} onClick={() => setPage(n => n + 1)}>Next</button></nav>{error && <p role="alert">{error}</p>}<div className="pdf-scroll"><canvas ref={canvas} aria-label={`PDF page ${page}`} /></div></div>;
}
