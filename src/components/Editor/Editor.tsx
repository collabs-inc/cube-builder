import { saveDroppedImage } from "../../web/services/assets";
// Adapted from packages/components/src/Editor/Editor.tsx at 600e05f2294df5c71026b723915306a74c8cfd3a.
import { en } from "@blocknote/core/locales";
import {
	useEffect,
	useMemo,
	useState,
	useRef,
	useCallback,
} from "react";
import {
	BlockNoteSchema,
	createCheckListItemBlockSpec,
	defaultBlockSpecs,
	defaultInlineContentSpecs,
	type PartialBlock,
	markdownToHTML,
	HTMLToBlocks,
} from "@blocknote/core";
import { useCreateBlockNote } from "@blocknote/react";
import { BlockNoteView } from "@blocknote/mantine";
import "@blocknote/mantine/style.css";
import "@blocknote/core/fonts/inter.css";
// Must come after BlockNote's own stylesheets: the overrides in here
// (.bn-editor padding, .bn-default-styles font) match BlockNote's selectors
// exactly, so they only win on source order. Importing it from a consumer
// instead put it in that consumer's chunk, which for a lazily loaded editor
// is injected *before* this chunk's CSS — and lost.
import "./Blocknote.css";
import type { ViewerItem, WriteResult } from "@builder/shared/viewer-types";
import Typography from "@tiptap/extension-typography";
import { InputRule } from "@tiptap/core";
import { CustomImageBlock, ImageResolverContext } from "./ImageBlock";
import { EditorConflictBanner } from "./EditorConflictBanner";

const CustomTypography = Typography.extend({
	addInputRules() {
		const parentRules = this.parent?.() ?? [];
		return [
			new InputRule({
				find: /\+\-$/,
				handler: ({ state, range }) => {
					state.tr.insertText("\u00B1", range.from, range.to);
				},
			}),
			new InputRule({
				find: /\!\=$/,
				handler: ({ state, range }) => {
					state.tr.insertText("\u2260", range.from, range.to);
				},
			}),
			new InputRule({
				find: /\<\=$/,
				handler: ({ state, range }) => {
					state.tr.insertText("\u2264", range.from, range.to);
				},
			}),
			new InputRule({
				find: /\>\=$/,
				handler: ({ state, range }) => {
					state.tr.insertText("\u2265", range.from, range.to);
				},
			}),
			new InputRule({
				find: /\~\=$/,
				handler: ({ state, range }) => {
					state.tr.insertText("\u2248", range.from, range.to);
				},
			}),
			new InputRule({
				find: /\<\-\>$/,
				handler: ({ state, range }) => {
					state.tr.insertText("\u2194", range.from, range.to);
				},
			}),
			new InputRule({
				find: /\u2014\>$/,
				handler: ({ state, range }) => {
					state.tr.insertText("\u27F6", range.from, range.to);
				},
			}),
			new InputRule({
				find: /\<\u2014$/,
				handler: ({ state, range }) => {
					state.tr.insertText("\u27F5", range.from, range.to);
				},
			}),
			...parentRules,
		];
	},
});

const CustomCheckListItemBlock = (() => {
	const baseSpec = createCheckListItemBlockSpec();
	const baseExtensions = baseSpec.extensions ?? [];
	const customizedExtensions = baseExtensions.map((ext) => {
		if (typeof ext !== "function") return ext;
		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const wrapped = ((ctx: any) => {
			const resolved = ext(ctx);
			if (resolved.key !== "check-list-item-shortcuts") return resolved;
			return {
				...resolved,
				inputRules: [
					{
						find: /\[\s*\]\s$/,
						replace() {
							return { type: "checkListItem", props: { checked: false } };
						},
					},
					{
						find: /\[[Xx]\]\s$/,
						replace() {
							return { type: "checkListItem", props: { checked: true } };
						},
					},
				],
			};
		}) as typeof ext;
		return wrapped;
	});
	return { ...baseSpec, extensions: customizedExtensions };
})();

const schema = BlockNoteSchema.create({
	blockSpecs: {
		...defaultBlockSpecs,
		checkListItem: CustomCheckListItemBlock,
		image: CustomImageBlock(),
	},
	inlineContentSpecs: {
		...defaultInlineContentSpecs,
	},
});

const EMPTY_PARA_SENTINEL = "\u2800";
const EMPTY_PARA_LEGACY_BR = /^\s*<br\s*\/?>\s*$/;

function isContentEmpty(content: unknown): boolean {
	if (!Array.isArray(content) || content.length === 0) return true;
	if (content.length === 1) {
		const item = content[0];
		if (typeof item === "object" && item !== null && "text" in item) {
			return (item as { text: string }).text === "";
		}
	}
	return false;
}

function isSentinelParagraph(block: unknown): boolean {
	if (typeof block !== "object" || block === null) return false;
	const b = block as Record<string, unknown>;
	if (b.type !== "paragraph") return false;
	const content = b.content;
	if (!Array.isArray(content) || content.length !== 1) return false;
	const item = content[0];
	if (typeof item !== "object" || item === null) return false;
	const t = item as Record<string, unknown>;
	return t.type === "text" && t.text === EMPTY_PARA_SENTINEL;
}

function markEmptyParagraphs(blocks: PartialBlock[]): PartialBlock[] {
	return blocks.map((block) => {
		const result =
			block.type === "paragraph" && isContentEmpty(block.content)
				? {
					...block,
					content: [{ type: "text" as const, text: EMPTY_PARA_SENTINEL }],
				}
				: block;
		if (result.children && result.children.length > 0) {
			return {
				...result,
				children: markEmptyParagraphs(result.children as PartialBlock[]),
			};
		}
		return result;
	}) as PartialBlock[];
}

function legacyBreakToSentinel(markdown: string): string {
	return markdown
		.split("\n")
		.map((line) => (EMPTY_PARA_LEGACY_BR.test(line) ? EMPTY_PARA_SENTINEL : line))
		.join("\n");
}

const WIKI_IMAGE_EXTENSIONS =
	"png|jpg|jpeg|gif|webp|bmp|tiff|tif|avif|heic|heif";
const WIKI_IMAGE_LOAD_RE = new RegExp(
	`!\\[\\[([^\\]]+\\.(?:${WIKI_IMAGE_EXTENSIONS}))\\]\\]`,
	"gi",
);
const WIKI_IMAGE_SAVE_RE =
	/!\[([^\]]*)\]\(wikiimage:((?:\([^)]*\)|[^)])+)\)/g;

function preProcessImageWikilinks(markdown: string): string {
	return markdown.replace(
		WIKI_IMAGE_LOAD_RE,
		(_match, filename: string) =>
			`![](wikiimage:${encodeURIComponent(filename)})`,
	);
}

function postProcessMarkdown(markdown: string): string {
	return markdown.replace(
		WIKI_IMAGE_SAVE_RE,
		(_match, _alt: string, filename: string) => {
			try {
				return `![[${decodeURIComponent(filename)}]]`;
			} catch {
				return `![[${filename}]]`;
			}
		},
	);
}

function restoreEmptyParagraphs(blocks: unknown[]): unknown[] {
	return blocks.map((block) => {
		const b = block as Record<string, unknown>;
		const restored = isSentinelParagraph(b) ? { ...b, content: [] } : b;
		if (Array.isArray(restored.children) && restored.children.length > 0) {
			return {
				...restored,
				children: restoreEmptyParagraphs(restored.children),
			};
		}
		return restored;
	});
}

// rehypeStringify emits <br>\n for hard breaks. ProseMirror's DOMParser
// with linebreakReplacement treats BOTH the <br> and the \n as hard
// breaks, doubling them on every save/load cycle. Strip post-<br>
// newlines so ProseMirror only sees the <br>.
function parseMarkdownToBlocks(
	markdown: string,
	// eslint-disable-next-line @typescript-eslint/no-explicit-any
	pmSchema: any,
) {
	const html = markdownToHTML(markdown);
	const cleaned = html.replace(/<br>\n/g, "<br>");
	return HTMLToBlocks(cleaned, pmSchema);
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function findVisualLineStart(
	view: any,
	blockStart: number,
	cursorPos: number,
	lineTop: number,
	blockLeft: number,
	caretLeft: number,
): number {
	let loX = blockLeft;
	let hiX = caretLeft;
	let bestPos = cursorPos;
	for (let i = 0; i < 20 && hiX - loX > 0.5; i++) {
		const midX = loX + (hiX - loX) / 2;
		const hit = view.posAtCoords({ left: midX, top: lineTop });
		if (!hit) break;
		const pos = Math.max(blockStart, Math.min(cursorPos, hit.pos));
		const r = view.coordsAtPos(pos);
		if (Math.abs(r.top - lineTop) < 1) {
			bestPos = pos;
			hiX = midX - 0.5;
		} else {
			loX = midX + 0.5;
		}
	}
	let refined = bestPos;
	for (let j = 0; j < 50 && refined > blockStart; j++) {
		const prev = refined - 1;
		const rr = view.coordsAtPos(prev);
		if (Math.abs(rr.top - lineTop) < 1) {
			refined = prev;
		} else {
			break;
		}
	}
	return refined;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function repositionCursorAfterDivider(editor: any, dividerBlockId: string): void {
	try {
		const currentBlocks = editor.document;
		const dividerIndex = currentBlocks.findIndex(
			(b: { id: string }) => b.id === dividerBlockId,
		);
		if (dividerIndex !== -1 && dividerIndex < currentBlocks.length - 1) {
			const nextBlock = currentBlocks[dividerIndex + 1];
			editor.setTextCursorPosition(nextBlock.id, "start");
		} else {
			editor.insertBlocks(
				[{ type: "paragraph", content: [] }],
				dividerBlockId,
				"after",
			);
			const newBlocks = editor.document;
			const newIdx = newBlocks.findIndex(
				(b: { id: string }) => b.id === dividerBlockId,
			);
			if (newIdx !== -1 && newIdx < newBlocks.length - 1) {
				editor.setTextCursorPosition(newBlocks[newIdx + 1].id, "start");
			}
		}
		editor.focus();
	} catch (e) {
		console.warn("Failed to reposition cursor after divider:", e);
	}
}

/* eslint-disable @typescript-eslint/no-explicit-any */
interface ChecklistNavContext {
	tiptap: any;
	pmSelection: any;
	cursorInfo: any;
	parentOffset: number;
	parentSize: number;
	caretRect: {
		left: number;
		right: number;
		top: number;
		bottom: number;
	} | null;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function getChecklistNavContext(editor: any): ChecklistNavContext | null {
	const tiptap = editor._tiptapEditor ?? editor.tiptapEditor;
	if (!tiptap?.isFocused) return null;

	const { state } = tiptap;
	const pmSelection = state.selection;
	if (!pmSelection.empty) return null;

	const view = tiptap.view;
	if (!view) return null;

	const cursorInfo = editor.getTextCursorPosition();
	const currentBlock = cursorInfo?.block;
	if (!currentBlock || currentBlock.type !== "checkListItem") return null;

	const { $from } = pmSelection;
	let caretRect: ChecklistNavContext["caretRect"] = null;
	try {
		caretRect = view.coordsAtPos(pmSelection.from);
	} catch {
		caretRect = null;
	}

	return {
		tiptap,
		pmSelection,
		cursorInfo,
		parentOffset: $from.parentOffset,
		parentSize: $from.parent.content.size,
		caretRect,
	};
}

interface EditorProps {
	currentItem: ViewerItem;
	onTextChange: (text: string) => Promise<WriteResult | void>;
	theme: "light" | "dark";
	editingDisabled?: boolean;
}

export default function Editor({
	currentItem,
	onTextChange,
	theme,
	editingDisabled,
}: EditorProps) {
	const [lastBlockContent, setLastBlockContent] = useState<Map<string, string>>(
		new Map(),
	);
	const debounceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
	const pendingSaveRef = useRef(false);
	const pendingItemIdRef = useRef<string | null>(null);
	const isProgrammaticUpdateRef = useRef(false);
	const contentLoadedRef = useRef(false);
	const lastSavedMarkdownRef = useRef<string | null>(null);
	const currentItemIdRef = useRef(currentItem.id);
	currentItemIdRef.current = currentItem.id;
	const editingDisabledRef = useRef(editingDisabled);
	editingDisabledRef.current = editingDisabled;
	const [showConflict, setShowConflict] = useState(false);
	const externalContentRef = useRef<ViewerItem | null>(null);

	const locale = en;

	const editor = useCreateBlockNote({
		dictionary: {
			...locale,
			placeholders: {
				...locale.placeholders,
				emptyDocument: "Start typing or press '/' for more",
				default: "",
				heading: "",
				checkListItem: "",
				bulletListItem: "",
				numberedListItem: "",
			},
		},
		schema,
		uploadFile: async (file: File) => {
			const itemId = currentItemIdRef.current;
			const noteDir = itemId.substring(0, itemId.lastIndexOf("/"));
			const buffer = await file.arrayBuffer();
			const savedName = await saveDroppedImage(
				noteDir,
				file.name,
				buffer,
			);
			return `wikiimage:${savedName}`;
		},
		_tiptapOptions: {
			extensions: [CustomTypography],
		},
	});

	const checkForDividerPattern = useCallback(async () => {
		const selection = editor.getTextCursorPosition();
		if (!selection) return;
		const currentBlock = editor.getBlock(selection.block);
		if (!currentBlock || currentBlock.type !== "paragraph") return;

		try {
			const blockContent = currentBlock.content;
			if (!Array.isArray(blockContent) || blockContent.length !== 1) return;

			const firstContent = blockContent[0];
			if (
				!firstContent ||
				typeof firstContent !== "object" ||
				!("text" in firstContent)
			)
				return;

			const currentText = firstContent.text;
			const blockId = currentBlock.id;
			const previousText = lastBlockContent.get(blockId) ?? "";

			if (
				(currentText === "---" && previousText === "--") ||
				(currentText === "\u2014-" && previousText === "\u2014")
			) {
				setLastBlockContent((prev) => {
					const next = new Map(prev);
					next.set(blockId, currentText);
					return next;
				});

				editor.updateBlock(currentBlock.id, {
					type: "divider",
					content: undefined,
				});

				setTimeout(
					() => repositionCursorAfterDivider(editor, currentBlock.id),
					0,
				);
			} else {
				setLastBlockContent((prev) => {
					const next = new Map(prev);
					next.set(blockId, currentText);
					return next;
				});
			}
		} catch (e) {
			console.error("Error checking for divider pattern:", e);
		}
	}, [editor, lastBlockContent]);

	const flushPendingSave = useCallback(
		async (_reason: string) => {
			if (editingDisabledRef.current) return;
			const itemId = pendingItemIdRef.current ?? currentItem?.id ?? null;
			if (!itemId) return;
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
				debounceTimerRef.current = null;
			}
			if (!pendingSaveRef.current) return;

			try {
				const markedBlocks = markEmptyParagraphs(editor.document);
				const raw = editor.blocksToMarkdownLossy(markedBlocks).trim();
				const markdown = postProcessMarkdown(raw);
				lastSavedMarkdownRef.current = markdown;
				onTextChange(markdown);
				pendingSaveRef.current = false;
				pendingItemIdRef.current = null;
			} catch (error) {
				console.error("[Editor] Failed to flush markdown:", error);
			}
		},
		[currentItem?.id, editor, onTextChange],
	);

	const handleEditorChange = useCallback(async () => {
		if (isProgrammaticUpdateRef.current) return;
		if (!contentLoadedRef.current) return;
		if (editingDisabledRef.current) return;
		await checkForDividerPattern();

		const itemId = currentItem?.id;
		if (!itemId) return;

		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
		}

		pendingItemIdRef.current = itemId;
		pendingSaveRef.current = true;

		debounceTimerRef.current = setTimeout(async () => {
			try {
				if (editingDisabledRef.current) {
					pendingSaveRef.current = false;
					pendingItemIdRef.current = null;
					return;
				}
				const markedBlocks = markEmptyParagraphs(editor.document);
				const raw = editor.blocksToMarkdownLossy(markedBlocks).trim();
				const markdown = postProcessMarkdown(raw);
				lastSavedMarkdownRef.current = markdown;
				onTextChange(markdown);
				pendingSaveRef.current = false;
				pendingItemIdRef.current = null;
			} catch (error) {
				console.error("[Editor] Failed to save markdown:", error);
			} finally {
				debounceTimerRef.current = null;
			}
		}, 1000);
	}, [checkForDividerPattern, currentItem?.id, editor, onTextChange]);

	const handleEditorBlur = useCallback(async () => {
		if (showConflict) return;
		if (editingDisabledRef.current) return;
		const itemId = currentItem?.id;
		if (!itemId) return;
		const markedBlocks = markEmptyParagraphs(editor.document);
		const raw = editor.blocksToMarkdownLossy(markedBlocks).trim();
		const markdown = postProcessMarkdown(raw);
		lastSavedMarkdownRef.current = markdown;
		onTextChange(markdown);
	}, [showConflict, currentItem?.id, editor, onTextChange]);

	const handleConflictReload = useCallback(() => {
		const stashed = externalContentRef.current;
		if (!stashed) return;

		const { text } = stashed;
		const markdown = typeof text === "string" ? text : "";

		let nextBlocks: unknown[] | null = null;
		if (markdown.length > 0) {
			const withImages = preProcessImageWikilinks(markdown);
			const prepared = legacyBreakToSentinel(withImages);
			const parsed = parseMarkdownToBlocks(prepared, editor.pmSchema);
			nextBlocks = restoreEmptyParagraphs(parsed);
		}
		if (!nextBlocks) {
			nextBlocks = parseMarkdownToBlocks("", editor.pmSchema);
		}

		const blocksToInsert = (nextBlocks ?? []) as PartialBlock[];
		isProgrammaticUpdateRef.current = true;
		try {
			editor.replaceBlocks(editor.document, blocksToInsert);
		} finally {
			isProgrammaticUpdateRef.current = false;
		}

		lastSavedMarkdownRef.current = markdown;
		pendingSaveRef.current = false;
		pendingItemIdRef.current = null;
		externalContentRef.current = null;
		setShowConflict(false);
		setLastBlockContent(new Map());
	}, [editor]);

	const handleConflictOverwrite = useCallback(async () => {
		const markedBlocks = markEmptyParagraphs(editor.document);
		const raw = editor.blocksToMarkdownLossy(markedBlocks).trim();
		const markdown = postProcessMarkdown(raw);
		lastSavedMarkdownRef.current = markdown;
		await onTextChange(markdown);

		pendingSaveRef.current = false;
		pendingItemIdRef.current = null;
		externalContentRef.current = null;
		setShowConflict(false);
	}, [editor, onTextChange]);

	useEffect(() => {
		if (!editingDisabled) return;
		if (debounceTimerRef.current) {
			clearTimeout(debounceTimerRef.current);
			debounceTimerRef.current = null;
		}
		pendingSaveRef.current = false;
		pendingItemIdRef.current = null;
		lastSavedMarkdownRef.current = null;
	}, [editingDisabled]);

	useEffect(() => {
		return () => {
			void flushPendingSave("item change");
		};
	}, [currentItem?.id, flushPendingSave]);

	useEffect(() => {
		if (!currentItem) return;

		const { text } = currentItem;
		const markdown = typeof text === "string" ? text : "";

		if (markdown.length > 0 && markdown === lastSavedMarkdownRef.current) {
			contentLoadedRef.current = true;
			return;
		}

		let nextBlocks: unknown[] | null = null;
		if (markdown.length > 0) {
			const withImages = preProcessImageWikilinks(markdown);
			const prepared = legacyBreakToSentinel(withImages);
			const parsed = parseMarkdownToBlocks(prepared, editor.pmSchema);
			nextBlocks = restoreEmptyParagraphs(parsed);
		}
		if (!nextBlocks) {
			nextBlocks = parseMarkdownToBlocks("", editor.pmSchema);
		}

		const currentStr = JSON.stringify(editor.document);
		const nextStr = JSON.stringify(nextBlocks);
		if (currentStr === nextStr) {
			contentLoadedRef.current = true;
			return;
		}

		// eslint-disable-next-line @typescript-eslint/no-explicit-any
		const tiptap =
			(editor as any)._tiptapEditor ?? (editor as any).tiptapEditor;
		const isFocused = tiptap?.isFocused ?? false;

		if (isFocused && pendingSaveRef.current) {
			if (debounceTimerRef.current) {
				clearTimeout(debounceTimerRef.current);
				debounceTimerRef.current = null;
			}
			externalContentRef.current = currentItem;
			setShowConflict(true);
			return;
		}

		const blocksToInsert = (nextBlocks ?? []) as PartialBlock[];
		isProgrammaticUpdateRef.current = true;
		try {
			editor.replaceBlocks(editor.document, blocksToInsert);
		} finally {
			isProgrammaticUpdateRef.current = false;
		}
		contentLoadedRef.current = true;
		setLastBlockContent(new Map());
	}, [currentItem, editor]);

	useEffect(() => {
		const handleMetaDeleteToLineStart = (event: KeyboardEvent) => {
			if (!editor.isEditable) return;
			if (!event.metaKey || (event.key !== "Backspace" && event.key !== "Delete"))
				return;

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const tiptap: any =
				(editor as any)._tiptapEditor ?? (editor as any).tiptapEditor;
			if (!tiptap?.isFocused) return;

			const { state } = tiptap;
			const selection = state.selection;
			if (!selection.empty) return;

			const $from = selection.$from;
			const blockStart = $from.start();
			const cursorPos = selection.from;
			if (cursorPos <= blockStart) return;

			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			const view: any = tiptap.view;
			if (!view) return;

			const caretRect = view.coordsAtPos(cursorPos);
			const targetTop = caretRect.top;
			const blockLeft = view.coordsAtPos(blockStart).left;

			const fromPos = findVisualLineStart(
				view,
				blockStart,
				cursorPos,
				targetTop,
				blockLeft,
				caretRect.left,
			);

			if (cursorPos <= fromPos) {
				const prevHit = view.posAtCoords({
					left: Math.max(blockLeft + 1, caretRect.left),
					top: targetTop - 1,
				});
				if (!prevHit) return;
				const prevPos = Math.max(blockStart, Math.min(cursorPos, prevHit.pos));
				const prevTop = view.coordsAtPos(prevPos).top;
				const prevLineStart = findVisualLineStart(
					view,
					blockStart,
					cursorPos,
					prevTop,
					blockLeft,
					caretRect.left,
				);
				if (prevLineStart < cursorPos) {
					event.preventDefault();
					tiptap.commands.deleteRange({ from: prevLineStart, to: cursorPos });
				}
				return;
			}

			event.preventDefault();
			tiptap.commands.deleteRange({ from: fromPos, to: cursorPos });
		};

		const handleChecklistArrowNavigation = (event: KeyboardEvent) => {
			if (!editor.isEditable) return;
			if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
			if (event.altKey || event.ctrlKey || event.metaKey || event.shiftKey)
				return;

			const ctx = getChecklistNavContext(editor);
			if (!ctx) return;

			const { tiptap, pmSelection, cursorInfo, parentOffset, parentSize, caretRect } =
				ctx;
			const view = tiptap.view;

			if (event.key === "ArrowUp" && parentOffset === 0) {
				event.preventDefault();
				const target = caretRect
					? view.posAtCoords({ left: caretRect.left, top: caretRect.top - 2 })
					: null;
				if (target && target.pos !== pmSelection.from) {
					tiptap.commands.setTextSelection({
						from: target.pos,
						to: target.pos,
					});
					editor.focus();
					return;
				}
				const prevBlock = cursorInfo.prevBlock;
				if (!prevBlock) return;
				editor.setTextCursorPosition(prevBlock.id, "end");
				editor.focus();
			}

			if (event.key === "ArrowDown" && parentOffset === parentSize) {
				event.preventDefault();
				const target = caretRect
					? view.posAtCoords({
						left: caretRect.left,
						top: caretRect.bottom + 2,
					})
					: null;
				if (target && target.pos !== pmSelection.from) {
					tiptap.commands.setTextSelection({
						from: target.pos,
						to: target.pos,
					});
					editor.focus();
					return;
				}
				const nextBlock = cursorInfo.nextBlock;
				if (!nextBlock) return;
				editor.setTextCursorPosition(nextBlock.id, "start");
				editor.focus();
			}
		};

		const handleMetaReturn = (event: KeyboardEvent) => {
			if (!(event.metaKey || event.ctrlKey) || event.key !== "Enter") return;
			const selection = editor.getTextCursorPosition();
			if (!selection) return;
			const currentBlock = editor.getBlock(selection.block);
			if (!currentBlock) return;
			if (currentBlock.type === "checkListItem") {
				event.preventDefault();
				const currentChecked = currentBlock.props?.checked ?? false;
				editor.updateBlock(currentBlock.id, {
					props: { ...currentBlock.props, checked: !currentChecked },
				});
			}
		};

		document.addEventListener("keydown", handleMetaReturn);
		document.addEventListener("keydown", handleMetaDeleteToLineStart);
		document.addEventListener("keydown", handleChecklistArrowNavigation);

		return () => {
			document.removeEventListener("keydown", handleMetaReturn);
			document.removeEventListener("keydown", handleMetaDeleteToLineStart);
			document.removeEventListener("keydown", handleChecklistArrowNavigation);
		};
	}, [editor]);

	useEffect(() => {
		return () => {
			void flushPendingSave("unmount");
		};
	}, [flushPendingSave]);

	const imageContext = useMemo(
		() => ({ notePath: currentItem.id }),
		[currentItem.id],
	);

	return (
		<ImageResolverContext.Provider value={imageContext}>
			<div className="item-body">
				{showConflict && (
					<EditorConflictBanner
						onReload={handleConflictReload}
						onOverwrite={handleConflictOverwrite}
					/>
				)}
				<BlockNoteView
					editor={editor}
					theme={theme}
					editable={!editingDisabled}
					onChange={handleEditorChange}
					onBlur={handleEditorBlur}
				/>
			</div>
		</ImageResolverContext.Provider>
	);
}
