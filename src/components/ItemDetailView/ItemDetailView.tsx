// Adapted from packages/components/src/ItemDetailView/ItemDetailView.tsx at 600e05f2294df5c71026b723915306a74c8cfd3a.
import {
	useCallback,
	useEffect,
	useLayoutEffect,
	useRef,
	useMemo,
	useState,
} from "react";
import { Copy } from "@phosphor-icons/react/dist/csr/Copy";
import { CheckCircle } from "@phosphor-icons/react/dist/csr/CheckCircle";
import type { ViewerItem } from "@builder/shared/viewer-types";
import { Markdown } from "@builder/components/Markdown";
import { ConceptList } from "@builder/components/ConceptList";
import { SourceList } from "@builder/components/SourceList";
import { Editor } from "@builder/components/Editor";

interface ItemDetailViewProps {
	onDraftChange?: (text: string) => void;
	item: ViewerItem;
	onTextChange: (text: string) => Promise<{ ok: boolean; mtime: string; conflict?: boolean } | void>;
	onTitleChange: (title: string) => void;
	theme: "light" | "dark";
	editingDisabled?: boolean;
	className?: string;
}

function CopyButton({
	text,
	title: buttonTitle,
	size = 14,
}: {
	text: string;
	title: string;
	size?: number;
}) {
	const [success, setSuccess] = useState(false);

	const handleCopy = async () => {
		try {
			await navigator.clipboard.writeText(text);
			setSuccess(true);
			setTimeout(() => setSuccess(false), 2000);
		} catch (err) {
			console.error("Failed to copy:", err);
		}
	};

	return (
		<button
			type="button"
			onClick={handleCopy}
			className={`copy-button ${success ? "copy-success" : ""}`}
			title={success ? "Copied!" : buttonTitle}
		>
			{success ? <CheckCircle size={size} /> : <Copy size={size} />}
		</button>
	);
}

function formatDate(ts: number): string {
	return new Date(ts).toLocaleDateString();
}

function getItemTypeClass(type: string): string {
	const lower = type.toLowerCase();
	const known = ["doc", "pdf", "bookmark", "concept", "skill"];
	return known.includes(lower) ? lower : "";
}

export function ItemDetailView({
	item,
	onTextChange,
	onDraftChange,
	onTitleChange,
	theme,
	editingDisabled = false,
	className,
}: ItemDetailViewProps) {
	const [editableTitle, setEditableTitle] = useState(item.title ?? "");
	const [showRawContext, setShowRawContext] = useState(false);

	const isTitleEditable = item.isTitleEditable ?? item.isEditable;

	const titleTextareaRef = useRef<HTMLTextAreaElement>(null);

	useLayoutEffect(() => {
		setEditableTitle(item.title ?? "");
	}, [item.id, item.title]);

	const handleTitleBlur = useCallback(() => {
		const trimmed = editableTitle.trim();
		if (trimmed.length > 0) {
			onTitleChange(trimmed);
		}
	}, [editableTitle, onTitleChange]);

	useLayoutEffect(() => {
		const el = titleTextareaRef.current;
		if (!el) return;
		el.style.height = "auto";
		el.style.height = `${el.scrollHeight}px`;
	}, [editableTitle, isTitleEditable]);

	useEffect(() => {
		const el = titleTextareaRef.current;
		if (!el) return;
		const parent = el.parentElement;
		if (!parent) return;
		const ro = new ResizeObserver(() => {
			el.style.height = "auto";
			el.style.height = `${el.scrollHeight}px`;
		});
		ro.observe(parent);
		return () => ro.disconnect();
	}, [isTitleEditable]);

	const fileLinkLabel = useMemo(() => {
		if (!item.fileUrl) return "";
		try {
			const parsed = new URL(item.fileUrl);
			const decoded = decodeURIComponent(parsed.pathname || "");
			if (!decoded) return item.fileUrl;
			const parts = decoded.split(/[\\/]/).filter(Boolean);
			return parts.length ? parts[parts.length - 1] : decoded;
		} catch {
			return item.fileUrl;
		}
	}, [item.fileUrl]);

	const displayedFrontmatter = useMemo(() => {
		if (!item.frontmatter) return [];
		const hidden = new Set([
			"title", "type", "url", "summary", "quotes",
			"quotesTitle", "concepts", "sources", "cube_reviewed",
		]);
		return Object.entries(item.frontmatter)
			.filter(([key]) => !hidden.has(key))
			.map(([key, value]) => ({
				key,
				value: typeof value === "string"
					? value
					: JSON.stringify(value),
			}));
	}, [item.frontmatter]);

	return (
		<div className={`item-card${className ? ` ${className}` : ""}`} data-item-type={item.type.toLowerCase()}>
			{/* Metadata */}
			<div className="item-metadata">
				<div className={`item-type-badge ${getItemTypeClass(item.type)}`}>
					{item.type}
				</div>

				<div className="metadata-item metadata-group-start">
					<div className="metadata-label">Created</div>
					<div className="metadata-value">{formatDate(item.createdAt)}</div>
				</div>

				{item.isEditable && (
					<div className="metadata-item">
						<div className="metadata-label">Modified</div>
						<div className="metadata-value">{formatDate(item.modifiedAt)}</div>
					</div>
				)}

				{item.url && (
					<div className="metadata-item">
						<div className="metadata-label">URL</div>
						<div className="metadata-value">
							<a
								href={item.url}
								target="_blank"
								rel="noopener noreferrer"
								className="url-link"
							>
								{item.url}
							</a>
						</div>
					</div>
				)}

				{item.fileUrl && (
					<div className="metadata-item">
						<div className="metadata-label">Original</div>
						<div className="metadata-value">
							<a
								href={item.fileUrl}
								target="_blank"
								rel="noopener noreferrer"
								className="url-link"
								title={item.fileUrl}
							>
								{fileLinkLabel || "Open Original File"}
							</a>
						</div>
					</div>
				)}

				{displayedFrontmatter.map(({ key, value }, i) => (
					<div
						key={key}
						className={`metadata-item${i === 0 ? " metadata-group-start" : ""}`}
					>
						<div className="metadata-label">{key}</div>
						<div className="metadata-value">{value}</div>
					</div>
				))}
			</div>

			{/* Content */}
			<div className="item-content-wrapper">
				{/* <div className="content-action-buttons">
          <CopyButton
            text={`${item.title ? `# ${item.title}\n\n` : ""}${item.text ?? ""}`}
            title="Copy content"
            size={14}
          />
        </div> */}

				<div className="item-content">
					{isTitleEditable ? (
						<textarea
							ref={titleTextareaRef}
							className="item-title item-title-input"
							value={editableTitle}
							onChange={(e) => setEditableTitle(e.target.value)}
							onBlur={handleTitleBlur}
							onKeyDown={(e) => {
								if (e.key === "Escape") e.currentTarget.blur();
							}}
							aria-label="Item title"
							readOnly={editingDisabled}
							spellCheck={false}
							rows={1}
							style={{ resize: "none" }}
						/>
					) : (
						<h2 className="item-title">{item.title}</h2>
					)}

					{item.summary && (
						<div className="item-summary">
							<div className="summary-header">
								<span className="summary-label">Summary</span>
							</div>
							<Markdown
								className="summary-content"
								content={item.summary}
								enableKatex={item.type.toLowerCase() === "pdf"}
							/>
						</div>
					)}

					{(item.isEditable || item.text) && (
						<Editor
							currentItem={item}
							onTextChange={onTextChange}
							onDraftChange={onDraftChange}
							theme={theme}
							editingDisabled={editingDisabled || !item.isEditable}
						/>
					)}

					{item.quotes && item.quotes.length > 0 && (
						<div className="quotes-container">
							<div className="quotes-header">
								<span className="section-label">
									{item.quotesTitle || "Quotes"}
								</span>
							</div>
							<div className="quotes-list">
								{item.quotes.map((q, idx) => (
									<blockquote key={idx} className="quote-item">
										{q.text}
									</blockquote>
								))}
							</div>
						</div>
					)}
				</div>
			</div>

			{/* Sources */}
			{item.sources &&
				item.sources.some((source) =>
					Object.values(source).some((items) => items && items.length > 0),
				) && <SourceList sources={item.sources} highlightText={item.title} />}

			{/* Raw Context */}
			{item.rawContext && (
				<div className="raw-context-container">
					<button
						className="raw-context-toggle"
						onClick={() => setShowRawContext(!showRawContext)}
						aria-expanded={showRawContext}
					>
						<span className="raw-context-label">Raw Context</span>
						<svg
							width="16"
							height="16"
							viewBox="0 0 24 24"
							fill="none"
							xmlns="http://www.w3.org/2000/svg"
							className={`raw-context-chevron ${showRawContext ? "expanded" : ""}`}
						>
							<path
								d="M6 9L12 15L18 9"
								stroke="currentColor"
								strokeWidth="2"
								strokeLinecap="round"
								strokeLinejoin="round"
							/>
						</svg>
					</button>
					{showRawContext && (
						<div className="raw-context-content">
							<Markdown
								className="raw-context-markdown"
								content={item.rawContext}
								enableKatex={item.type.toLowerCase() === "pdf"}
							/>
						</div>
					)}
				</div>
			)}
		</div>
	);
}
